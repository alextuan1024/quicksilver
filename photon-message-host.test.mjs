import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {oauthFixture} from './test-support/oauth-fixture.mjs';
import {PROJECT_ID} from './photon.mjs';
const module=await import('./photon-message-host.mjs').catch(()=>({}));
const owner='+15550000001',dm=`any;-;${owner}`;
const wait=async check=>{for(let i=0;i<400;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('condition not reached');};
function source(){let pending,queue=[],closed=false;return {push(event){if(pending){const p=pending;pending=null;p({value:event,done:false});}else queue.push(event);},close(){closed=true;pending?.({done:true});pending=null;},[Symbol.asyncIterator](){return this;},next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(closed)return Promise.resolve({done:true});return new Promise(r=>pending=r);}};}
const native=guid=>({type:'message.received',sequence:500,chatGuid:dm,isFromMe:false,message:{guid,chatGuids:[dm],isFromMe:false,sender:{address:owner,service:'iMessage'},itemType:'normal',dateCreated:new Date(),content:{text:'one request',attachments:[]}}});
async function setup(t,{ambiguous=false}={}){
 assert.equal(typeof module.createPhotonMessageHost,'function');let issues=0,sends=0;const streams=[];
 const f=await oauthFixture(t,localOAuth=>module.createPhotonMessageHost({localOAuth,expiresAt:localOAuth.expiresAt,
  photon:{projectId:PROJECT_ID,ownerAddress:owner,line:'shared',dm},photonProjectSecret:'fixture-project-secret',
  photonLive:{controller:{retryDelaysMs:[5,5],activityPollMs:5},sdkLoader:async()=>({
    issueTokens:async()=>{issues++;return {type:'shared',token:'fixture-token',expiresIn:3600};},
    createClient:()=>{const stream=source();streams.push(stream);return {close:()=>stream.close(),messages:{
      subscribeEvents:arg=>{assert.deepEqual(arg,{chat:dm});return stream;},sendText:async()=>{sends++;if(ambiguous){stream.close();throw Error('private provider detail');}return {guid:'sent'};}}};}})},
  messageHandling:{databasePath:join(dirname(localOAuth.databasePath),'messages.sqlite'),workerIntervalMs:0,sendTimeoutMs:50}}));
 return {...f,get host(){return f.auth;},streams,stats:()=>({issues,sends})};
}
const call=async(f,token,name,args)=>(await f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`},json:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}})).body.result.structuredContent;

test('explicit host start reconnects new live events and restart preserves duplicate claims and sends',async t=>{
 const f=await setup(t);assert.equal(f.stats().issues,0);assert.equal(f.host.transportStatus().state,'idle');
 const {code}=await f.login(),tokens=(await f.exchange(code)).body;
 f.host.start();await wait(()=>f.streams.length===1);f.streams[0].push(native('one'));
 await wait(()=>f.host.messages.inspect().requests.length===1);const request_id=f.host.messages.inspect().requests[0].request_id;
 assert.equal((await call(f,tokens.access_token,'claim_message',{request_id})).acquired,true);
 await call(f,tokens.access_token,'reply_message',{request_id,response_id:'answer',text:'reply',final:true});await f.host.messages.flush();
 assert.equal(f.stats().sends,1);f.streams[0].close();await wait(()=>f.streams.length===2);
 f.streams[1].push(native('one'));f.streams[1].push(native('two'));await wait(()=>f.host.messages.inspect().requests.length===2);
 await f.restart();assert.equal(f.host.transportStatus().state,'idle');f.host.start();await wait(()=>f.streams.length===3);
 f.streams[2].push(native('one'));await wait(()=>f.host.transportStatus().state==='listening');
 assert.equal((await call(f,tokens.access_token,'claim_message',{request_id})).acquired,false);
 await f.host.messages.flush();assert.equal(f.stats().sends,1);
});
test('stream loss during a reserved reply remains unknown across reconnect and never resends',async t=>{
 const f=await setup(t,{ambiguous:true});const {code}=await f.login(),tokens=(await f.exchange(code)).body;
 f.host.start();await wait(()=>f.streams.length===1);f.streams[0].push(native('one'));await wait(()=>f.host.messages.inspect().requests.length===1);
 const request_id=f.host.messages.inspect().requests[0].request_id;await call(f,tokens.access_token,'claim_message',{request_id});
 await call(f,tokens.access_token,'reply_message',{request_id,response_id:'answer',text:'reply',final:true});await f.host.messages.flush();
 await wait(()=>f.streams.length===2);await f.host.messages.flush();assert.equal(f.stats().sends,1);
 assert.equal(f.host.messages.inspect().requests[0].replies[0].state,'unknown_outcome');
 await f.restart();f.host.start();await wait(()=>f.streams.length===3);await f.host.messages.flush();assert.equal(f.stats().sends,1);
 assert.equal(f.host.messages.inspect().requests[0].replies[0].state,'unknown_outcome');
});
