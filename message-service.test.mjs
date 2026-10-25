import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createService} from './service.mjs';
import {PROJECT_ID} from './photon.mjs';
import {restoreMessageBackup} from './message-backup.mjs';

const started=1800000000000;
const keys=await generateKeyPair('RS256');
const issuer='https://issuer.example/',resource='https://resource.example/mcp';
const owner='+15550000001',dm=`any;-;${owner}`;
const signingBytes=Buffer.alloc(32,7);
const config={issuer,resource,clientId:'messages-client',ownerSubject:'google-oauth2|owner',
  expiresAt:new Date(started+3600000).toISOString(),
  jwks:createLocalJWKSet({keys:[{...await exportJWK(keys.publicKey),kid:'messages'}]}),
  photon:{projectId:PROJECT_ID,ownerAddress:owner,line:'shared',dm}};
async function token(changes={}){
  const jwt=await new SignJWT({iss:issuer,aud:resource,sub:config.ownerSubject,client_id:config.clientId,
    scope:'quicksilver:messages',iat:started/1000,exp:started/1000+3600,jti:'fixture-messages',...changes})
    .setProtectedHeader({alg:'RS256',kid:'messages',typ:'at+jwt'}).sign(keys.privateKey);
  return {authorization:`Bearer ${jwt}`};
}
const headers=await token();
const rpc=(service,method,params,h=headers)=>service.handle('POST','/mcp',h,{jsonrpc:'2.0',id:1,method,params});
const call=async(service,name,args,h=headers)=>(await rpc(service,'tools/call',{name,arguments:args},h)).body.result;
const native=(guid='incoming-1',text='What is on my calendar?')=>({type:'message.received',isFromMe:false,chatGuid:dm,
  message:{guid,isFromMe:false,chatGuids:[dm],sender:{address:owner,service:'iMessage'},itemType:'normal',
    dateCreated:new Date(started-1000),content:{text,attachments:[]}}});
const reply=(request_id,response_id='answer',final=true)=>({request_id,response_id,text:'Your appointment is tomorrow.',final});
async function fixture(t,{post,send,lookup,ready}={}) {
  const dir=mkdtempSync(join(tmpdir(),'quicksilver-messages-'));
  let time=started;
  const services=[],events=[],sends=[];
  const open=()=>{
    const service=createService({...config,now:()=>time,
      messageHandling:{databasePath:join(dir,'messages.sqlite'),workerIntervalMs:0,sendTimeoutMs:30,
        provider:{ready,messages:{sendText:async(...args)=>{sends.push(args);return send?send(...args):{guid:'outgoing-1'};}}},lookup},
      postCallback:async(url,raw,h,options)=>{
        assert.equal(options.isActive(),true);
        assert.equal(h['webhook-signature'],'v1,'+createHmac('sha256',signingBytes).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${raw}`).digest('base64'));
        const body=JSON.parse(raw);
        if(body.type==='verification')return {status:200,body:{challenge:body.challenge}};
        events.push({body,headers:h});
        return post?post(body,service):{status:200,body:{}};
      }});
    services.push(service);return service;
  };
  t.after(async()=>{for(const service of services)await service.stop();rmSync(dir,{recursive:true,force:true});});
  const service=open();
  assert.equal(typeof service.receive,'function','general-text message service must be implemented');
  const sub=await rpc(service,'events/subscribe',{name:'photon.message.received',arguments:{session:'quicksilver'},
    delivery:{mode:'webhook',url:'https://callback.example.com/messages',secret:'whsec_'+signingBytes.toString('base64')}});
  assert.ok(sub.body.result,JSON.stringify(sub.body));
  return {service,open,events,sends,dir,databasePath:join(dir,'messages.sqlite'),advance:ms=>time+=ms};
}

test('general owner text travels through signed event, authenticated claim and bound durable reply',async t=>{
  const {service,events,sends}=await fixture(t);
  const incoming=service.receive(native(),'checkpoint-1');
  assert.equal(incoming.accepted,true);
  await service.flush();assert.equal(events.length,1);
  assert.deepEqual(events[0].body.data,{request_id:incoming.request_id});
  const claimed=(await call(service,'claim_message',{request_id:incoming.request_id})).structuredContent;
  assert.equal(claimed.acquired,true);assert.equal(claimed.text,'What is on my calendar?');
  const queued=(await call(service,'reply_message',reply(incoming.request_id))).structuredContent;
  assert.equal(queued.state,'queued');
  await Promise.all([service.flush(),service.flush()]);
  assert.equal(sends.length,1);assert.equal(sends[0][0],dm);assert.equal(sends[0][1],'Your appointment is tomorrow.');
  assert.equal(sends[0][2].replyTo,'incoming-1');assert.equal(sends[0][2].clientMessageId,queued.client_message_id);
  assert.equal(sends[0][2].enableLinkPreview,false);assert.equal(sends[0][2].enableDataDetection,false);
  const repeated=(await call(service,'reply_message',reply(incoming.request_id))).structuredContent;
  assert.equal(repeated.state,'provider_accepted');await service.flush();assert.equal(sends.length,1);
});

test('native filtering rejects groups, echoes, media, unrelated owners and malformed events',async t=>{
  const {service}=await fixture(t);
  const variants=[null,{},native(),native(),native(),native(),native(),native(),native(),native(),native(),native()];
  variants[2].chatGuid='different-chat';variants[3].message.chatGuids.push('another-chat');
  variants[4].message.isFromMe=true;variants[5].message.sender.address='+15550000002';
  variants[6].message.content.attachments=[{guid:'attachment'}];variants[7].message.content.miniApp={};
  variants[8].message.isSystemMessage=true;variants[9].message.partCount=2;
  variants[10].message.dateCreated=new Date(started+10000);variants[11].message.content.text='  ';
  for(const event of variants)assert.equal(service.receive(event).accepted,false);
  const status=(await call(service,'message_status',{})).structuredContent;
  assert.deepEqual(status.requests,[]);
  assert.equal(service.receive(native()).accepted,true);
});

test('MCP requires the pinned owner, client and messages scope; rejects recipient overrides',async t=>{
  const {service}=await fixture(t);
  const incoming=service.receive(native());
  for(const h of [{},await token({sub:'google-oauth2|other'}),await token({client_id:'other'}),await token({scope:'quicksilver:probe'})]){
    const result=await rpc(service,'tools/call',{name:'claim_message',arguments:{request_id:incoming.request_id}},h);
    assert.ok([401,403].includes(result.status));
  }
  assert.equal((await call(service,'claim_message',{request_id:incoming.request_id})).structuredContent.acquired,true);
  const result=await call(service,'reply_message',{...reply(incoming.request_id),recipient:'someone-else'});
  assert.equal(result.isError,true);
  const status=(await call(service,'message_status',{})).structuredContent;
  assert.equal(JSON.stringify(status).includes('What is on my calendar?'),false);
  assert.equal(JSON.stringify(status).includes(signingBytes.toString('base64')),false);
});

test('lost event acknowledgment after claim retries the same signed event without restarting work',async t=>{
  let first=true,claim;
  const {service,events,advance}=await fixture(t,{post:async(body,current)=>{
    if(first){first=false;claim=await call(current,'claim_message',{request_id:body.data.request_id});throw Error('private callback details');}
    return {status:200,body:{}};
  }});
  const {request_id}=service.receive(native());await service.flush();
  assert.equal(claim.structuredContent.acquired,true);
  advance(1001);await service.flush();
  assert.equal(events.length,2);assert.equal(events[0].body.eventId,events[1].body.eventId);
  assert.equal(events[0].body.timestamp,events[1].body.timestamp);
  assert.notEqual(events[0].headers['webhook-timestamp'],events[1].headers['webhook-timestamp']);
  assert.equal((await call(service,'claim_message',{request_id})).structuredContent.acquired,false);
  const status=(await call(service,'message_status',{})).structuredContent.requests[0];
  assert.equal(status.execution,'claimed');assert.equal(status.event,'acknowledged');
});

test('restart preserves subscription, duplicates, queued replies and final closure',async t=>{
  const {service,open,sends,events}=await fixture(t);
  const {request_id}=service.receive(native());
  await call(service,'claim_message',{request_id});await call(service,'reply_message',reply(request_id));
  await service.stop();const restart=open();
  assert.equal(restart.receive(native()).duplicate,true);
  await restart.flush();assert.equal(events.length,1);assert.equal(sends.length,1);
  assert.equal((await call(restart,'claim_message',{request_id})).structuredContent.acquired,false);
  assert.equal((await call(restart,'reply_message',reply(request_id,'second'))).isError,true);
});

test('a timed-out progress send blocks its final reply and late acceptance never triggers a resend',async t=>{
  let finish;
  const {service,sends}=await fixture(t,{send:()=>new Promise(resolve=>{finish=resolve;})});
  const {request_id}=service.receive(native());await call(service,'claim_message',{request_id});
  await call(service,'reply_message',reply(request_id,'progress',false));await call(service,'reply_message',reply(request_id));
  await service.flush();assert.equal(sends.length,1);
  let state=(await call(service,'message_status',{})).structuredContent.requests[0];
  assert.equal(state.state,'stalled');assert.equal(state.replies[0].state,'unknown_outcome');
  assert.equal(state.replies[1].state,'queued');
  finish({guid:'late-provider-id'});await service.flush();assert.equal(sends.length,1);
  state=(await call(service,'message_status',{})).structuredContent.requests[0];
  assert.equal(state.replies[0].state,'unknown_outcome');
});

test('lookup resolves only a verified matching identifier; not-found never authorizes retry',async t=>{
  let mode='not-found';
  const {service,sends}=await fixture(t,{send:async()=>{throw Error('private provider error');},
    lookup:{verified:true,findByClientMessageId:async id=>mode==='found'?{clientMessageId:id,guid:'verified-guid'}:mode==='mismatch'?{clientMessageId:'other',guid:'wrong-guid'}:null}});
  const {request_id}=service.receive(native());await call(service,'claim_message',{request_id});
  await call(service,'reply_message',reply(request_id));await service.flush();
  await service.reconcile();assert.equal(sends.length,1);
  mode='mismatch';await service.reconcile();
  assert.equal((await call(service,'message_status',{})).structuredContent.requests[0].state,'stalled');
  mode='found';await service.reconcile();
  assert.equal((await call(service,'message_status',{})).structuredContent.requests[0].replies[0].state,'provider_accepted');
  await service.flush();assert.equal(sends.length,1);
});

test('expiration during authentication prevents mutations and stops ingestion/workers',async t=>{
  const {service,advance,sends}=await fixture(t);
  const {request_id}=service.receive(native());await call(service,'claim_message',{request_id});
  await call(service,'reply_message',reply(request_id));advance(3600001);
  assert.equal(service.receive(native('later')).accepted,false);await service.flush();assert.equal(sends.length,0);
  const result=await rpc(service,'tools/call',{name:'message_status',arguments:{}});
  assert.ok([401,503].includes(result.status));
});


test('pause drains an in-flight send, blocks subsequent work and survives service restart',async t=>{
  let finish,startedSend;const sending=new Promise(resolve=>{startedSend=resolve;});
  const {service,open,sends}=await fixture(t,{send:()=>{startedSend();return new Promise(resolve=>{finish=resolve;});}});
  const {request_id}=service.receive(native());await call(service,'claim_message',{request_id});
  await call(service,'reply_message',reply(request_id,'progress',false));await call(service,'reply_message',reply(request_id));
  const flushing=service.flush();await sending;
  assert.equal(typeof service.pause,'function');const paused=service.pause();
  assert.equal(service.receive(native('next')).accepted,false);
  finish({guid:'progress-accepted'});await paused;await flushing;
  assert.equal(sends.length,1);
  const status=(await call(service,'message_status',{})).structuredContent;
  assert.equal(status.operations.paused,true);assert.equal(status.requests[0].replies[1].state,'queued');
  assert.equal((await call(service,'reply_message',reply(request_id))).structuredContent.reason,'paused');
  assert.equal((await rpc(service,'tools/call',{name:'resume_messages',arguments:{ownerVerified:true}})).body.error.code,-32602);
  await service.stop();const restarted=open();assert.equal(restarted.inspect().operations.paused,true);
  await restarted.flush();assert.equal(sends.length,1);
  assert.equal((await restarted.handle('GET','/healthz',{},{})).body.mode,'paused');
});

test('restore boundary rejects absent post-snapshot work and waits for fresh subscription',async t=>{
  const {service,sends,dir}=await fixture(t);
  assert.equal(typeof service.backup,'function');await service.pause();
  const backupPath=join(dir,'snapshot.qsb'),key=Buffer.alloc(32,19);service.backup({path:backupPath,key});
  service.resume({ownerVerified:true});
  const {request_id}=service.receive(native('after-snapshot','Do something once.'));
  await call(service,'claim_message',{request_id});await call(service,'reply_message',reply(request_id));await service.flush();
  assert.equal(sends.length,1);await service.stop();
  // Restore to a fresh path, then move the fixture's trusted configuration to it.
  const target=join(dir,'restored.sqlite');restoreMessageBackup({path:backupPath,databasePath:target,key,
    identity:{...config.photon,issuer,clientId:config.clientId,subject:config.ownerSubject},now:()=>started+1000});
  let restorationTime=started+2000;
  const restoredConfig={...config,now:()=>restorationTime,messageHandling:{databasePath:target,workerIntervalMs:0,
    provider:{messages:{sendText:async()=>{throw Error('must not send restored work');}}}}};
  const restored=createService(restoredConfig);
  t.after(()=>restored.stop());assert.equal(restored.inspect().operations.restore_required,true);
  assert.throws(()=>restored.resume({ownerVerified:true}),{code:'restore_reconciliation_required'});
  restored.completeRestore({ownerVerified:true,intakeAfter:started+2000});restored.resume({ownerVerified:true});
  assert.equal(restored.receive(native('after-snapshot','Do something once.')).reason,'restore_gap');
  const fresh=native('new-message');fresh.message.dateCreated=new Date(started+2000);
  assert.equal(restored.receive(fresh).accepted,false); // Inclusive boundary.
  await restored.flush();assert.equal(sends.length,1);
  assert.equal(restored.inspect().operations.ingest_after,started+2000);
  restorationTime++;fresh.message.dateCreated=new Date(restorationTime);
  const accepted=restored.receive(fresh);assert.equal(accepted.accepted,true);
  await restored.flush();assert.equal(restored.inspect().requests[0].event,'pending');
  await restored.stop();const again=createService(restoredConfig);t.after(()=>again.stop());
  assert.equal(again.receive(native('after-snapshot')).reason,'restore_gap');
  assert.equal(again.inspect().operations.ingest_after,started+2000);
});

const resubscribe=(service,cursor)=>rpc(service,'events/subscribe',{name:'photon.message.received',arguments:{session:'quicksilver'},cursor,
 delivery:{mode:'webhook',url:'https://callback.example.com/messages',secret:'whsec_'+signingBytes.toString('base64')}});

test('authenticated refresh replays after a saved cursor with stable ids and no second claim or send',async t=>{
 const {service,events,sends,open}=await fixture(t);
 const subscription=await resubscribe(service,null);const cursor=subscription.body.result.cursor;
 assert.equal(typeof cursor,'string');const {request_id}=service.receive(native());await service.flush();
 assert.equal(events[0].body.cursor,cursor);
 await call(service,'claim_message',{request_id});await call(service,'reply_message',reply(request_id));await service.flush();
 await service.stop();const restarted=open();
 const resumed=await resubscribe(restarted,cursor);assert.equal(resumed.body.result.truncated,false);await restarted.flush();
 assert.equal(events.length,2);assert.equal(events[1].body.eventId,events[0].body.eventId);
 assert.equal((await call(restarted,'claim_message',{request_id})).structuredContent.acquired,false);
 await restarted.flush();assert.equal(sends.length,1);
});

test('refresh during callback delivery fences the old acknowledgment without losing replay',async t=>{
 let release,startedDelivery;const entered=new Promise(resolve=>startedDelivery=resolve);let first=true;
 const {service,events}=await fixture(t,{post:()=>{
  if(first){first=false;startedDelivery();return new Promise(resolve=>release=resolve);}
  return {status:200,body:{}};
 }});
 const cursor=(await resubscribe(service,null)).body.result.cursor;assert.equal(typeof cursor,'string');
 service.receive(native());const flushing=service.flush();await entered;
 assert.ok((await resubscribe(service,cursor)).body.result);release({status:200,body:{}});await flushing;
 await service.flush();assert.equal(events.length,2);assert.equal(events[0].body.eventId,events[1].body.eventId);
});

test('invalid cursors are rejected before challenge and do not change active subscription',async t=>{
 const {service,events}=await fixture(t);
 assert.equal((await resubscribe(service,'invalid')).body.error.code,-32602);
 const result=await resubscribe(service,null);assert.equal(typeof result.body.result.cursor,'string');
 service.receive(native());await service.flush();assert.equal(events.length,1);
});

test('recovery identity persists across restart and changes on restored message generation',async t=>{
 const {service,open,dir}=await fixture(t);assert.equal(typeof service.recoveryIdentity,'function');
 const original=service.recoveryIdentity();assert.equal(original.identity.dm,dm);
 await service.pause();const path=join(dir,'recovery.qsb'),key=Buffer.alloc(32,27);service.backup({path,key});
 await service.stop();const restarted=open();assert.deepEqual(restarted.recoveryIdentity(),original);await restarted.stop();
 const target=join(dir,'recovery.sqlite');restoreMessageBackup({path,databasePath:target,key,identity:original.identity,now:()=>started+1000});
 const restored=createService({...config,now:()=>started+1000,messageHandling:{databasePath:target,workerIntervalMs:0,provider:{messages:{sendText:async()=>{throw Error('unexpected send');}}}}});
 t.after(()=>restored.stop());assert.notEqual(restored.recoveryIdentity().messageStoreId,original.messageStoreId);
});


test('disconnected provider leaves replies queued without reserving an uncertain send',async t=>{
 let connected=false;const {service,sends}=await fixture(t,{ready:()=>connected});
 const {request_id}=service.receive(native());await call(service,'claim_message',{request_id});
 await call(service,'reply_message',reply(request_id));await service.flush();
 assert.equal(sends.length,0);assert.equal(service.inspect().requests[0].replies[0].state,'queued');
 assert.equal(service.inspect().requests[0].replies[0].attempts,0);
 connected=true;await service.flush();assert.equal(sends.length,1);
});
