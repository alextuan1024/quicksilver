import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotonTransport} from './photon-transport.mjs';
import {createPhotonTest,PROJECT_ID,INCOMING_TEXT} from './photon.mjs';
import * as diagnostics from './diagnostics.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture({diagnosticSink,issue,create,receiveOverride,send}={}) {
 let time=1_800_000_000_000,options,next=deferred(),starts=0,closes=0,sends=0;
 const expiresAt=new Date(time+60_000).toISOString(),records=[],events=[];
 const config={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'};
 const source={ [Symbol.asyncIterator](){return this;},next(){return next.promise;},close:async()=>next.resolve({done:true}) };
 const transport=createPhotonTransport({config,projectSecret:'public-fixture',expiresAt,now:()=>time,
  onDiagnostic:diagnosticSink??(record=>records.push(record)),sdkLoader:async()=>({
   issueTokens:async()=>issue?issue():({type:'shared',token:'public-fixture',expiresIn:3600}),
   createClient:input=>{options=input;if(create)return create();return {close:async()=>{closes++;},messages:{
    subscribeEvents:()=>{starts++;return source;},sendText:async()=>{sends++;return send?send():{guid:'fixture-outbound'};}}};}
  })});
 const wrapped=receiveOverride?{stop:()=>transport.stop(),start:(_receive,active,terminal,activity)=>transport.start(receiveOverride,active,terminal,activity)}:transport;
 const controller=createPhotonTest({config,expiresAt,now:()=>time,transport:wrapped,ready:()=>true,
  publish:async data=>{events.push(data);return true;}});
 return {controller,transport,records,events,config,
  arm:()=>controller.call('arm_photon_test',{boot_id:controller.status().boot_id}),
  heartbeat:()=>options.onHeartbeat(),advance:ms=>{time+=ms;},
  error:async error=>{next.reject(error);await flush();},
  end:async()=>{next.resolve({done:true});await flush();},
  incoming:async(change=()=>{})=>{const old=next;next=deferred();const event={type:'message.received',isFromMe:false,chatGuid:config.dm,
   message:{guid:'fixture-guid',chatGuids:[config.dm],isFromMe:false,itemType:'normal',sender:{address:config.ownerAddress,service:'iMessage'},
    dateCreated:new Date(time),content:{text:INCOMING_TEXT,attachments:[]},partCount:1}};
   change(event);old.resolve({done:false,value:event});await flush();},
  counts:()=>({starts,closes,sends})};
}

test('arm stays connecting until heartbeat; duplicate activity and late activity cannot rearm or revive',async()=>{
 const f=fixture();
 assert.equal((await f.arm()).state,'connecting');assert.equal(f.controller.status().state,'connecting');
 assert.equal(f.events.length,0);assert.equal((await f.arm()).state,'unavailable');
 f.advance(25);f.heartbeat();assert.equal(f.controller.status().state,'listening');f.heartbeat();
 assert.deepEqual(f.records,[
  {event:'photon_transport',phase:'subscription',category:'started',grpcCode:null,elapsedMs:0,heartbeatSeen:false,eventSeen:false},
  {event:'photon_transport',phase:'stream',category:'observed',grpcCode:null,elapsedMs:25,heartbeatSeen:true,eventSeen:false}
 ]);
 await f.controller.stop();f.heartbeat();assert.equal(f.controller.status().state,'stopped');
 assert.equal((await f.arm()).state,'unavailable');assert.equal(f.counts().starts,1);assert.equal(f.counts().sends,0);
});

test('decoded activity confirms the stream but exact owner and text filters still control publication',async()=>{
 const f=fixture();assert.equal((await f.arm()).state,'connecting');
 await f.incoming(e=>{e.message.sender.address='+15550000002';});
 assert.equal(f.controller.status().state,'listening');assert.equal(f.events.length,0);
 await f.incoming(e=>{e.message.content.text='other';});assert.equal(f.events.length,0);
 await f.incoming();assert.equal(f.events.length,1);assert.equal(f.controller.status().state,'awaiting_reply');
 assert.equal(f.records.filter(r=>r.category==='observed').length,1);
 assert.equal(f.records.find(r=>r.category==='observed').eventSeen,true);
 assert.equal(f.counts().sends,0);await f.controller.stop();
});

for(const [code,category] of [[16,'unauthenticated'],[7,'permission_denied'],[5,'not_found'],[3,'invalid_argument'],
 [4,'deadline_exceeded'],[8,'resource_exhausted'],[9,'failed_precondition'],[13,'internal'],[14,'unavailable'],[2,'unknown']]) {
 test(`stream failure preserves only fixed category ${category} and terminates pending connection`,async()=>{
  const f=fixture();assert.equal((await f.arm()).state,'connecting');f.advance(75);
  const error=Object.assign(new Error('must-never-log'),{grpcCode:code,context:{token:'must-never-log'},metadata:'must-never-log'});
  await f.error(error);
  assert.equal(f.controller.status().state,'transport_error');
  const failure=f.records.find(r=>r.phase==='stream'&&r.category===category);
  assert.deepEqual(failure,{event:'photon_transport',phase:'stream',category,grpcCode:code,elapsedMs:75,heartbeatSeen:false,eventSeen:false});
  assert.equal(JSON.stringify(f.records).includes('must-never-log'),false);
  assert.equal((await f.arm()).state,'unavailable');assert.equal(f.counts().starts,1);assert.equal(f.counts().sends,0);
  f.heartbeat();assert.equal(f.controller.status().state,'transport_error');await f.controller.stop();
 });
}

test('diagnostic projection rejects arbitrary phase/category/status/details without stringifying them',()=>{
 assert.equal(typeof diagnostics.transportSummary,'function');
 const hostile={toString(){throw Error('must not stringify');},toJSON(){throw Error('must not serialize');}};
 assert.deepEqual(diagnostics.transportSummary({phase:hostile,category:hostile,grpcCode:'16',elapsedMs:-1,
  heartbeatSeen:hostile,eventSeen:hostile,error:hostile,token:'must-never-log'}),
  {event:'photon_transport',phase:'unknown',category:'unknown',grpcCode:null,elapsedMs:0,heartbeatSeen:false,eventSeen:false});
});

test('startup and receive failures have distinct phases; diagnostic sink errors cannot alter termination',async()=>{
 const privateError=Object.assign(new Error('must-never-log'),{grpcCode:999});
 const failed=fixture({issue:()=>{throw privateError;}});
 assert.equal((await failed.arm()).state,'transport_failed');
 assert.ok(failed.records.some(r=>r.phase==='token_exchange'&&r.category==='unknown'&&r.grpcCode===null));
 const receive=fixture({receiveOverride:async()=>{throw privateError;}});
 await receive.arm();await receive.incoming();assert.equal(receive.controller.status().state,'transport_error');
 assert.ok(receive.records.some(r=>r.phase==='receive'&&r.category==='unknown'));
 assert.equal(JSON.stringify([...failed.records,...receive.records]).includes('must-never-log'),false);
 const sink=fixture({diagnosticSink:()=>{throw Error('must-never-log');}});
 assert.equal((await sink.arm()).state,'connecting');await sink.error(privateError);
 assert.equal(sink.controller.status().state,'transport_error');assert.equal((await sink.arm()).state,'unavailable');
 await failed.controller.stop();await receive.controller.stop();await sink.controller.stop();
});

test('heartbeat after cutoff cannot change connecting to listening or publish an event',async()=>{
 const f=fixture();assert.equal((await f.arm()).state,'connecting');f.advance(60_001);f.heartbeat();
 assert.notEqual(f.controller.status().state,'listening');await f.incoming();
 assert.equal(f.events.length,0);assert.equal(f.counts().sends,0);assert.equal((await f.arm()).state,'unavailable');
 await f.controller.stop();
});

test('production log sink serializes only the allowlisted diagnostic projection',t=>{
 const log=t.mock.method(console,'log',()=>{});
 diagnostics.logTransportDiagnostic({phase:'stream',category:'unauthenticated',grpcCode:16,elapsedMs:12,
  heartbeatSeen:true,eventSeen:false,message:'must-never-log',metadata:'must-never-log',token:'must-never-log'});
 assert.equal(log.mock.calls.length,1);
 assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]),{event:'photon_transport',phase:'stream',category:'unauthenticated',
  grpcCode:16,elapsedMs:12,heartbeatSeen:true,eventSeen:false});
});

test('send failure diagnostics preserve the single spent reply and unknown outcome',async()=>{
 const f=fixture({send:()=>{throw Object.assign(new Error('must-never-log'),{grpcCode:14,metadata:'must-never-log'});}});
 await f.arm();await f.incoming();
 const args={request_id:f.events[0].request_id};
 assert.equal((await f.controller.call('reply_photon_test',args)).state,'unknown_outcome');
 assert.equal((await f.controller.call('reply_photon_test',args)).state,'unavailable');
 assert.equal(f.counts().sends,1);assert.equal((await f.arm()).state,'unavailable');
 assert.ok(f.records.some(r=>r.phase==='send'&&r.category==='unavailable'&&r.grpcCode===14));
 assert.equal(JSON.stringify(f.records).includes('must-never-log'),false);await f.controller.stop();
});
