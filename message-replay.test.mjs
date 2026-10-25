import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openMessageStore} from './message-store.mjs';
const identity={projectId:'project',line:'shared',dm:'owner-dm',ownerAddress:'owner',issuer:'issuer',clientId:'client',subject:'subject'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'replay-'));let store;
 const open=()=>store=openMessageStore({path:join(dir,'messages.sqlite'),identity,now:()=>1800000000000});
 t.after(()=>{store?.close();rmSync(dir,{recursive:true,force:true});});return {open,store:open()};}
const add=(s,id)=>s.accept({provider_id:id,text:'fixture text'});
const target={id:'sub',url:'https://callback.example/messages',secret:'fixture',expires:1800000010000};

test('cursor refresh replays retained events after restart without reacquiring claims',t=>{
 const f=fixture(t),s=f.store;assert.equal(typeof s.replay,'object');
 const zero=s.replay.cursor();const {request_id}=add(s,'one');const event=s.reserveEvent();
 assert.equal(s.claim(request_id).acquired,true);s.settleEvent(event.id,true,event.generation);
 const acknowledged=s.replay.cursor();assert.notEqual(acknowledged,zero);s.close();
 const again=f.open();assert.equal(again.replay.cursor(),acknowledged);
 const result=again.replay.subscribe(target,zero);assert.equal(result.truncated,false);
 assert.equal(result.cursor,zero);const repeated=again.reserveEvent();assert.equal(repeated.id,event.id);
 assert.equal(again.claim(request_id).acquired,false);
});

test('a later acknowledgment never advances the cursor over an earlier pending hole',t=>{
 const {store:s}=fixture(t);assert.equal(typeof s.replay,'object');const zero=s.replay.cursor();
 add(s,'one');add(s,'two');const one=s.reserveEvent(),two=s.reserveEvent();
 s.settleEvent(two.id,true,two.generation);assert.equal(s.replay.cursor(),zero);
 s.settleEvent(one.id,false,one.generation);assert.equal(s.replay.cursor(),zero);
 s.replay.subscribe(target,zero);const again=s.reserveEvent();assert.equal(again.id,one.id);
});

test('old callback completion cannot erase replay scheduled by subscription refresh',t=>{
 const {store:s}=fixture(t);assert.equal(typeof s.replay,'object');const zero=s.replay.cursor();add(s,'one');
 const stale=s.reserveEvent();s.replay.subscribe(target,zero);s.settleEvent(stale.id,true,stale.generation);
 const current=s.reserveEvent();assert.equal(current.id,stale.id);assert.notEqual(current.generation,stale.generation);
});

test('malformed or forged cursors fail without replacing the subscription',t=>{
 const {store:s}=fixture(t);assert.equal(typeof s.replay,'object');const zero=s.replay.cursor();
 s.replay.subscribe(target,null);
 for(const cursor of ['',{},'r1.invalid.900.invalid',zero.replace(zero.split('.')[1],'------------------------------------'),zero.replace(zero.split('.')[1],'00000000-0000-4000-8000-000000000000'),zero.slice(0,-1)+(zero.endsWith('a')?'b':'a')])
  assert.throws(()=>s.replay.subscribe({...target,url:'https://other.example/'},cursor),{code:'invalid_cursor'});
 assert.equal(s.getPrivate('subscription','photon.message.received').url,target.url);
});

test('restore invalidates old cursors and does not replay quarantined requests',t=>{
 const {store:s}=fixture(t);assert.equal(typeof s.replay,'object');const old=s.replay.cursor(),epoch=s.replay.epoch();
 add(s,'one');s.markRestored({backup_id:'snapshot',captured_at:1800000000000});
 assert.notEqual(s.replay.epoch(),epoch);
 const result=s.replay.subscribe(target,old);assert.equal(result.truncated,true);
 assert.equal(s.reserveEvent(),undefined);assert.equal(s.operations().restore_required,true);
});

test('operator approved redispatch moves after prior cursors and has a fresh event id',t=>{
 const {store:s}=fixture(t);assert.equal(typeof s.replay,'object');const {request_id}=add(s,'one');
 const original=s.reserveEvent();s.settleEvent(original.id,true,original.generation);const prior=s.replay.cursor();
 s.pause();s.resolveRequest(request_id,{outcome:'not_started',ownerVerified:true});s.resume({ownerVerified:true});
 s.replay.subscribe(target,prior);const next=s.reserveEvent();assert.ok(next.seq>original.seq);assert.notEqual(next.id,original.id);
});


test('process death after claim and callback reservation replays the same event without new work',t=>{
 const dir=mkdtempSync(join(tmpdir(),'replay-crash-')),path=join(dir,'messages.sqlite');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {openMessageStore} from './message-store.mjs';
  import {writeFileSync} from 'node:fs';
  const store=openMessageStore({path:process.argv[1],identity:JSON.parse(process.argv[2])});
  const cursor=store.replay.cursor();const request=store.accept({provider_id:'crash-message',text:'one action'});
  const event=store.reserveEvent();store.claim(request.request_id);
  writeFileSync(process.argv[3],JSON.stringify({cursor,request,event}));
  process.kill(process.pid,'SIGKILL');
 `,path,JSON.stringify(identity),join(dir,'evidence.json')],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL');const prior=JSON.parse(readFileSync(join(dir,'evidence.json'),'utf8'));
 const s=openMessageStore({path,identity});t.after(()=>s.close());s.recover();
 s.replay.subscribe(target,prior.cursor);const repeated=s.reserveEvent();
 assert.equal(repeated.id,prior.event.id);assert.equal(repeated.cursor,prior.cursor);
 assert.equal(s.accept({provider_id:'crash-message',text:'one action'}).duplicate,true);
 assert.equal(s.claim(prior.request.request_id).acquired,false);
});
