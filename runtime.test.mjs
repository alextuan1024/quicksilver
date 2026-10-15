import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createRuntimeService} from './runtime.mjs';
import {PROJECT_ID,INCOMING_TEXT,REPLY_TEXT} from './photon.mjs';

const started=1_800_000_000_000,owner='+13322179242';
const env={QUICKSILVER_OWNER_SUBJECT:'google-oauth2|fixture-owner',
 QUICKSILVER_SESSION_EXPIRES_AT:new Date(started+60_000).toISOString(),
 PHOTON_OWNER_ADDRESS:owner,SPECTRUM_PROJECT_SECRET:'public-fixture'};
const keys=await generateKeyPair('RS256');
const jwks=createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'runtime-fixture'}]});
async function authorization(subject=env.QUICKSILVER_OWNER_SUBJECT){
 const token=await new SignJWT({iss:'https://dev-ar7fhtveuwv8gobu.us.auth0.com/',
  aud:'https://quicksilver-kvt8.onrender.com/mcp',sub:subject,client_id:'tpc_caXSmFzUtRmg6MaouZ9Dij',
  scope:'quicksilver:probe',iat:started/1000,exp:started/1000+3600,jti:'runtime-fixture'})
  .setProtectedHeader({alg:'RS256',kid:'runtime-fixture',typ:'at+jwt'}).sign(keys.privateKey);
 return {authorization:`Bearer ${token}`};
}
const headers=await authorization();
const rpc=(service,method,params,h=headers)=>service.handle('POST','/mcp',h,{jsonrpc:'2.0',id:1,method,params});
const call=async(service,name,args,h=headers)=>(await rpc(service,'tools/call',{name,arguments:args},h)).body.result?.structuredContent;

test('runtime retains explicit source-lock behavior despite credentials and env enable attempts',async()=>{
 let factories=0;
 const service=createRuntimeService({...env,PHOTON_LIVE_TRANSPORT_ALLOWED:'true',PHOTON_ENABLED:'true'},
  {now:()=>started,jwks,transportAllowed:false,transportFactory:()=>{factories++;throw Error('must not construct');}});
 const status=await call(service,'photon_test_status',{});
 assert.equal(status.configured,true);assert.equal(status.state,'disarmed');assert.equal(status.transport,'locked');
 assert.equal((await call(service,'arm_photon_test',{boot_id:status.boot_id})).state,'unavailable');
 assert.equal(factories,0);
 assert.equal((await service.handle('GET','/healthz',{},{})).body.photon,'disabled');
 assert.equal(JSON.stringify(status).includes(env.SPECTRUM_PROJECT_SECRET),false);
 await service.stop();
});

test('default reviewed runtime prepares transport but stays disarmed without a subscription',async()=>{
 // Exercise the default source flag with an injected fixture, never a live SDK.
 let factories=0,starts=0;
 const service=createRuntimeService(env,{now:()=>started,jwks,transportFactory:()=>{
  factories++;return {start:async()=>{starts++;},stop:async()=>{}};
 }});
 const status=await call(service,'photon_test_status',{});
 assert.equal(status.configured,true);assert.equal(status.state,'disarmed');
 assert.equal(status.transport,'fixture_or_reviewed_transport');
 assert.equal((await call(service,'arm_photon_test',{boot_id:status.boot_id})).state,'unavailable');
 assert.equal(factories,1);assert.equal(starts,0);
 await service.stop();
});

test('reviewed wiring requires exact owner, credential, OAuth owner and a fresh bounded deadline',async()=>{
 for(const change of [{PHOTON_OWNER_ADDRESS:undefined},{PHOTON_OWNER_ADDRESS:'+15550000001'},
  {SPECTRUM_PROJECT_SECRET:undefined},{SPECTRUM_PROJECT_SECRET:'   '},{QUICKSILVER_OWNER_SUBJECT:undefined},
  {QUICKSILVER_SESSION_EXPIRES_AT:'2026-10-13T17:58:00Z'},
  {QUICKSILVER_SESSION_EXPIRES_AT:new Date(started+3600_001).toISOString()}]){
  let factories=0;
  const service=createRuntimeService({...env,...change},{now:()=>started,jwks,transportAllowed:true,
   transportFactory:()=>{factories++;throw Error('must not construct');}});
  assert.equal(factories,0);await service.stop();
 }
});

test('configured runtime remains disarmed until owner OAuth, subscription and exact boot activation; replies once',async()=>{
 let time=started,receive,starts=0,sends=0;const deliveries=[];
 const options={now:()=>time,jwks,transportAllowed:true,
  transportFactory:input=>{
   assert.deepEqual(input.config,{projectId:PROJECT_ID,ownerAddress:owner,line:'shared',dm:`any;-;${owner}`});
   assert.equal(input.projectSecret,'public-fixture');assert.equal(input.expiresAt,env.QUICKSILVER_SESSION_EXPIRES_AT);
   return {start:async callback=>{starts++;receive=callback;},stop:async()=>{}};
  },postCallback:async(url,raw)=>{const body=JSON.parse(raw);deliveries.push(body);return {status:200,body:{challenge:body.challenge}};}};
 const service=createRuntimeService(env,options),restart=createRuntimeService(env,options);
 const status=await call(service,'photon_test_status',{}),next=await call(restart,'photon_test_status',{});
 assert.equal(starts,0);assert.equal(status.state,'disarmed');assert.notEqual(status.boot_id,next.boot_id);
 assert.equal((await rpc(service,'tools/call',{name:'arm_photon_test',arguments:{boot_id:status.boot_id}},{})).status,401);
 assert.equal((await rpc(service,'tools/call',{name:'arm_photon_test',arguments:{boot_id:status.boot_id}},await authorization('google-oauth2|other'))).status,403);
 assert.equal((await call(service,'arm_photon_test',{boot_id:status.boot_id})).state,'unavailable');
 await rpc(service,'events/subscribe',{name:'photon.test.received',arguments:{session:'quicksilver'},
  delivery:{mode:'webhook',url:'https://callback.example.com/photon',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
 assert.equal((await call(service,'arm_photon_test',{boot_id:next.boot_id})).state,'unavailable');
 assert.equal((await call(service,'arm_photon_test',{boot_id:status.boot_id})).state,'connecting');
 assert.equal((await call(service,'arm_photon_test',{boot_id:status.boot_id})).state,'unavailable');assert.equal(starts,1);
 const space={id:`any;-;${owner}`,phone:'shared',type:'dm',__platform:'imessage'};
 const message={id:'fixture-message',platform:'imessage',direction:'inbound',timestamp:new Date(time),space,
  sender:{address:owner,service:'iMessage'},content:{type:'text',text:INCOMING_TEXT},
  reply:async text=>{assert.equal(text,REPLY_TEXT);sends++;return {id:'fixture-reply'};}};
 await receive(space,{...message,sender:{address:'+15550000001',service:'iMessage'}});
 await receive(space,{...message,content:{type:'text',text:'other text'}});assert.equal(deliveries.length,1);
 await receive(space,message);assert.equal(deliveries.length,2);
 const request_id=deliveries[1].data.request_id;
 assert.equal((await call(service,'reply_photon_test',{request_id,text:'arbitrary'})).state,'unavailable');
 assert.equal((await call(service,'reply_photon_test',{request_id})).state,'provider_accepted');
 await call(service,'reply_photon_test',{request_id});assert.equal(sends,1);
 assert.equal((await call(restart,'reply_photon_test',{request_id})).state,'unavailable');
 time+=60_001;
 assert.equal((await rpc(service,'tools/call',{name:'arm_photon_test',arguments:{boot_id:status.boot_id}})).status,503);
 await service.stop();await restart.stop();
});
