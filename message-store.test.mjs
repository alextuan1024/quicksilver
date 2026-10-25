import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';

const module = await import('./message-store.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const identity = {projectId:'fixture-project',ownerAddress:'+15550000001',dm:'any;-;+15550000001',
  line:'shared',issuer:'https://issuer.example/',clientId:'fixture-client',subject:'google-oauth2|owner'};
function setup(t) {
  assert.equal(typeof module.openMessageStore, 'function', 'durable message store must be implemented');
  const dir = mkdtempSync(join(tmpdir(), 'quicksilver-store-'));
  const path = join(dir, 'messages.sqlite');
  let time = 1800000000000;
  const handles = [];
  const open = (changes={}) => {
    const store = module.openMessageStore({path,identity,now:()=>time,...changes});
    handles.push(store); return store;
  };
  t.after(()=>{for(const store of handles)store.close();rmSync(dir,{recursive:true,force:true});});
  return {path,open,advance:ms=>time+=ms};
}
const inbound = (id='incoming-1') => ({provider_id:id,text:'Please check my calendar.',checkpoint:'opaque-cursor-9'});
const response = (request_id, response_id='answer-1', final=true) => ({request_id,response_id,text:'Here is the result.',final});

test('inbound, checkpoint and event survive reopen and duplicate delivery creates no new work', t=>{
  const {open,path}=setup(t);let store=open();
  const first=store.accept(inbound());
  const event=store.reserveEvent();
  assert.equal(event.request_id,first.request_id);
  assert.equal(event.attempts,1);
  assert.equal(store.checkpoint(first.request_id),'opaque-cursor-9');
  store.close();store=open();store.recover();
  assert.deepEqual(store.accept(inbound()),{request_id:first.request_id,duplicate:true});
  const retried=store.reserveEvent();
  assert.equal(retried.id,event.id);assert.equal(retried.created_at,event.created_at);
  assert.equal(store.listRequests().length,1);
  assert.equal(statSync(path).mode & 0o777,0o600);
});

test('outbox failure rolls back inbound and checkpoint atomically', t=>{
  const {open,path}=setup(t);let store=open();store.close();
  let db=new DatabaseSync(path);
  db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  db.close();store=open();
  assert.throws(()=>store.accept(inbound()));
  assert.deepEqual(store.listRequests(),[]);
  store.close();db=new DatabaseSync(path);db.exec('DROP TRIGGER reject_event');db.close();
  store=open();assert.equal(store.accept(inbound()).duplicate,false);
});

test('claims are atomic and independent of acknowledgment, duplicates never expose work again', async t=>{
  const {open}=setup(t);const store=open();const {request_id}=store.accept(inbound());
  const event=store.reserveEvent();
  const claims=await Promise.all([Promise.resolve().then(()=>store.claim(request_id)),Promise.resolve().then(()=>store.claim(request_id))]);
  assert.equal(claims.filter(c=>c.acquired).length,1);
  assert.equal(claims.find(c=>c.acquired).text,'Please check my calendar.');
  assert.equal(Object.hasOwn(claims.find(c=>!c.acquired),'text'),false);
  store.settleEvent(event.id,true);
  assert.equal(store.status(request_id).execution,'claimed');
  assert.equal(store.status(request_id).event,'acknowledged');
  store.close();const restarted=open();restarted.recover();
  assert.equal(restarted.claim(request_id).acquired,false);
  assert.equal(restarted.status(request_id).reason,'processing_interrupted');
  // A result from the original Athena work can still arrive after a server restart.
  assert.equal(restarted.enqueueReply(response(request_id)).state,'queued');
});

test('final closure is atomic, IDs reject changed content, and sends preserve progress order', t=>{
  const {open}=setup(t);const store=open();const {request_id}=store.accept(inbound());
  assert.throws(()=>store.enqueueReply(response(request_id)),{code:'request_not_claimed'});
  store.claim(request_id);
  const progress=response(request_id,'progress-1',false);
  store.enqueueReply(progress);store.enqueueReply(response(request_id));
  assert.equal(store.status(request_id).closed,true);
  assert.equal(store.enqueueReply(response(request_id)).state,'queued');
  assert.throws(()=>store.enqueueReply({...progress,text:'Changed text'}),{code:'response_conflict'});
  assert.throws(()=>store.enqueueReply(response(request_id,'late-progress',false)),{code:'request_closed'});
  const first=store.reserveReply();
  assert.equal(first.response_id,'progress-1');assert.equal(first.state,'send_attempted');
  assert.equal(store.reserveReply(),undefined);
  store.settleReply(first.request_id,first.response_id,{provider_id:'outgoing-progress'});
  assert.equal(store.reserveReply().response_id,'answer-1');
});

test('crash after send reservation becomes unknown and blocks later replies without resending', t=>{
  const {open}=setup(t);let store=open();const {request_id}=store.accept(inbound());store.claim(request_id);
  store.enqueueReply(response(request_id,'progress',false));store.enqueueReply(response(request_id));
  const attempt=store.reserveReply();store.close();store=open();store.recover();
  assert.equal(store.status(request_id).replies[0].state,'unknown_outcome');
  assert.equal(store.status(request_id).state,'stalled');
  assert.equal(store.reserveReply(),undefined);
  assert.equal(store.enqueueReply(response(request_id,'progress',false)).client_message_id,attempt.client_message_id);
  assert.throws(()=>store.resolveReply(request_id,'progress',{outcome:'not_sent'}),{code:'owner_verification_required'});
  store.resolveReply(request_id,'progress',{outcome:'not_sent',ownerVerified:true});
  const retry=store.reserveReply();
  assert.equal(retry.client_message_id,attempt.client_message_id);
  assert.equal(retry.attempts,2);
});

test('uncertain send in one request does not block a different request', t=>{
  const {open}=setup(t);const store=open();
  const a=store.accept(inbound('a')).request_id,b=store.accept(inbound('b')).request_id;
  store.claim(a);store.claim(b);store.enqueueReply(response(a));store.enqueueReply(response(b));
  const first=store.reserveReply();store.settleReply(first.request_id,first.response_id,{});
  assert.equal(store.reserveReply().request_id,b);
});

test('bounded event retries stall visibly without rolling back an existing claim', t=>{
  const {open,advance}=setup(t);const store=open();const {request_id}=store.accept(inbound());
  for(let i=0;i<5;i++){
    const event=store.reserveEvent();assert.ok(event);store.settleEvent(event.id,false);
    if(i===0)assert.equal(store.reserveEvent(),undefined);
    advance(60000);
  }
  assert.equal(store.reserveEvent(),undefined);
  assert.equal(store.status(request_id).state,'stalled');
  assert.equal(store.claim(request_id).acquired,true);
  assert.equal(store.status(request_id).execution,'claimed');
});

test('database rejects a changed owner, OAuth client or route and preserves private records', t=>{
  const {open}=setup(t);const store=open();
  store.putPrivate('subscription','messages',{secret:'fixture-only',expires:1800000001000});
  store.close();
  for(const change of [{subject:'google-oauth2|other'},{clientId:'other-client'},{dm:'another-dm'}]){
    assert.throws(()=>open({identity:{...identity,...change}}),{code:'database_identity_mismatch'});
  }
  const next=open();assert.equal(next.getPrivate('subscription','messages').secret,'fixture-only');
  next.deletePrivate('subscription','messages');assert.equal(next.getPrivate('subscription','messages'),null);
});


test('a second process cannot open an active database or recover another worker attempts', t=>{
  const {open,path}=setup(t);open();
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {openMessageStore} from './message-store.mjs';
    try {openMessageStore({path:process.argv[1],identity:JSON.parse(process.argv[2])});process.exit(1);}
    catch(error){if(error.code!=='database_in_use')throw error;}
  `,path,JSON.stringify(identity)],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
});

test('SIGKILL after send reservation preserves an unknown outcome across process restart', t=>{
  const {open,path}=setup(t);let store=open();const {request_id}=store.accept(inbound());
  store.claim(request_id);store.enqueueReply(response(request_id));store.close();
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import {openMessageStore} from './message-store.mjs';
    const store=openMessageStore({path:process.argv[1],identity:JSON.parse(process.argv[2])});
    if(!store.reserveReply())process.exit(1);
    process.kill(process.pid,'SIGKILL');
  `,path,JSON.stringify(identity)],{encoding:'utf8',timeout:5000});
  assert.equal(result.signal,'SIGKILL',result.stderr);
  store=open();store.recover();
  assert.equal(store.status(request_id).replies[0].state,'unknown_outcome');
  assert.equal(store.reserveReply(),undefined);
});

for(const resolution of ['lookup','owner-sent','owner-not-sent']) {
  test(`resolving an uncertain progress send preserves interrupted execution (${resolution})`,t=>{
    const {open}=setup(t);let store=open();const {request_id}=store.accept(inbound());
    store.claim(request_id);store.enqueueReply(response(request_id,'progress',false));
    const attempt=store.reserveReply();store.close();store=open();store.recover();
    if(resolution==='lookup')store.reconcileReply(request_id,'progress',{
      client_message_id:attempt.client_message_id,provider_id:'verified-progress'});
    else store.resolveReply(request_id,'progress',{ownerVerified:true,
      outcome:resolution==='owner-sent'?'sent':'not_sent',provider_id:'verified-progress'});
    assert.equal(store.status(request_id).state,'stalled');
    assert.equal(store.status(request_id).reason,'processing_interrupted');
    assert.equal(store.claim(request_id).acquired,false);
    // Only a new response from the original work establishes that it continued.
    store.enqueueReply(response(request_id));
    assert.equal(store.status(request_id).execution,'completed');
    assert.equal(store.status(request_id).reason,null);
  });
}
