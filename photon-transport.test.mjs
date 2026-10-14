import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotonTransport,selectLine,PHOTON_LIVE_TRANSPORT_ALLOWED} from './photon-transport.mjs';
import {PROJECT_ID,INCOMING_TEXT,REPLY_TEXT} from './photon.mjs';
const time=1_800_000_000_000;
const config={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'};
const tokenData={type:'shared',token:'public-fixture',expiresIn:3600};
function incoming(){return {type:'message.received',isFromMe:false,chatGuid:config.dm,message:{guid:'fixture-guid',chatGuids:[config.dm],
 sender:{address:config.ownerAddress,service:'iMessage'},dateCreated:new Date(time),isFromMe:false,itemType:'normal',
 content:{text:INCOMING_TEXT,attachments:[],formatting:[],mentions:[]},partCount:1}};}
function setup({events=[incoming()],send,issue,create}={}) {
 let options,filter,issues=0,sends=0,closed=0,reads=0;const records=[];
 const transport=createPhotonTransport({config,projectSecret:'public-fixture',expiresAt:new Date(time+60_000).toISOString(),now:()=>time,
  sdkLoader:async()=>({issueTokens:async(id,secret)=>{issues++;assert.equal(id,PROJECT_ID);assert.equal(secret,'public-fixture');return issue?issue():tokenData;},
  createClient:opts=>{options=opts;create?.();return {close:async()=>{closed++;},messages:{
   subscribeEvents:arg=>{filter=arg;return {async *[Symbol.asyncIterator](){for(const event of events){reads++;yield event;}},close:async()=>{}};},
   sendText:async(...args)=>{sends++;records.push(args);return send?send():{guid:'outbound'};}}};}})});
 return {transport,records,get:()=>({options,filter,issues,sends,closed,reads})};
}
test('reviewed source unlock still rejects inactive start before token exchange',async()=>{
 assert.equal(PHOTON_LIVE_TRANSPORT_ALLOWED,true);
 let loads=0;
 await assert.rejects(createPhotonTransport({config,projectSecret:'public-fixture',expiresAt:new Date(time+60_000).toISOString(),now:()=>time,
  sdkLoader:async()=>{loads++;throw Error('fixture loader must not run');}}).start(()=>{},()=>false),/transport_unavailable/);
 assert.equal(loads,0);
});
test('supported direct client is TLS, no retries, no account/profile APIs; exact chat subscription',async()=>{
 const f=setup();let reply;
 await f.transport.start(async(space,message)=>{assert.equal(space.id,config.dm);reply=message.reply;await reply(REPLY_TEXT);});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.get().filter,{chat:config.dm});
 assert.equal(f.get().options.retry,false);assert.equal(f.get().options.autoIdempotency,true);assert.equal(f.get().options.tls,true);
 assert.deepEqual(f.get().options.channelOptions,{'grpc.enable_retries':0});assert.equal(f.get().options.timeout,5000);
 assert.equal(f.get().options.address,'imessage.spectrum.photon.codes:443');
 assert.equal(f.records[0][0],config.dm);assert.equal(f.records[0][1],REPLY_TEXT);assert.equal(f.records[0][2].replyTo,'fixture-guid');
 assert.equal(f.records[0][2].enableLinkPreview,false);assert.equal(f.records[0][2].enableDataDetection,false);assert.ok(f.records[0][2].clientMessageId);
 await assert.rejects(reply(REPLY_TEXT));assert.equal(f.get().sends,1);assert.equal(f.get().issues,1);
});
test('unknown send is spent and fixed target cannot be mutated after capture',async()=>{
 const event=incoming();const f=setup({events:[event],send:()=>{throw Error('fixture');}});
 await f.transport.start(async(space,message)=>{
  event.chatGuid='any;-;+15550000002';event.message.guid='other';space.id='other';
  await assert.rejects(message.reply('arbitrary'));await assert.rejects(message.reply(REPLY_TEXT));
  await assert.rejects(message.reply(REPLY_TEXT));
 });await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.get().sends,1);assert.equal(f.records[0][0],config.dm);assert.equal(f.records[0][2].replyTo,'fixture-guid');
});
test('reject other DM, group, sender, echo, attachment, synthetic events and stale data before callback',async()=>{
 const changes=[e=>e.chatGuid='any;+;group',e=>e.message.chatGuids.push('any;+;group'),e=>e.message.sender.address='+15550000002',
  e=>e.message.sender.service='SMS',e=>e.message.isFromMe=true,e=>e.isFromMe=true,e=>delete e.isFromMe,e=>e.type='message.edited',e=>e.message.content.attachments=[{}],
  e=>e.message.isAutoReply=true,e=>e.message.isSystemMessage=true,e=>e.message.partCount=2,e=>e.message.content.text='other',
  e=>e.message.dateCreated=new Date(0),e=>e.message.itemType='chatAction',e=>e.message.content.miniApp={}];
 const f=setup({events:changes.map(change=>{const e=incoming();change(e);return e;})});let callbacks=0;
 await f.transport.start(()=>{callbacks++;});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(callbacks,0);assert.equal(f.get().sends,0);
});
test('line selection refuses ambiguous/mismatched routes and never accepts arbitrary endpoint',()=>{
 assert.equal(selectLine(tokenData,'shared').phone,'shared');assert.throws(()=>selectLine(tokenData,'+15550000002'));
 const dedicated={type:'dedicated',auth:{'line-a':'public-fixture'},numbers:{'line-a':'+15550000002'},expiresIn:3600};
 assert.equal(selectLine(dedicated,'+15550000002').address,'line-a.imsg.photon.codes:443');
 assert.throws(()=>selectLine({...dedicated,auth:{'evil.example/':'fixture'},numbers:{'evil.example/':'+15550000002'}},'+15550000002'));
 assert.throws(()=>selectLine({...dedicated,auth:{'line-a':'fixture','line-b':'fixture'},numbers:{'line-a':'+15550000002','line-b':'+15550000002'}},'+15550000002'));
});
test('stop during token exchange and expired token never open a client',async()=>{
 let finish;const f=setup({issue:()=>new Promise(resolve=>{finish=resolve;})});
 const start=f.transport.start(()=>{});await new Promise(resolve=>setImmediate(resolve));await f.transport.stop();finish(tokenData);await start;
 assert.equal(f.get().options,undefined);
 const expired=setup({issue:()=>({...tokenData,expiresIn:1})});await assert.rejects(expired.transport.start(()=>{}));assert.equal(expired.get().options,undefined);
});

test('duplicate incoming frames cannot bind a second reply or start a second subscription',async()=>{
 const f=setup({events:[incoming(),incoming()]});let callbacks=0;
 await f.transport.start(async(space,message)=>{callbacks++;await message.reply(REPLY_TEXT);});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(callbacks,1);assert.equal(f.get().sends,1);assert.equal(f.get().issues,1);
 await assert.rejects(f.transport.start(()=>{}),/transport_unavailable/);
});
