import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import {createGrpcClient} from '@photon-ai/advanced-imessage/grpc';
import {createPhotonTransport} from './photon-transport.mjs';
import {createPhotonTest,PROJECT_ID} from './photon.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

// Real pinned SDK against loopback only: no provider credential or remote endpoint.
for(const heartbeat of [false,true])test(`real SDK remains connecting until activity; heartbeat=${heartbeat}`,{timeout:5000},async()=>{
 const entered=deferred(),observed=deferred(),terminated=deferred(),records=[];
 const config={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'};
 let serverCall,requests=0,published=0;
 const server=new grpc.Server();
 server.addService({subscribeMessageEvents:{path:'/photon.imessage.v1.MessageService/SubscribeMessageEvents',
  requestStream:false,responseStream:true,requestDeserialize:x=>x,responseSerialize:x=>x}},
  {subscribeMessageEvents(call){requests++;serverCall=call;
   assert.deepEqual(call.metadata.get('authorization'),['Bearer public-fixture']);
   assert.deepEqual(call.request,Buffer.concat([Buffer.from([10,Buffer.byteLength(config.dm)]),Buffer.from(config.dm)]));
   entered.resolve();}});
 const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(err,p)=>err?reject(err):resolve(p)));
 const expiresAt=new Date(Date.now()+60_000).toISOString();
 const transport=createPhotonTransport({config,projectSecret:'public-fixture',expiresAt,onDiagnostic:row=>records.push(row),
  sdkLoader:async()=>({issueTokens:async()=>({type:'shared',token:'public-fixture',expiresIn:3600}),
   createClient:options=>{
    assert.equal(options.address,'imessage.spectrum.photon.codes:443');assert.equal(options.tls,true);
    assert.equal(options.retry,false);assert.deepEqual(options.channelOptions,{'grpc.enable_retries':0});
    return createGrpcClient({...options,address:`127.0.0.1:${port}`,tls:false});
   }})});
 const controller=createPhotonTest({config,expiresAt,ready:()=>true,publish:async()=>{published++;return true;},
  transport:{stop:()=>transport.stop(),start:(receive,active,terminal,activity)=>transport.start(receive,active,
   reason=>{terminal(reason);terminated.resolve();},kind=>{activity(kind);observed.resolve();})}});
 const arm=()=>controller.call('arm_photon_test',{boot_id:controller.status().boot_id});
 try{
  assert.equal((await arm()).state,'connecting');assert.equal(requests,0);
  await entered.promise;assert.equal(controller.status().state,'connecting');
  if(heartbeat){serverCall.write(Buffer.from([0x9a,0x06,0]));await observed.promise;assert.equal(controller.status().state,'listening');}
  serverCall.emit('error',{code:grpc.status.UNAUTHENTICATED,details:'must-never-log'});
  await terminated.promise;
  assert.equal(controller.status().state,'transport_error');assert.equal((await arm()).state,'unavailable');
  assert.equal(requests,1);assert.equal(published,0);
  const failure=records.find(row=>row.category==='unauthenticated');
  assert.equal(failure.phase,'stream');assert.equal(failure.grpcCode,16);
  assert.equal(failure.heartbeatSeen,heartbeat);assert.equal(failure.eventSeen,false);
  assert.ok(Number.isSafeInteger(failure.elapsedMs));assert.ok(failure.elapsedMs>=0);
  assert.equal(JSON.stringify(records).includes('must-never-log'),false);
  assert.equal(JSON.stringify(records).includes('public-fixture'),false);
  assert.equal(JSON.stringify(records).includes(config.dm),false);
 }finally{await controller.stop();server.forceShutdown();}
});
