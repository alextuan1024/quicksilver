import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createService} from './service.mjs';
import {createRuntimeService} from './runtime.mjs';

const start=1_800_000_000_000;
const keys=await generateKeyPair('RS256');
const wrongKeys=await generateKeyPair('RS256');
const jwks=createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'discovery-fixture'}]});
const config={issuer:'https://issuer.example/',resource:'https://resource.example/mcp',
  clientId:'fixture-client',ownerSubject:'google-oauth2|fixture-owner',
  expiresAt:new Date(start-1000).toISOString(),now:()=>start,jwks};
async function auth(overrides={},signingKey=keys.privateKey,typ='at+jwt',settings=config) {
  const claims={iss:settings.issuer,aud:settings.resource,sub:settings.ownerSubject,client_id:settings.clientId,
    scope:'quicksilver:probe',iat:start/1000,exp:start/1000+3600,jti:'discovery-fixture',...overrides};
  for(const key of Object.keys(claims)) if(claims[key]===undefined) delete claims[key];
  const jwt=await new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'discovery-fixture',typ}).sign(signingKey);
  return {authorization:`Bearer ${jwt}`};
}
const headers=await auth();
const methods=['server/discover','initialize','notifications/initialized','ping','tools/list','events/list'];
const rpc=method=>({jsonrpc:'2.0',...(method==='notifications/initialized'?{}:{id:1}),method});
const request=(service,method,h=headers)=>service.handle('POST','/mcp',h,rpc(method));
const subscription=name=>({name,arguments:{session:'quicksilver'},delivery:{mode:'webhook',
  url:'https://callback.example.com/events',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
async function expectDiscovery(service,h=headers) {
  for(const method of methods) {
    const result=await request(service,method,h);
    assert.equal(result.status,method==='notifications/initialized'?202:200,method);
    if(method!=='notifications/initialized') assert.equal(result.body.result.resultType,'complete');
    if(method==='tools/list') assert.deepEqual(result.body.result.tools.map(t=>t.name),
      ['acknowledge_probe','trigger_synthetic_probe','photon_test_status','arm_photon_test','reply_photon_test']);
    if(method==='events/list') assert.deepEqual(result.body.result.events.map(e=>e.name),['probe.created','photon.test.received']);
  }
}
async function expectOperationsClosed(service,h=headers) {
  const requests=[rpc('unknown/method'),rpc('tools/list/extra'),
    ...['acknowledge_probe','trigger_synthetic_probe','photon_test_status','arm_photon_test','reply_photon_test']
      .map(name=>({...rpc('tools/call'),params:{name,arguments:{}}})),
    ...['events/subscribe','events/unsubscribe'].flatMap(method=>['probe.created','photon.test.received']
      .map(name=>({...rpc(method),params:subscription(name)}))),
    {...rpc('tools/call'),params:{name:'arm_photon_test',arguments:{},requireSession:false,discovery:true}},
  ];
  for(const body of requests) {
    const result=await service.handle('POST','/mcp',h,body);
    assert.equal(result.status,503,body.method);
    assert.equal(result.body.result,undefined);
  }
  assert.equal((await service.handle('POST','/proof',h,{})).status,403);
}

test('expired startup permits only authenticated discovery with no callbacks or transport activity',async()=>{
  let starts=0,callbacks=0;
  const service=createService({...config,photonTransport:{start:async()=>{starts++;},stop:async()=>{}},
    postCallback:async()=>{callbacks++;throw Error('must not deliver');}});
  await expectDiscovery(service);
  await expectOperationsClosed(service);
  assert.equal((await service.handle('GET','/healthz',{},{})).body.mode,'disabled');
  assert.equal(starts,0);assert.equal(callbacks,0);await service.stop();
});

test('discovery survives process expiry while existing subscriptions and all operations stay closed',async()=>{
  let time=start,callbacks=0,starts=0;
  const service=createService({...config,expiresAt:new Date(start+1000).toISOString(),now:()=>time,
    photonTransport:{start:async()=>{starts++;},stop:async()=>{}},
    postCallback:async(_url,raw)=>{callbacks++;return {status:200,body:{challenge:JSON.parse(raw).challenge}};}});
  const subscribed=await service.handle('POST','/mcp',headers,{...rpc('events/subscribe'),params:subscription('photon.test.received')});
  assert.ok(subscribed.body.result);
  assert.equal(callbacks,1);
  time+=1000;
  await expectDiscovery(service);await expectOperationsClosed(service);
  assert.equal(callbacks,1);assert.equal(starts,0);
  assert.equal((await service.handle('GET','/healthz',{},{})).body.mode,'disabled');await service.stop();
});

test('every discovery method still verifies JWT and pinned owner, client and scope after expiry',async()=>{
  const service=createService(config);
  const invalid=[ [{},401], [{authorization:'Bearer public-invalid-fixture'},401],
    [await auth({sub:'google-oauth2|other'}),403],[await auth({client_id:'other'}),403],
    [await auth({scope:'quicksilver:probe-extra'}),403],[await auth({iss:'https://other.example/'}),401],
    [await auth({aud:'other'}),401],[await auth({exp:start/1000-1}),401],
    [await auth({iat:start/1000+1}),401],[await auth({exp:start/1000+3601}),401],
    [await auth({jti:undefined}),401],[await auth({client_id:undefined}),401],
    [await auth({},wrongKeys.privateKey),401],[await auth({},keys.privateKey,'JWT'),401] ];
  for(const [h,status] of invalid) for(const method of methods) {
    const result=await request(service,method,h);assert.equal(result.status,status,method);
    assert.equal(result.body.result,undefined);
  }
  await service.stop();
});

test('missing owner or client configuration never opens discovery even with a valid token',async()=>{
  for(const change of [{ownerSubject:undefined},{ownerSubject:'not-a-google-owner'},{clientId:''}]) {
    const service=createService({...config,...change});
    for(const method of methods) assert.equal((await request(service,method)).status,503);
    await service.stop();
  }
});

test('malformed discovery requests and non-POST paths cannot bypass an expired session',async()=>{
  const service=createService(config);
  const malformed=[null,[],[rpc('server/discover')],{},
    {method:'server/discover',id:1},{...rpc('server/discover'),jsonrpc:'1.0'},
    {jsonrpc:'2.0',method:'server/discover'}, {...rpc('server/discover'),id:{}},
    {...rpc('server/discover'),params:null},{...rpc('server/discover'),params:[]},
    {...rpc('server/discover'),params:'bad'},{...rpc('notifications/initialized'),id:1}];
  for(const body of malformed) {
    const result=await service.handle('POST','/mcp',headers,body);
    assert.equal(result.status,503);assert.equal(result.body.result,undefined);
    assert.equal((await service.handle('POST','/mcp',{},body)).status,401);
  }
  for(const method of ['GET','PUT','DELETE']) assert.equal((await service.handle(method,'/mcp',headers,rpc('server/discover'))).status,503);
  assert.equal((await service.handle('POST','/mcp/other',headers,rpc('server/discover'))).status,404);
  await service.stop();
});

test('expiry during awaited JWT key resolution closes operations but preserves authenticated discovery',async()=>{
  for(const method of ['server/discover','tools/call','events/subscribe']) {
    let time=start;
    const service=createService({...config,expiresAt:new Date(start+1000).toISOString(),now:()=>time,
      jwks:async(...args)=>{time=start+1000;return jwks(...args);}});
    assert.equal((await request(service,method)).status,method==='server/discover'?200:503);
    await expectDiscovery(service);await expectOperationsClosed(service);
    assert.equal((await service.handle('GET','/healthz',{},{})).body.mode,'disabled');await service.stop();
  }
});

test('production runtime with expired deadline discovers tools without constructing Photon',async()=>{
  let factories=0,callbacks=0;
  const env={QUICKSILVER_OWNER_SUBJECT:config.ownerSubject,QUICKSILVER_SESSION_EXPIRES_AT:config.expiresAt,
    PHOTON_OWNER_ADDRESS:'+13322179242',SPECTRUM_PROJECT_SECRET:'public-fixture'};
  const service=createRuntimeService(env,{now:()=>start,jwks,
    transportFactory:()=>{factories++;throw Error('must not construct');},
    postCallback:async()=>{callbacks++;throw Error('must not deliver');}});
  const h=await auth({},keys.privateKey,'at+jwt',{...config,
    issuer:'https://dev-ar7fhtveuwv8gobu.us.auth0.com/',resource:'https://quicksilver-kvt8.onrender.com/mcp',
    clientId:'tpc_caXSmFzUtRmg6MaouZ9Dij'});
  await expectDiscovery(service,h);await expectOperationsClosed(service,h);
  const health=(await service.handle('GET','/healthz',{},{})).body;
  assert.equal(health.mode,'disabled');assert.equal(health.photon,'disabled');
  assert.equal(factories,0);assert.equal(callbacks,0);await service.stop();
});
