import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPhotonRecoveryStore} from './photon-recovery-store.mjs';
const module=await import('./photon-recovery.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const route={projectId:'fixture',ownerAddress:'+15550000001',dm:'any;-;+15550000001',line:'shared'};
const identity={...route,issuer:'https://issuer.example/',clientId:'client',subject:'owner'};
const contract={version:1,verified:true,scope:'owner-text-dm',sequence:'contiguous-owner-text',route};
const native=(sequence,guid=`message-${sequence}`,text=`text ${sequence}`)=>({sequence,type:'message.received',isFromMe:false,chatGuid:route.dm,message:{guid,isFromMe:false,chatGuids:[route.dm],sender:{address:route.ownerAddress,service:'iMessage'},itemType:'normal',dateCreated:new Date(1700000000000),content:{text,attachments:[]}}});
function queue(){let pending=[],values=[],ended=false;return {
 push(v){if(ended)return;const p=pending.shift();p?p({value:v,done:false}):values.push(v);},
 close(){ended=true;for(const p of pending)p({done:true});pending=[];},
 [Symbol.asyncIterator](){return this;},next(){if(values.length)return Promise.resolve({value:values.shift(),done:false});if(ended)return Promise.resolve({done:true});return new Promise(r=>pending.push(r));}
};}
async function until(check){const deadline=Date.now()+2000;while(!check()){if(Date.now()>deadline)assert.fail('condition timed out');await new Promise(r=>setTimeout(r,3));}}
function fixture(t,{receive,open,changes={},lifetime=60000}={}){
 assert.equal(typeof module.createPhotonRecovery,'function','recovery controller must exist');
 const dir=mkdtempSync(join(tmpdir(),'photon-recovery-')),store=openPhotonRecoveryStore({path:join(dir,'recovery.sqlite'),identity,messageStoreId:'epoch-1'});
 const sessions=[],received=[],opens=[];let active=true;
 const adapter={contract,async open(args){opens.push(args);if(open)return open(args);const live=queue(),history=queue();const s={live,history,expiresAt:Date.now()+lifetime,closed:false,catchUp({after}){assert.equal(after,args.after);s.catchupStarted=true;return history;},close(){s.closed=true;live.close();history.close();}};sessions.push(s);return s;}};
 const controller=module.createPhotonRecovery({route,store,adapter,receive:receive??(e=>{received.push(e.message.guid);return {accepted:true};}),isActive:()=>active,expiresAt:Date.now()+60000,operationTimeoutMs:500,activityPollMs:10,retryDelaysMs:[5,10],...changes});
 t.after(async()=>{await controller.stop();store.close();rmSync(dir,{recursive:true,force:true});});return {controller,store,sessions,received,opens,adapter,setActive:v=>active=v};
}
test('live/catch-up overlap commits in sequence once and never trusts completion head as checkpoint',async t=>{
 const f=fixture(t);f.controller.start();await until(()=>f.sessions[0]?.catchupStarted);const s=f.sessions[0];
 s.live.push(native(2));s.history.push(native(1));s.history.push(native(2));s.history.push({type:'catchup.complete',headSequence:2,truncated:false});
 await until(()=>f.controller.status().state==='listening');assert.deepEqual(f.received,['message-1','message-2']);assert.equal(f.store.checkpoint(),2);
 s.live.push(native(3));await until(()=>f.store.checkpoint()===3);s.live.push(native(2));await new Promise(r=>setTimeout(r,10));assert.equal(f.received.length,3);
});
test('missing history and truncation stall without skipping a sequence',async t=>{
 for(const truncated of [false,true]){const f=fixture(t);f.controller.start();await until(()=>f.sessions.length);const s=f.sessions[0];
  s.history.push(native(2));s.history.push({type:'catchup.complete',headSequence:2,truncated});await until(()=>f.controller.status().state==='stalled');assert.equal(f.store.checkpoint(),0);assert.deepEqual(f.received,[]);
 }
});
test('rejected ingestion and persistence errors never advance a checkpoint',async t=>{
 for(const receive of [()=>({accepted:false,reason:'paused'}),()=>{throw Error('private storage detail');}]){
  const f=fixture(t,{receive});f.controller.start();await until(()=>f.sessions.length);f.sessions[0].history.push(native(1));await until(()=>f.controller.status().state==='stalled');assert.equal(f.store.checkpoint(),0);assert.equal(JSON.stringify(f.controller.status()).includes('private storage'),false);
 }
});
test('owner mismatch, conflicting duplicate and buffer overflow stop before unsafe ingestion',async t=>{
 const cases=[{bad:()=>({...native(1),chatGuid:'unrelated'}),reason:'recovery_owner_rejected'},
 {bad:()=>native(1,'different'),reason:'recovery_sequence_conflict',first:true},
 {bad:()=>native(4),reason:'recovery_buffer_full',buffer:true}];
 for(const c of cases){const f=fixture(t,{changes:{maxBuffered:1}});f.controller.start();await until(()=>f.sessions.length);const s=f.sessions[0];
 if(c.first){s.history.push(native(1));await until(()=>f.store.checkpoint()===1);}if(c.buffer)s.history.push(native(3));s.history.push(c.bad());
 await until(()=>f.controller.status().state==='stalled');assert.equal(f.controller.status().reason,c.reason);assert.equal(f.store.checkpoint(),c.first?1:0);
 }
});
test('disconnect reconnects from last committed sequence without repeating receipt',async t=>{
 const f=fixture(t);f.controller.start();await until(()=>f.sessions.length);let s=f.sessions[0];s.history.push(native(1));s.history.push({type:'catchup.complete',headSequence:1,truncated:false});await until(()=>f.store.checkpoint()===1);s.live.close();
 await until(()=>f.sessions.length===2);s=f.sessions[1];assert.equal(f.opens[1].after,1);s.history.push(native(1));s.history.push(native(2));s.history.push({type:'catchup.complete',headSequence:2,truncated:false});await until(()=>f.store.checkpoint()===2);assert.deepEqual(f.received,['message-1','message-2']);
});
test('session expiry renews credentials through a fresh session and fences retired streams',async t=>{
 const f=fixture(t,{lifetime:100});f.controller.start();await until(()=>f.sessions.length);const old=f.sessions[0];old.history.push({type:'catchup.complete',headSequence:0,truncated:false});await until(()=>f.sessions.length===2);assert.equal(old.closed,true);old.live.push(native(1));assert.equal(f.store.checkpoint(),0);
});
test('pause and explicit stop abort sessions and late authentication cannot reopen intake',async t=>{
 const f=fixture(t);f.controller.start();await until(()=>f.sessions.length);f.setActive(false);await until(()=>f.controller.status().state==='paused');assert.equal(f.sessions[0].closed,true);f.sessions[0].live.push(native(1));assert.equal(f.store.checkpoint(),0);
 let resolve,closed=false;const g=fixture(t,{open:()=>new Promise(r=>resolve=r)});g.controller.start();await until(()=>resolve);await g.controller.stop();resolve({close(){closed=true;}});await until(()=>closed);assert.equal(g.controller.status().state,'stopped');
});
test('unverified/raw SDK contract is rejected before opening any connection',t=>{
 assert.equal(typeof module.createPhotonRecovery,'function','recovery controller must exist');let opened=false;
 assert.throws(()=>module.createPhotonRecovery({route,store:{identity},adapter:{contract:{...contract,scope:'line'},open(){opened=true;}},receive:()=>{},isActive:()=>true,expiresAt:Date.now()+1000}),/scoped_adapter_required/);assert.equal(opened,false);
});
test('repeated failed acquisition is bounded and reports only a fixed category',async t=>{
 const f=fixture(t,{open:async()=>{throw Error('secret upstream content');}});f.controller.start();await until(()=>f.controller.status().state==='stalled');assert.equal(f.opens.length,3);assert.equal(f.controller.status().reason,'recovery_retries_exhausted');assert.equal(JSON.stringify(f.controller.status()).includes('secret'),false);
});

test('activation expiry and stalled authentication stop without admitting a late event',async t=>{
 const f=fixture(t,{changes:{expiresAt:Date.now()+40}});f.controller.start();await until(()=>f.sessions.length);f.sessions[0].history.push({type:'catchup.complete',headSequence:0,truncated:false});
 await until(()=>f.controller.status().state==='expired');assert.equal(f.sessions[0].closed,true);assert.equal(f.store.checkpoint(),0);
 const g=fixture(t,{open:()=>new Promise(()=>{}),changes:{operationTimeoutMs:15,retryDelaysMs:[2]}});g.controller.start();await until(()=>g.controller.status().state==='stalled');assert.equal(g.opens.length,2);assert.equal(g.controller.status().reason,'recovery_retries_exhausted');
});

test('asynchronous ingestion is rejected because checkpoint cannot precede durable commit',async t=>{
 const f=fixture(t,{receive:async()=>({accepted:true})});f.controller.start();await until(()=>f.sessions.length);f.sessions[0].history.push(native(1));await until(()=>f.controller.status().state==='stalled');assert.equal(f.store.checkpoint(),0);
});

test('process death after message commit but before checkpoint cannot repeat a claim or uncertain send',async t=>{
 const {spawnSync}=await import('node:child_process');
 const {openMessageStore}=await import('./message-store.mjs');
 const {readFileSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'photon-crash-')),messagePath=join(dir,'messages.sqlite'),checkpointPath=join(dir,'recovery.sqlite'),effectPath=join(dir,'effect');
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const child=`
 import {openMessageStore} from './message-store.mjs';
 import {openPhotonRecoveryStore} from './photon-recovery-store.mjs';
 import {createPhotonRecovery} from './photon-recovery.mjs';
 import {writeFileSync} from 'node:fs';
 const identity=${JSON.stringify(identity)},route=${JSON.stringify(route)},contract=${JSON.stringify(contract)};
 const message=openMessageStore({path:${JSON.stringify(messagePath)},identity});
 const store=openPhotonRecoveryStore({path:${JSON.stringify(checkpointPath)},identity,messageStoreId:'crash-fixture'});
 const event=${JSON.stringify(native(1))};event.message.dateCreated=new Date(event.message.dateCreated);
 const controller=createPhotonRecovery({route,store,expiresAt:Date.now()+5000,isActive:()=>true,
 receive(e){const admitted=message.accept({provider_id:e.message.guid,text:e.message.content.text,checkpoint:'1'});
 const claimed=message.claim(admitted.request_id);if(claimed.acquired)writeFileSync(${JSON.stringify(effectPath)},'external action once');
 message.enqueueReply({request_id:admitted.request_id,response_id:'answer',text:'answer',final:true});message.reserveReply();
 process.kill(process.pid,'SIGKILL');return {accepted:true};},
 adapter:{contract,async open(){return {expiresAt:Date.now()+5000,live:{[Symbol.asyncIterator](){return this;},next(){return new Promise(()=>{});}},
 async *catchUp(){yield event;yield {type:'catchup.complete',headSequence:1,truncated:false};},close(){}};}}});controller.start();
 `;
 const childResult=spawnSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),timeout:10000,encoding:'utf8'});assert.equal(childResult.signal,'SIGKILL',childResult.stderr);
 const message=openMessageStore({path:messagePath,identity});message.recover();
 const store=openPhotonRecoveryStore({path:checkpointPath,identity,messageStoreId:'crash-fixture'});
 assert.equal(store.checkpoint(),0);const original=message.listRequests()[0];assert.equal(message.status(original.request_id).replies[0].state,'unknown_outcome');
 const live=queue();const controller=module.createPhotonRecovery({route,store,isActive:()=>true,expiresAt:Date.now()+5000,
 receive(e){const admitted=message.accept({provider_id:e.message.guid,text:e.message.content.text,checkpoint:'1'});
  assert.equal(admitted.duplicate,true);assert.equal(message.claim(admitted.request_id).acquired,false);return {accepted:true};},
 adapter:{contract,async open(){return {expiresAt:Date.now()+5000,live,async *catchUp(){yield native(1);yield {type:'catchup.complete',headSequence:1,truncated:false};},close(){live.close();}};}}});
 try{controller.start();await until(()=>store.checkpoint()===1);assert.equal(message.listRequests().length,1);assert.equal(message.reserveReply(),undefined);assert.equal(readFileSync(effectPath,'utf8'),'external action once');}
 finally{await controller.stop();store.close();message.close();}
});

test('expired session cannot ingest before its renewal timer runs',async t=>{
 let time=Date.now();const f=fixture(t,{lifetime:100,changes:{now:()=>time}});f.controller.start();await until(()=>f.sessions.length);
 time=f.sessions[0].expiresAt;f.sessions[0].history.push(native(1));await until(()=>f.controller.status().state==='stalled');assert.equal(f.store.checkpoint(),0);assert.deepEqual(f.received,[]);
});

test('rejected asynchronous ingestion does not surface an unhandled application error',async t=>{
 const f=fixture(t,{receive:async()=>{throw Error('private asynchronous failure');}});f.controller.start();await until(()=>f.sessions.length);f.sessions[0].history.push(native(1));await until(()=>f.controller.status().state==='stalled');assert.equal(f.store.checkpoint(),0);
});

test('live iterator is armed before catch-up begins',async t=>{
 let liveStarted=false,correctOrder=false;
 const live={ [Symbol.asyncIterator](){return this;},next(){liveStarted=true;return new Promise(()=>{});} };
 const f=fixture(t,{open:async()=>({expiresAt:Date.now()+5000,live,
   catchUp(){correctOrder=liveStarted;return (async function*(){yield {type:'catchup.complete',headSequence:0,truncated:false};})();},close(){}})});
 f.controller.start();await until(()=>f.controller.status().state==='listening');assert.equal(correctOrder,true);
});


test('stopping during backoff clears the retry timer so the process can exit',async()=>{
 const {spawnSync}=await import('node:child_process');
 const child=`import {createPhotonRecovery} from './photon-recovery.mjs';
 const route=${JSON.stringify(route)},identity=${JSON.stringify(identity)},contract=${JSON.stringify(contract)};
 const controller=createPhotonRecovery({route,store:{identity,checkpoint:()=>0},adapter:{contract,open(){throw Error('offline');}},receive:()=>({accepted:true}),isActive:()=>true,expiresAt:Date.now()+5000,retryDelaysMs:[1500]});
 controller.start();setTimeout(async()=>{await controller.stop();process.stdout.write('stopped');},20);`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),encoding:'utf8',timeout:1000});
 assert.equal(result.stdout,'stopped');assert.equal(result.status,0,String(result.error));
});

test('heartbeats cannot keep a missing live sequence hidden indefinitely',async t=>{
 const f=fixture(t,{changes:{operationTimeoutMs:30,gapTimeoutMs:50}});f.controller.start();await until(()=>f.sessions.length);
 const s=f.sessions[0];s.history.push({type:'catchup.complete',headSequence:0,truncated:false});await until(()=>f.controller.status().state==='listening');s.live.push(native(2));
 const timer=setInterval(()=>s.live.push({type:'heartbeat'}),5);t.after(()=>clearInterval(timer));
 await until(()=>f.controller.status().state==='stalled');assert.equal(f.controller.status().reason,'recovery_sequence_gap_timeout');assert.equal(f.store.checkpoint(),0);assert.deepEqual(f.received,[]);
});
