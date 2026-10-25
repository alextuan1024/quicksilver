import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openMessageStore} from './message-store.mjs';
const backup=await import('./message-backup.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const identity={projectId:'fixture',ownerAddress:'+15550000001',dm:'any;-;+15550000001',line:'shared',issuer:'https://fixture.example/',clientId:'fixture',subject:'google-oauth2|fixture'};
const key=Buffer.alloc(32,13),now=()=>1800000005000;
function fixture(t){
  assert.equal(typeof backup.createMessageBackup,'function');assert.equal(typeof backup.restoreMessageBackup,'function');
  const dir=mkdtempSync(join(tmpdir(),'quicksilver-backup-')),path=join(dir,'source.sqlite'),target=join(dir,'restored.sqlite'),artifact=join(dir,'backup.qsb');
  const stores=[];const open=p=>{const s=openMessageStore({path:p,identity,now});stores.push(s);return s;};
  t.after(()=>{for(const s of stores)s.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,path,target,artifact,open};
}

test('encrypted snapshot restores paused and quarantines even replies that were only queued',t=>{
  const {open,path,target,artifact,dir}=fixture(t);const s=open(path);
  const id=s.accept({provider_id:'incoming',text:'private request text'}).request_id;s.claim(id);
  s.enqueueReply({request_id:id,response_id:'final',text:'private final text',final:true});
  s.putPrivate('subscription','messages',{secret:'private signing secret'});
  assert.throws(()=>backup.createMessageBackup(s,{path:artifact,key,now}),{code:'pause_required'});
  s.pause();backup.createMessageBackup(s,{path:artifact,key,now});
  const encrypted=readFileSync(artifact,'utf8');
  for(const secret of ['private request text','private final text','private signing secret'])assert.equal(encrypted.includes(secret),false);
  assert.equal(statSync(artifact).mode&0o777,0o600);
  // The live database may have advanced after capture; restore must ignore that assumption.
  s.resume({ownerVerified:true});const attempt=s.reserveReply();s.settleReply(id,attempt.response_id,{provider_id:'sent-after-snapshot'});
  backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity,now});
  const restored=open(target);restored.recover();assert.equal(restored.operations().paused,true);
  assert.equal(restored.status(id).replies[0].state,'unknown_outcome');assert.equal(restored.reserveReply(),undefined);
  assert.equal(restored.getPrivate('subscription','messages'),null);
  assert.throws(()=>restored.resume({ownerVerified:true}),{code:'restore_reconciliation_required'});
  assert.equal(readdirSync(dir).some(name=>name.startsWith('.quicksilver-')),false);
});

test('wrong key, tampering, mismatched identity and existing destination never replace a database',t=>{
  const {open,path,target,artifact}=fixture(t);const s=open(path);s.pause();backup.createMessageBackup(s,{path:artifact,key,now});
  assert.throws(()=>backup.restoreMessageBackup({path:artifact,databasePath:target,key:Buffer.alloc(32,14),identity,now}),{code:'invalid_backup'});
  assert.equal(existsSync(target),false);
  const original=readFileSync(artifact);const parsed=JSON.parse(original);parsed.ciphertext=parsed.ciphertext.slice(0,-8)+'AAAAAAAA';writeFileSync(artifact,JSON.stringify(parsed));
  assert.throws(()=>backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity,now}),{code:'invalid_backup'});
  writeFileSync(artifact,original);
  assert.throws(()=>backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity:{...identity,subject:'other'},now}),{code:'database_identity_mismatch'});
  assert.equal(existsSync(target),false);
  assert.throws(()=>backup.restoreMessageBackup({path:artifact,databasePath:path,key,identity,now}),{code:'destination_exists'});
  assert.throws(()=>backup.createMessageBackup(s,{path:artifact,key,now}),{code:'destination_exists'});
  assert.equal(s.operations().paused,true);
});

test('restored pause and quarantine survive process death and are inspectable using the offline CLI',t=>{
  const {open,path,target,artifact,dir}=fixture(t);const s=open(path);
  const id=s.accept({provider_id:'incoming',text:'private request text'}).request_id;s.pause();backup.createMessageBackup(s,{path:artifact,key,now});
  backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity,now});
  const killed=spawnSync(process.execPath,['--input-type=module','-e',`
    import {openMessageStore} from './message-store.mjs';
    const s=openMessageStore({path:process.argv[1],identity:JSON.parse(process.argv[2])});s.recover();
    if(!s.operations().paused || s.reserveEvent())process.exit(2);
    process.kill(process.pid,'SIGKILL');
  `,target,JSON.stringify(identity)],{encoding:'utf8',timeout:5000});
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const cfg=join(dir,'operator.json');writeFileSync(cfg,JSON.stringify({databasePath:target,identity}));
  const cli=spawnSync(process.execPath,['message-admin.mjs',cfg,'status'],{encoding:'utf8',timeout:5000});
  assert.equal(cli.status,0,cli.stderr);const status=JSON.parse(cli.stdout);
  assert.equal(status.operations.paused,true);assert.equal(status.requests[0].request_id,id);
  assert.equal(status.requests[0].restore_hold,true);assert.equal(cli.stdout.includes('private request text'),false);
  const forbidden=spawnSync(process.execPath,['message-admin.mjs',cfg,'resume','--owner-verified'],{encoding:'utf8',timeout:5000});
  assert.equal(forbidden.status,1);assert.equal(JSON.parse(forbidden.stderr.split('\n').find(line=>line.startsWith('{'))).error,'restore_reconciliation_required');
});


test('offline inspection rejects a missing database instead of creating a fresh unpaused store',t=>{
  const {target,dir}=fixture(t);const cfg=join(dir,'operator.json');writeFileSync(cfg,JSON.stringify({databasePath:target,identity}));
  const result=spawnSync(process.execPath,['message-admin.mjs',cfg,'status'],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.equal(existsSync(target),false);
  const error=JSON.parse(result.stderr.split('\n').find(line=>line.startsWith('{')));
  assert.equal(error.error,'database_missing');
});

test('a reply sent only after snapshot cannot resend when restored Athena retries its missing response ID',t=>{
  const {open,path,target,artifact}=fixture(t);const source=open(path);
  const id=source.accept({provider_id:'incoming',text:'One action only.'}).request_id;source.claim(id);
  source.pause();backup.createMessageBackup(source,{path:artifact,key,now});
  source.resume({ownerVerified:true});
  const response={request_id:id,response_id:'missing-progress',text:'Progress happened.',final:false};
  source.enqueueReply(response);source.reserveReply();source.settleReply(id,response.response_id,{provider_id:'already-sent'});
  backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity,now});
  const restored=open(target);restored.resolveRequest(id,{outcome:'continuing',ownerVerified:true});
  restored.completeRestore({ownerVerified:true,intakeAfter:now()});restored.resume({ownerVerified:true});
  assert.equal(restored.enqueueReply(response).state,'unknown_outcome');
  assert.equal(restored.reserveReply(),undefined);assert.equal(restored.status(id).restored_origin,true);
});

test('offline restore completion requires an explicit UTC boundary and still needs a separate resume',t=>{
  const {open,path,target,artifact,dir}=fixture(t);const s=open(path);s.pause();
  backup.createMessageBackup(s,{path:artifact,key});backup.restoreMessageBackup({path:artifact,databasePath:target,key,identity});
  const cfg=join(dir,'operator.json');writeFileSync(cfg,JSON.stringify({databasePath:target,identity}));
  const command=(...args)=>spawnSync(process.execPath,['message-admin.mjs',cfg,...args],{encoding:'utf8',timeout:5000});
  const invalid=command('complete-restore','2027-01-01T00:00:00','--owner-verified');
  assert.equal(invalid.status,1);
  assert.equal(JSON.parse(invalid.stderr.split('\n').find(line=>line.startsWith('{'))).error,'verified_boundary_required');
  const bound=new Date(Date.now()+60000).toISOString();
  const complete=command('complete-restore',bound,'--owner-verified');
  assert.equal(complete.status,0,complete.stderr);const status=JSON.parse(complete.stdout);
  assert.equal(status.operations.restore_required,false);assert.equal(status.operations.paused,true);
  assert.equal(status.operations.ingest_after,Date.parse(bound));
  const resumed=command('resume','--owner-verified');assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).operations.paused,false);
});
