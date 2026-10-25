import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('./photon-live-controller.mjs').catch(()=>({}));
const route={projectId:'fixture',line:'shared',ownerAddress:'+15550000001',dm:'any;-;+15550000001'};
const event=(guid='one',sequence=900)=>({type:'message.received',sequence,chatGuid:route.dm,isFromMe:false,message:{guid,chatGuids:[route.dm],sender:{address:route.ownerAddress,service:'iMessage'},dateCreated:new Date(),isFromMe:false,itemType:'normal',content:{text:'fixture request',attachments:[]}}});
const wait=async check=>{for(let n=0;n<400;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');};
function source(){let pending,queue=[],ended=false;return {push(v){if(pending){const p=pending;pending=null;p({value:v,done:false});}else queue.push(v);},close(){ended=true;pending?.({done:true});pending=null;},[Symbol.asyncIterator](){return this;},next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(ended)return Promise.resolve({done:true});return new Promise(r=>pending=r);}};}
function setup(t,options={}){assert.equal(typeof module.createPhotonLiveController,'function');const sessions=[],received=[],sends=[];let active=true;
 const adapter={open:async args=>{if(options.open)return options.open(args);const live=source();const s={live,expiresAt:Date.now()+10000,sendText:async(...a)=>{sends.push(a);return {guid:'sent'};},close:async()=>live.close()};sessions.push(s);return s;}};
 const c=module.createPhotonLiveController({route,adapter,receive:e=>{received.push(e);return {accepted:true};},isActive:()=>active,expiresAt:Date.now()+30000,retryDelaysMs:[5,5],operationTimeoutMs:50,activityPollMs:5,idleTimeoutMs:500,...options});
 t.after(()=>c.stop());return {c,sessions,received,sends,pause:()=>active=false};}

test('live-only intake accepts sequence gaps, filters unrelated/unsupported frames and never requests history',async t=>{
 const f=setup(t);f.c.start();await wait(()=>f.sessions.length===1);
 const other=event('other');other.chatGuid='other';f.sessions[0].live.push(other);
 f.sessions[0].live.push(event('one',900));f.sessions[0].live.push(event('two',980));
 await wait(()=>f.received.length===2);assert.deepEqual(f.received.map(e=>e.message.guid),['one','two']);
 assert.equal(f.c.status().state,'listening');assert.equal(f.c.provider.ready(),true);
 f.sessions[0].live.close();await wait(()=>f.sessions.length===2);
 f.sessions[1].live.push(event('three',1900));await wait(()=>f.received.length===3);
});
test('pause fences intake/sends and closes the active generation',async t=>{
 const f=setup(t);f.c.start();await wait(()=>f.sessions.length===1);f.pause();
 f.sessions[0].live.push(event());await wait(()=>f.c.status().state==='paused');
 assert.equal(f.received.length,0);assert.equal(f.c.provider.ready(),false);
 await assert.rejects(f.c.provider.messages.sendText(route.dm,'reply',{}),/photon_inactive/);assert.equal(f.sends.length,0);
});
test('authentication failure stalls once and status never includes credential error text',async t=>{
 let opens=0;const f=setup(t,{open:async()=>{opens++;throw Object.assign(Error('secret-provider-detail'),{code:'photon_auth_failed'});}});
 f.c.start();await wait(()=>f.c.status().state==='stalled');assert.equal(opens,1);
 assert.equal(f.c.status().reason,'photon_auth_failed');assert.equal(JSON.stringify(f.c.status()).includes('secret'),false);
});
test('late authentication after stop closes without accepting events or reopening',async t=>{
 let finish,closed=0;const f=setup(t,{open:()=>new Promise(r=>finish=r)});f.c.start();await wait(()=>finish);
 await f.c.stop();finish({expiresAt:Date.now()+10000,live:source(),close:async()=>closed++,sendText:async()=>{}});
 await wait(()=>closed===1);assert.equal(f.c.status().state,'stopped');assert.equal(f.received.length,0);
});
test('session renewal obtains a new session without extending activation',async t=>{
 const sessions=[];const deadline=Date.now()+220;
 const f=setup(t,{expiresAt:deadline,open:async()=>{const live=source();const s={live,expiresAt:Date.now()+70,sendText:async()=>{},close:async()=>live.close()};sessions.push(s);return s;}});
 f.c.start();await wait(()=>sessions.length>=2);await wait(()=>f.c.status().state==='expired');const n=sessions.length;
 await new Promise(r=>setTimeout(r,50));assert.equal(sessions.length,n);
});
test('received persistence failures stall without repeatedly admitting or reconnecting',async t=>{
 const f=setup(t,{receive:()=>{throw Error('private database text');}});f.c.start();await wait(()=>f.sessions.length===1);
 f.sessions[0].live.push(event());await wait(()=>f.c.status().state==='stalled');assert.equal(f.sessions.length,1);
 assert.equal(f.c.status().reason,'photon_ingestion_failed');
});

test('an authentication failure on a send retires the session without reminting or retrying',async t=>{
 const f=setup(t);f.c.start();await wait(()=>f.sessions.length===1);let sends=0;
 f.sessions[0].sendText=async()=>{sends++;throw Object.assign(Error('private credential detail'),{code:'photon_auth_failed'});};
 await assert.rejects(f.c.provider.messages.sendText(route.dm,'reply',{}),/photon_auth_failed/);
 await wait(()=>f.c.status().state==='stalled');assert.equal(f.c.status().reason,'photon_auth_failed');
 assert.equal(f.sessions.length,1);assert.equal(sends,1);
});

test('process interruption after live admission preserves claims and uncertain sends on restart',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {spawnSync}=await import('node:child_process'),{openMessageStore}=await import('./message-store.mjs');
 const dir=mkdtempSync(join(tmpdir(),'live-crash-')),path=join(dir,'messages.sqlite');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const identity={...route,issuer:'fixture',clientId:'fixture',subject:'fixture'};
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {openMessageStore} from './message-store.mjs';import {createPhotonLiveController} from './photon-live-controller.mjs';
  const identity=JSON.parse(process.argv[2]),route=identity,s=openMessageStore({path:process.argv[1],identity});
  const frame=JSON.parse(process.argv[3]);frame.message.dateCreated=new Date();
  const controller=createPhotonLiveController({route,expiresAt:Date.now()+10000,isActive:()=>true,
   adapter:{open:async()=>({expiresAt:Date.now()+9000,live:{async *[Symbol.asyncIterator](){yield frame;}},sendText:async()=>{},close:async()=>{}})},
   receive:e=>{const r=s.accept({provider_id:e.message.guid,text:e.message.content.text});s.claim(r.request_id);
    s.enqueueReply({request_id:r.request_id,response_id:'answer',text:'fixture reply',final:true});s.reserveReply();process.kill(process.pid,'SIGKILL');}});
  controller.start();
 `,path,JSON.stringify(identity),JSON.stringify(event('crash'))],{cwd:process.cwd(),encoding:'utf8',timeout:5000});
 assert.equal(child.signal,'SIGKILL');const store=openMessageStore({path,identity});t.after(()=>store.close());store.recover();
 const f=setup(t,{receive:e=>({accepted:true,...store.accept({provider_id:e.message.guid,text:e.message.content.text})})});
 f.c.start();await wait(()=>f.sessions.length===1);f.sessions[0].live.push(event('crash',7000));f.sessions[0].live.push(event('new',9000));
 await wait(()=>store.listRequests().length===2);const first=store.listRequests()[0];
 assert.equal(store.claim(first.request_id).acquired,false);assert.equal(first.replies[0].state,'unknown_outcome');assert.equal(store.reserveReply(),undefined);
 await f.c.stop();
});

test('stop during retry backoff releases timers so the process exits promptly',async()=>{
 const {spawnSync}=await import('node:child_process');
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {createPhotonLiveController} from './photon-live-controller.mjs';
  const c=createPhotonLiveController({route:JSON.parse(process.argv[1]),adapter:{open:async()=>{throw Error('fixture');}},
   receive:()=>({accepted:true}),isActive:()=>true,expiresAt:Date.now()+10000,retryDelaysMs:[60000]});
  c.start();setTimeout(()=>{void c.stop();},20);
 `,JSON.stringify(route)],{cwd:process.cwd(),encoding:'utf8',timeout:2000});
 assert.equal(child.status,0,child.stderr);assert.equal(child.signal,null);
});

test('heartbeats keep an idle stream alive; silent stream retries exhaust a finite budget',async t=>{
 let opens=0,pulse;const f=setup(t,{idleTimeoutMs:40,activityPollMs:5,open:async({onActivity})=>{
  opens++;pulse=()=>onActivity('heartbeat');const live=source();return {live,expiresAt:Date.now()+10000,sendText:async()=>{},close:async()=>live.close()};
 }});
 f.c.start();await wait(()=>pulse);const timer=setInterval(()=>pulse(),10);t.after(()=>clearInterval(timer));
 await new Promise(r=>setTimeout(r,100));assert.equal(opens,1);assert.equal(f.c.status().state,'listening');
 clearInterval(timer);await wait(()=>f.c.status().state==='stalled');assert.equal(opens,3);assert.equal(f.c.status().reason,'photon_retries_exhausted');
});
