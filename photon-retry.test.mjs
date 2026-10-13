import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import {createGrpcClient} from '@photon-ai/advanced-imessage/grpc';

// Real pinned SDK against a loopback fake RPC server. No Photon endpoint/token.
for (const scenario of [
 {name:'marked trailer with pinned middleware ordering',marked:true,retry:{maxAttempts:4,initialDelay:0,maxDelay:0},expected:1},
 {name:'unmarked unavailable after handler entry',marked:false,retry:true,expected:1},
 {name:'retry disabled despite retryable trailer',marked:true,retry:false,expected:1},
]) test(`original SDK retry semantics: ${scenario.name}`,async()=>{
 const attempts=[];const server=new grpc.Server();
 const method={path:'/photon.imessage.v1.MessageService/SendTextMessage',requestStream:false,responseStream:false,
  requestDeserialize:x=>x,responseSerialize:x=>x};
 server.addService({sendTextMessage:method},{sendTextMessage(call,callback){
  attempts.push({key:call.metadata.get('x-idempotency-key')[0],request:call.request});
  const metadata=new grpc.Metadata();if(scenario.marked)metadata.set('x-retryable','true');
  callback({code:grpc.status.UNAVAILABLE,details:'public fixture error',metadata});
 }});
 const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(error,port)=>error?reject(error):resolve(port)));
 const client=createGrpcClient({address:`127.0.0.1:${port}`,token:'public-fixture',tls:false,
  autoIdempotency:true,retry:scenario.retry,timeout:2000,channelOptions:{'grpc.enable_retries':0}});
 try{
  await assert.rejects(client.messages.sendText('any;-;+15550000001','public test',{clientMessageId:'fixture-logical-write'}),error=>{assert.equal(error.retryable,scenario.marked);return true;});
  assert.equal(attempts.length,scenario.expected);
  assert.equal(new Set(attempts.map(a=>a.key)).size,1);assert.ok(attempts[0].key);
  assert.ok(attempts.every(a=>a.request.equals(attempts[0].request)));
 }finally{await client.close();server.forceShutdown();}
});
