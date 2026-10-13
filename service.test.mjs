import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createService } from './service.mjs';

const issuer='https://issuer.example/';
const resource='https://resource.example/mcp';
const now=1_800_000_000;
const keys=await generateKeyPair('RS256');
const config={issuer,resource,clientId:'test-client',ownerSubject:'google-oauth2|owner',
  expiresAt:new Date((now+3600)*1000).toISOString(),now:()=>now*1000,
  jwks:createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'test'}]})};
const jwt=await new SignJWT({iss:issuer,aud:resource,sub:config.ownerSubject,client_id:config.clientId,
  scope:'quicksilver:probe',iat:now,exp:now+3600,jti:'service-test'})
  .setProtectedHeader({alg:'RS256',kid:'test',typ:'at+jwt'}).sign(keys.privateKey);
const headers={authorization:`Bearer ${jwt}`};
const rpc={jsonrpc:'2.0',id:1,method:'tools/list'};
test('resource metadata and OAuth discovery work while owner/session remain closed',async()=>{
  const service=createService({...config,ownerSubject:undefined});
  assert.equal((await service.handle('GET','/healthz',{},{})).body.mode,'disabled');
  for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']) {
    assert.equal((await service.handle('GET',path,{},{})).body.resource,resource);
    assert.equal((await service.handle('POST',path,{},{})).status,405);
  }
  assert.equal((await service.handle('POST','/mcp',{},rpc)).status,401);
  assert.equal((await service.handle('POST','/mcp',headers,rpc)).status,503);
});
test('every MCP request requires pinned OAuth owner, with no legacy-key or proof-trigger bypass',async()=>{
  const service=createService(config);
  assert.equal((await service.handle('POST','/mcp',headers,rpc)).body.result.tools[0].name,'acknowledge_probe');
  assert.equal((await service.handle('POST','/mcp',{authorization:'Bearer fixture-only-fixture-only-fixture-only-'},rpc)).status,401);
  for(const method of ['GET','POST']) assert.equal((await service.handle(method,'/proof',headers,{})).status,403);
});

test('synthetic trigger remains exact-owner gated and expires with the bounded session',async()=>{
 let time=now*1000;
 const service=createService({...config,expiresAt:new Date(time+60_000).toISOString(),now:()=>time});
 const trigger={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'trigger_synthetic_probe',arguments:{}}};
 assert.equal((await service.handle('POST','/mcp',{},trigger)).status,401);
 const wrong=await new SignJWT({iss:issuer,aud:resource,sub:'google-oauth2|other',client_id:config.clientId,scope:'quicksilver:probe',iat:now,exp:now+3600,jti:'wrong-owner'})
  .setProtectedHeader({alg:'RS256',kid:'test',typ:'at+jwt'}).sign(keys.privateKey);
 assert.equal((await service.handle('POST','/mcp',{authorization:`Bearer ${wrong}`},trigger)).status,403);
 assert.equal((await service.handle('POST','/mcp',headers,trigger)).body.error.code,-32602);
 time+=60_001;
 assert.equal((await service.handle('POST','/mcp',headers,trigger)).status,503);
});

test('Photon event and fixed reply share owner OAuth; deployed default cannot arm',async()=>{
 const service=createService(config);
 const call=(name,args,h=headers)=>service.handle('POST','/mcp',h,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}});
 const status=(await call('photon_test_status',{})).body.result.structuredContent;
 assert.equal(status.transport,'locked');assert.equal(status.configured,false);
 assert.equal((await call('arm_photon_test',{boot_id:status.boot_id})).body.result.structuredContent.state,'unavailable');
 assert.equal((await call('photon_test_status',{},{})).status,401);
 assert.equal((await call('reply_photon_test',{request_id:'forged'})).body.result.structuredContent.state,'unavailable');
});

test('fixture owner DM reaches signed event and one request-bound reply through MCP',async()=>{
 const {PROJECT_ID,INCOMING_TEXT,REPLY_TEXT}=await import('./photon.mjs');
 const {createHmac}=await import('node:crypto');
 let receive,sends=0;const deliveries=[],signingBytes=Buffer.alloc(32,9);
 const service=createService({...config,photon:{projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'fixture-line',dm:'fixture-dm'},
  photonTransport:{start:async callback=>{receive=callback;},stop:async()=>{}},
  postCallback:async(url,raw,headers,options)=>{
   assert.equal(options.isActive(),true);assert.equal(url,'https://callback.example.com/photon');
   assert.equal(headers['webhook-signature'],'v1,'+createHmac('sha256',signingBytes).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${raw}`).digest('base64'));
   const body=JSON.parse(raw);deliveries.push(body);return {status:200,body:{challenge:body.challenge}};
  }});
 const rpc=(method,params)=>service.handle('POST','/mcp',headers,{jsonrpc:'2.0',id:4,method,params});
 const call=async(name,args)=>(await rpc('tools/call',{name,arguments:args})).body.result.structuredContent;
 const boot_id=(await call('photon_test_status',{})).boot_id;
 assert.equal((await call('arm_photon_test',{boot_id})).state,'unavailable');
 await rpc('events/subscribe',{name:'photon.test.received',arguments:{session:'quicksilver'},delivery:{mode:'webhook',url:'https://callback.example.com/photon',secret:'whsec_'+signingBytes.toString('base64')}});
 assert.equal((await call('arm_photon_test',{boot_id})).state,'listening');
 const space={id:'fixture-dm',type:'dm',phone:'fixture-line',__platform:'imessage'};
 await receive(space,{space,id:'fixture-incoming',platform:'imessage',direction:'inbound',timestamp:new Date(now*1000),
  sender:{address:'+15550000001',service:'iMessage'},content:{type:'text',text:INCOMING_TEXT},
  reply:async text=>{assert.equal(text,REPLY_TEXT);sends++;return {id:'fixture-outgoing'};}});
 assert.equal(deliveries.length,2);assert.equal(deliveries[1].name,'photon.test.received');
 const args={request_id:deliveries[1].data.request_id};
 assert.equal((await call('reply_photon_test',args)).state,'provider_accepted');
 await call('reply_photon_test',args);assert.equal(sends,1);await service.stop();
});
