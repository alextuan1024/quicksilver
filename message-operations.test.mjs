import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openMessageStore} from './message-store.mjs';
const identity={projectId:'fixture',ownerAddress:'+15550000001',dm:'any;-;+15550000001',line:'shared',issuer:'https://fixture.example/',clientId:'fixture',subject:'google-oauth2|fixture'};
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'quicksilver-ops-')),path=join(dir,'messages.sqlite');
  let time=1800000000000;const stores=[];
  const open=()=>{const s=openMessageStore({path,identity,now:()=>time});stores.push(s);return s;};
  t.after(()=>{for(const s of stores)s.close();rmSync(dir,{recursive:true,force:true});});
  return {open,path,advance:ms=>time+=ms};
}
function admitted(s,id='incoming'){return s.accept({provider_id:id,text:'private request'}).request_id;}
const answer=(id,final=false)=>({request_id:id,response_id:'response',text:'private reply',final});

test('pause persists and blocks ingress, claim, reply admission and both workers',t=>{
  const {open}=fixture(t);let s=open();const a=admitted(s),b=admitted(s,'second');s.claim(a);
  assert.equal(typeof s.pause,'function');s.pause();
  assert.throws(()=>admitted(s,'third'),{code:'paused'});
  assert.throws(()=>s.claim(b),{code:'paused'});assert.throws(()=>s.enqueueReply(answer(a)),{code:'paused'});
  assert.equal(s.reserveEvent(),undefined);assert.equal(s.reserveReply(),undefined);
  s.close();s=open();s.recover();assert.equal(s.operations().paused,true);
  assert.throws(()=>s.resume(),{code:'owner_verification_required'});
  s.resume({ownerVerified:true});assert.equal(s.claim(b).acquired,true);
});

test('owner resolution can retry verified unstarted work or abandon it without automatic rerun',t=>{
  const {open}=fixture(t);let s=open();const id=admitted(s);s.claim(id);s.close();s=open();s.recover();
  assert.equal(typeof s.resolveRequest,'function');s.pause();
  assert.throws(()=>s.resolveRequest(id,{outcome:'not_started'}),{code:'owner_verification_required'});
  s.resolveRequest(id,{outcome:'not_started',ownerVerified:true});
  assert.equal(s.status(id).execution,'pending');assert.equal(s.reserveEvent(),undefined);
  s.resume({ownerVerified:true});assert.equal(s.claim(id).acquired,true);
  s.enqueueReply(answer(id));const sending=s.reserveReply();s.settleReply(id,sending.response_id,{});s.pause();
  s.resolveRequest(id,{outcome:'abandoned',ownerVerified:true});
  assert.equal(s.status(id).replies[0].state,'cancelled_unknown');
  s.resume({ownerVerified:true});assert.equal(s.reserveReply(),undefined);assert.equal(s.claim(id).acquired,false);
  assert.equal(s.operations().audit.length,2);
});

test('restore quarantine blocks known work until replies and execution are separately reviewed',t=>{
  const {open,advance}=fixture(t);const s=open();const id=admitted(s);s.claim(id);s.enqueueReply(answer(id,true));
  assert.equal(typeof s.markRestored,'function');s.markRestored({backup_id:'fixture-backup',captured_at:1800000000000});
  assert.equal(s.operations().paused,true);assert.equal(s.status(id).restore_hold,true);
  assert.equal(s.status(id).replies[0].state,'unknown_outcome');
  assert.throws(()=>s.resume({ownerVerified:true}),{code:'restore_reconciliation_required'});
  assert.throws(()=>s.completeRestore({ownerVerified:true}),{code:'unreviewed_requests'});
  assert.throws(()=>s.resolveRequest(id,{outcome:'completed',ownerVerified:true}),{code:'unresolved_replies'});
  s.resolveReply(id,'response',{outcome:'sent',provider_id:'provider-result',ownerVerified:true});
  s.resolveRequest(id,{outcome:'completed',ownerVerified:true});advance(1000);
  s.completeRestore({ownerVerified:true,intakeAfter:1800000000000});assert.equal(s.operations().ingest_after,1800000001000);
  assert.equal(s.operations().paused,true);s.resume({ownerVerified:true});assert.equal(s.reserveReply(),undefined);
});

test('v1 migration preserves existing deduplication and replies',t=>{
  const {open,path}=fixture(t);let s=open();const id=admitted(s);s.claim(id);s.enqueueReply(answer(id));s.close();
  const db=new DatabaseSync(path);
  // Recreate the previous on-disk version by removing only the v2 additions.
  const columns=db.prepare('PRAGMA table_info(requests)').all();
  if(columns.some(c=>c.name==='restore_hold'))db.exec('ALTER TABLE requests DROP COLUMN restore_hold');
  db.exec("DROP TABLE IF EXISTS operator_audit; DELETE FROM metadata WHERE key='operations'; PRAGMA user_version=1");db.close();
  s=open();assert.equal(typeof s.operations,'function');assert.equal(s.operations().paused,false);
  assert.equal(admitted(s),id);assert.equal(s.status(id).replies[0].state,'queued');
});

test('new reply IDs on a restored continuing request stay uncertain after the request hold is lifted',t=>{
  const {open}=fixture(t);let s=open();const id=admitted(s);s.claim(id);
  // The snapshot predates a reply that the old deployment may already have sent.
  s.markRestored({backup_id:'older-snapshot',captured_at:1800000000000});
  s.resolveRequest(id,{outcome:'continuing',ownerVerified:true});s.completeRestore({ownerVerified:true,intakeAfter:1800000000000});
  s.resume({ownerVerified:true});s.close();s=open();s.recover();
  const queued=s.enqueueReply(answer(id,true));
  assert.equal(queued.state,'unknown_outcome');assert.equal(s.reserveReply(),undefined);
  assert.equal(s.status(id).state,'stalled');
  assert.equal(s.enqueueReply(answer(id,true)).client_message_id,queued.client_message_id);
  s.resolveReply(id,'response',{outcome:'not_sent',ownerVerified:true});
  assert.equal(s.reserveReply().response_id,'response');
});

test('restore completion requires an explicit verified intake boundary and honors a later old-host clock',t=>{
  const {open}=fixture(t);const s=open();s.markRestored({backup_id:'snapshot',captured_at:1800000000000});
  assert.throws(()=>s.completeRestore({ownerVerified:true}),{code:'verified_boundary_required'});
  s.completeRestore({ownerVerified:true,intakeAfter:1800000060000});
  assert.equal(s.operations().ingest_after,1800000060000);
});
