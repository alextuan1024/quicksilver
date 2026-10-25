import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '@grpc/grpc-js';
import {createGrpcClient} from '@photon-ai/advanced-imessage/grpc';
import {spawnSync} from 'node:child_process';
const module=await import('./photon-live-adapter.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const route={projectId:'fixture-project',ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'};
const token={type:'shared',token:'public-fixture-token',expiresIn:3600};
const replyOptions={replyTo:'received-guid',clientMessageId:'stable-reply-id',enableLinkPreview:false,enableDataDetection:false};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup({issue,send,source,now,create}={}){
 assert.equal(typeof module.createPhotonLiveAdapter,'function','live SDK adapter must be implemented');
 const abort=new AbortController();let config,filter,closes=0,streamCloses=0,issues=0,sends=0,active=true;
 const waiting=deferred();
 source??={ [Symbol.asyncIterator](){return this;},next:()=>waiting.promise,close(){streamCloses++;waiting.resolve({done:true});} };
 const adapter=module.createPhotonLiveAdapter({route,projectSecret:'public-fixture-secret',now,
  sdkLoader:async()=>({issueTokens:async(id,secret)=>{issues++;assert.equal(id,route.projectId);assert.equal(secret,'public-fixture-secret');return issue?issue():token;},
  createClient:options=>{config=options;create?.();return {close(){closes++;},messages:{subscribeEvents:f=>{filter=f;return source;},sendText:async(...args)=>{sends++;return send?send(...args):{guid:'sent-guid'};}}};}})});
 return {adapter,abort,open:()=>adapter.open({signal:abort.signal,isActive:()=>active}),setActive:value=>active=value,counts:()=>({config,filter,closes,streamCloses,issues,sends})};
}
test('live adapter opens only exact chat with pinned secure no-retry SDK settings',async()=>{
 const f=setup(),s=await f.open();try{assert.deepEqual(f.counts().filter,{chat:route.dm});const c=f.counts().config;
 assert.equal(c.address,'imessage.spectrum.photon.codes:443');assert.equal(c.tls,true);assert.equal(c.retry,false);assert.equal(c.channelOptions['grpc.enable_retries'],0);assert.equal(c.timeout,5000);assert.equal(c.token,'public-fixture-token');
 assert.equal((await s.sendText(route.dm,'answer',replyOptions)).guid,'sent-guid');assert.equal(f.counts().sends,1);
 }finally{await s.close();await s.close();}assert.equal(f.counts().closes,1);assert.equal(f.counts().streamCloses,1);
});
test('send API rejects another chat, missing request IDs and extra send capabilities before RPC',async()=>{
 const f=setup(),s=await f.open();try{
 for(const [dm,text,options] of [['unrelated','answer',replyOptions],[route.dm,'answer',{}],[route.dm,'answer',{...replyOptions,attachments:['x']}],[route.dm,'answer',{...replyOptions,enableLinkPreview:true}],[route.dm,' ',replyOptions]])await assert.rejects(s.sendText(dm,text,options),{code:'photon_scope_failed'});
 assert.equal(f.counts().sends,0);
 }finally{await s.close();}
});
test('authentication and permission failures expose fixed terminal codes without raw detail',async()=>{
 for(const error of [{status:401,message:'secret upstream'},{status:403},{grpcCode:7},{grpcCode:16},{code:16}]){
 const f=setup({issue:()=>{throw error;}});await assert.rejects(f.open(),e=>e.code==='photon_auth_failed'&&!String(e).includes('secret'));assert.equal(f.counts().config,undefined);
 }
 const f=setup({issue:()=>{throw Error('private upstream');}});await assert.rejects(f.open(),{code:'photon_transport_failed'});
});
test('inactive or aborted token acquisition cannot create a client from a late result',async()=>{
 const pending=deferred(),entered=deferred();const f=setup({issue:()=>{entered.resolve();return pending.promise;}});const opening=f.open();await entered.promise;f.abort.abort();await assert.rejects(opening,{code:'photon_inactive'});pending.resolve(token);await new Promise(r=>setImmediate(r));assert.equal(f.counts().config,undefined);
 const inactive=setup();inactive.setActive(false);await assert.rejects(inactive.open(),{code:'photon_inactive'});assert.equal(inactive.counts().issues,0);
});
test('token expiry fences sends even if a host rotation timer is delayed',async()=>{
 let time=1700000000000;const f=setup({now:()=>time}),s=await f.open();time=s.expiresAt;await assert.rejects(s.sendText(route.dm,'answer',replyOptions),{code:'photon_inactive'});assert.equal(f.counts().sends,0);await s.close();
});
test('session close rejects an in-flight send even after its late success',async()=>{
 const pending=deferred(),entered=deferred();const f=setup({send:()=>{entered.resolve();return pending.promise;}}),s=await f.open();const sending=s.sendText(route.dm,'answer',replyOptions);await entered.promise;await s.close();await assert.rejects(sending,{code:'photon_inactive'});pending.resolve({guid:'late'});assert.equal(f.counts().sends,1);
});
test('exact route mismatch from refreshed token data fails closed',async()=>{
 const f=setup({issue:()=>({type:'dedicated',numbers:{wrong:'+15550000002'},auth:{wrong:'fixture'},expiresIn:3600})});await assert.rejects(f.open(),{code:'photon_scope_failed'});assert.equal(f.counts().config,undefined);
});

for(const outcome of ['retryable','auth','pending'])test(`real pinned SDK sends exact scoped RPCs and cancels without retry: ${outcome}`,{timeout:5000},async()=>{
 const entered=deferred(),heartbeat=deferred(),sent=deferred(),cancelled=deferred();let streamCall,sends=0,subscriptions=0;const server=new grpc.Server();
 const streamMethod={path:'/photon.imessage.v1.MessageService/SubscribeMessageEvents',requestStream:false,responseStream:true,requestDeserialize:x=>x,responseSerialize:x=>x};
 const sendMethod={path:'/photon.imessage.v1.MessageService/SendTextMessage',requestStream:false,responseStream:false,requestDeserialize:x=>x,responseSerialize:x=>x};
 const stringField=(tag,value)=>Buffer.concat([Buffer.from([...tag,Buffer.byteLength(value)]),Buffer.from(value)]);
 server.addService({subscribeMessageEvents:streamMethod,sendTextMessage:sendMethod},{
  subscribeMessageEvents(call){subscriptions++;streamCall=call;assert.deepEqual(call.request,stringField([10],route.dm));assert.deepEqual(call.metadata.get('authorization'),['Bearer public-fixture-token']);call.on('cancelled',()=>cancelled.resolve());entered.resolve();},
  sendTextMessage(call,callback){sends++;assert.deepEqual(call.metadata.get('authorization'),['Bearer public-fixture-token']);assert.ok(call.metadata.get('x-idempotency-key')[0]);
   const target=stringField([10],'received-guid');
   assert.deepEqual(call.request,Buffer.concat([stringField([10],route.dm),stringField([18],'answer'),Buffer.from([26,target.length]),target,Buffer.from([48,0,56,0]),stringField([0xa2,0x06],'stable-reply-id')]));sent.resolve();
   if(outcome!=='pending'){const metadata=new grpc.Metadata();metadata.set('x-retryable','true');callback({code:outcome==='auth'?grpc.status.PERMISSION_DENIED:grpc.status.UNAVAILABLE,details:'private fixture error',metadata});}
  },
 });
 const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
 const adapter=module.createPhotonLiveAdapter({route,projectSecret:'public-fixture-secret',sdkLoader:async()=>({issueTokens:async()=>token,createClient:options=>{
  assert.equal(options.address,'imessage.spectrum.photon.codes:443');assert.equal(options.tls,true);assert.equal(options.retry,false);assert.equal(options.channelOptions['grpc.enable_retries'],0);
  return createGrpcClient({...options,address:`127.0.0.1:${port}`,tls:false});}})});
 let session;
 try{
  session=await adapter.open({isActive:()=>true,onActivity:kind=>{if(kind==='heartbeat')heartbeat.resolve();}});
  const reading=session.live[Symbol.asyncIterator]().next().catch(e=>e);await entered.promise;streamCall.write(Buffer.from([0x9a,0x06,0]));await heartbeat.promise;
  const sending=session.sendText(route.dm,'answer',replyOptions);const rejection=assert.rejects(sending,e=>e.code===(outcome==='pending'?'photon_inactive':outcome==='auth'?'photon_auth_failed':'photon_transport_failed')&&!String(e).includes('private'));
  await sent.promise;if(outcome==='pending')await session.close();await rejection;await cancelled.promise;await reading;
  assert.equal(sends,1);assert.equal(subscriptions,1);
 }finally{await session?.close();server.forceShutdown();}
});

test('real cloud helper exchanges only the pinned project at official origin with fixture fetch',()=>{
 const child=`import assert from 'node:assert/strict';import {createPhotonLiveAdapter} from './photon-live-adapter.mjs';
 globalThis.fetch=async(url,init)=>{assert.equal(url,'https://spectrum.photon.codes/projects/fixture-project/imessage/tokens');assert.equal(init.method,'POST');assert.equal(init.body,undefined);assert.equal(new Headers(init.headers).get('authorization'),'Basic '+Buffer.from('fixture-project:public-fixture-secret').toString('base64'));return new Response(JSON.stringify({code:'UNAUTHORIZED',message:'must not escape'}),{status:401});};
 const adapter=createPhotonLiveAdapter({route:${JSON.stringify(route)},projectSecret:'public-fixture-secret'});
 await assert.rejects(adapter.open({isActive:()=>true}),{code:'photon_auth_failed'});process.stdout.write('verified');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),encoding:'utf8',timeout:5000,env:{...process.env,SPECTRUM_CLOUD_URL:'https://spectrum.photon.codes'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'verified');assert.equal(r.stderr.includes('must not escape'),false);
});

test('official loader rejects a cloud-origin override before issuing credentials',()=>{
 const child=`import assert from 'node:assert/strict';import {createPhotonLiveAdapter} from './photon-live-adapter.mjs';let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected fetch');};
 const adapter=createPhotonLiveAdapter({route:${JSON.stringify(route)},projectSecret:'public-fixture-secret'});
 await assert.rejects(adapter.open({isActive:()=>true}),{code:'photon_scope_failed'});assert.equal(calls,0);process.stdout.write('verified');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',child],{cwd:process.cwd(),encoding:'utf8',timeout:5000,env:{...process.env,SPECTRUM_CLOUD_URL:'https://untrusted.example'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'verified');
});

test('stream authentication errors are sanitized before reaching the lifecycle controller',async()=>{
 const f=setup({source:{async *[Symbol.asyncIterator](){throw {grpcCode:16,message:'private stream payload'};},close(){}}}),s=await f.open();
 await assert.rejects(s.live[Symbol.asyncIterator]().next(),e=>e.code==='photon_auth_failed'&&!String(e).includes('private'));assert.equal(f.counts().closes,1);
});

test('token deadline discards late success and close is bounded for an uncooperative fixture',async()=>{
 const pending=deferred();let created=0;
 const adapter=module.createPhotonLiveAdapter({route,projectSecret:'public-fixture-secret',operationTimeoutMs:10,sdkLoader:async()=>({issueTokens:()=>pending.promise,createClient(){created++;}})});
 await assert.rejects(adapter.open({isActive:()=>true}),{code:'photon_transport_failed'});pending.resolve(token);await new Promise(r=>setImmediate(r));assert.equal(created,0);
 const stuck=module.createPhotonLiveAdapter({route,projectSecret:'public-fixture-secret',operationTimeoutMs:10,sdkLoader:async()=>({issueTokens:async()=>token,createClient:()=>({close:()=>new Promise(()=>{}),messages:{subscribeEvents:()=>({close:()=>new Promise(()=>{}),async *[Symbol.asyncIterator](){}})}})})});
 const s=await stuck.open({isActive:()=>true});await s.close();await assert.rejects(s.sendText(route.dm,'answer',replyOptions),{code:'photon_inactive'});
});
