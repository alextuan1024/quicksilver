import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotonTest, PROJECT_ID, INCOMING_TEXT, REPLY_TEXT} from './photon.mjs';
function fixture(overrides={}) {
 let time=1_800_000_000_000, subscription=true, sends=0, starts=0, stops=0, receive;
 const events=[];
 const config={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'fixture-line',dm:'fixture-dm'};
 const transport={async start(callback){ starts++; receive=callback; },async stop(){stops++;}};
 const controller=createPhotonTest({config,now:()=>time,expiresAt:new Date(time+60_000).toISOString(),
  ready:()=>subscription,publish:async data=>{events.push(data);return true;},transport,...overrides});
 const message=()=>({id:'fixture-message',platform:'imessage',direction:'inbound',timestamp:new Date(time),
  sender:{address:config.ownerAddress,service:'iMessage'},content:{type:'text',text:INCOMING_TEXT},
  space:{id:config.dm,type:'dm',phone:config.line,__platform:'imessage'},
  reply:async text=>{assert.equal(text,REPLY_TEXT);sends++;return {id:'fixture-outbound'};}});
 return {controller,config,message,events,transport,arm:()=>controller.call('arm_photon_test',{boot_id:controller.status().boot_id}),
  deliver:m=>receive(m.space,m),advance:n=>{time+=n;},unsubscribe:()=>{subscription=false;},counts:()=>({sends,starts,stops})};
}
test('missing private configuration, safety lock and missing subscription cannot start transport',async()=>{
 for(const options of [{config:{}},{transport:undefined},{ready:()=>false}]) {
  const f=fixture(options); assert.equal((await f.arm()).state,'unavailable'); assert.equal(f.counts().starts,0);
 }
});
test('boot-bound explicit arm is single-use and cannot be replayed across restart',async()=>{
 const a=fixture(), b=fixture();
 assert.equal(a.counts().starts,0);
 assert.equal((await b.controller.call('arm_photon_test',{boot_id:a.controller.status().boot_id})).state,'unavailable');
 assert.equal((await a.arm()).state,'listening');await a.arm();assert.equal(a.counts().starts,1);
 await a.controller.stop();assert.equal((await a.arm()).state,'unavailable');
});
test('exact sender, project, line, DM, inbound text and fresh timestamp are required',async()=>{
 const f=fixture();await f.arm();
 for(const change of [m=>m.sender.address='+15550000002',m=>m.sender.service='SMS',m=>m.space.type='group',
  m=>m.space.id='other',m=>m.space.phone='other',m=>m.platform='other',m=>m.direction='outbound',
  m=>m.content.text='other',m=>m.content.type='attachment',m=>m.timestamp=new Date(0),
  m=>m.timestamp=new Date(9e12),m=>m.id='',m=>m.isAutoReply=true,m=>m.parentId='multipart']) {
  const m=f.message();change(m);await f.deliver(m);
 }
 assert.equal(f.events.length,0);
 const wrong=fixture({config:{...f.config,projectId:'wrong'}});assert.equal((await wrong.arm()).state,'unavailable');
 await f.deliver(f.message());assert.equal(f.events.length,1);assert.equal(f.counts().sends,0);
 assert.deepEqual(Object.keys(f.events[0]).sort(),['request_id','text']);
});
test('one event and one request-bound fixed reply; duplicates, concurrency and arbitrary arguments rejected',async()=>{
 const f=fixture();await f.arm();await Promise.all([f.deliver(f.message()),f.deliver(f.message())]);
 const request_id=f.events[0].request_id;assert.equal(f.events.length,1);
 for(const args of [{request_id:'wrong'},{request_id,text:'injected'},{request_id,to:'+15550000002'}])
  assert.equal((await f.controller.call('reply_photon_test',args)).state,'unavailable');
 const replies=await Promise.all([f.controller.call('reply_photon_test',{request_id}),f.controller.call('reply_photon_test',{request_id})]);
 assert.equal(f.counts().sends,1);assert.ok(replies.some(r=>r.state==='provider_accepted'));
 await f.controller.call('reply_photon_test',{request_id});assert.equal(f.counts().sends,1);
});
test('unknown send outcome consumes slot; restart, expiry and unsubscribe prevent stale replies',async()=>{
 for(const action of ['throw','undefined','expire','unsubscribe','restart']) {
  const f=fixture();await f.arm();const m=f.message();let sends=0;
  m.reply=async()=>{sends++;if(action==='throw')throw Error('private provider error');};await f.deliver(m);
  const request_id=f.events[0].request_id;let c=f.controller;
  if(action==='expire')f.advance(60_001);if(action==='unsubscribe')f.unsubscribe();if(action==='restart')c=fixture().controller;
  const r=await c.call('reply_photon_test',{request_id});
  assert.equal(r.state,['throw','undefined'].includes(action)?'unknown_outcome':'unavailable');
  await c.call('reply_photon_test',{request_id});assert.equal(sends,['throw','undefined'].includes(action)?1:0);
 }
});
test('callback uncertainty consumes receive slot and forbids reply, without retries',async()=>{
 const f=fixture({publish:async()=>{throw Error('private callback error');}});await f.arm();await f.deliver(f.message());
 assert.equal(f.controller.status().state,'callback_unknown');await f.deliver(f.message());assert.equal(f.counts().sends,0);
});
