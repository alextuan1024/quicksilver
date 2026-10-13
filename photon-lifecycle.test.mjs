import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotonTransport} from './photon-transport.mjs';
import {createPhotonTest,PROJECT_ID,INCOMING_TEXT} from './photon.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup({ttl=3600,sendPending=false}={}) {
 const now=Date.now(),expiresAt=new Date(now+60_000).toISOString();
 const config={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'};
 let next=deferred(),sends=0,closes=0;const send=deferred(),events=[];
 const source={ [Symbol.asyncIterator](){return this;},next(){return next.promise;},
  close:async()=>{next.resolve({done:true});}};
 const transport=createPhotonTransport({config,projectSecret:'public-fixture',expiresAt,
  sdkLoader:async()=>({issueTokens:async()=>({type:'shared',token:'public-fixture',expiresIn:ttl}),createClient:()=>({
   close:async()=>{closes++;},messages:{subscribeEvents:()=>source,sendText:async()=>{sends++;return sendPending?send.promise:{guid:'outbound'};}}})})});
 const controller=createPhotonTest({config,transport,expiresAt,ready:()=>true,publish:async data=>{events.push(data);return true;}});
 return {controller,transport,events,send,counts:()=>({sends,closes}),
  arm:()=>controller.call('arm_photon_test',{boot_id:controller.status().boot_id}),
  async incoming(){const old=next;next=deferred();old.resolve({done:false,value:{type:'message.received',isFromMe:false,chatGuid:config.dm,
   message:{guid:'inbound',chatGuids:[config.dm],isFromMe:false,itemType:'normal',sender:{address:config.ownerAddress,service:'iMessage'},
    dateCreated:new Date(),content:{text:INCOMING_TEXT,attachments:[]},partCount:1}}});await flush();},
  end:()=>next.resolve({done:true}),error:()=>next.reject(Error('private provider details')),
  reply:()=>controller.call('reply_photon_test',{request_id:events[0]?.request_id})};
}
for(const kind of ['end','error'])for(const pending of [false,true])test(`stream ${kind} invalidates ${pending?'pending request':'listening state'}`,async()=>{
 const f=setup();await f.arm();if(pending)await f.incoming();f[kind]();await flush();
 assert.equal(f.controller.status().state,kind==='end'?'transport_ended':'transport_error');
 assert.equal((await f.reply()).state,'unavailable');assert.equal((await f.arm()).state,'unavailable');assert.equal(f.counts().sends,0);
 assert.equal(f.counts().closes,1);await f.controller.stop();
});
for(const kind of ['end','error'])test(`stream ${kind} during send preserves unknown outcome even after late success`,async()=>{
 const f=setup({sendPending:true});await f.arm();await f.incoming();const reply=f.reply();assert.equal(f.counts().sends,1);
 f[kind]();await flush();assert.equal(f.controller.status().state,'unknown_outcome');
 f.send.resolve({guid:'late-outbound'});assert.equal((await reply).state,'unknown_outcome');
 assert.equal((await f.reply()).state,'unavailable');assert.equal(f.counts().sends,1);await f.controller.stop();
 assert.equal(f.controller.status().state,'unknown_outcome');
});
for(const inFlight of [false,true])test(`earlier token expiry invalidates request${inFlight?' and preserves send uncertainty':''}`,async()=>{
 // Real transport timer; bounded one-second window after its five-second safety margin.
 const f=setup({ttl:6,sendPending:inFlight});await f.arm();await f.incoming();
 const pending=inFlight?f.reply():null;
 await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal(f.controller.status().state,inFlight?'unknown_outcome':'token_expired');
 assert.equal((await f.reply()).state,'unavailable');assert.equal(f.counts().closes,1);
 if(pending){f.send.resolve({guid:'late'});assert.equal((await pending).state,'unknown_outcome');}
 await f.controller.stop();
});
test('normal accepted reply remains accepted after intentional transport cleanup',async()=>{
 const f=setup();await f.arm();await f.incoming();assert.equal((await f.reply()).state,'provider_accepted');await flush();
 assert.equal(f.controller.status().state,'provider_accepted');assert.equal(f.counts().sends,1);assert.equal(f.counts().closes,1);
});
