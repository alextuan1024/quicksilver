import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import * as module from './local-service.mjs';
import {oauthFixture} from './test-support/oauth-fixture.mjs';
import {PROJECT_ID} from './photon.mjs';
const owner='+15550000001',dm=`any;-;${owner}`;
async function setup(t,{expiresAt}={}) {
  const sends=[];
  const f=await oauthFixture(t,localOAuth=>module.createLocalMessageService({
    localOAuth,expiresAt:expiresAt??localOAuth.expiresAt,
    photon:{projectId:PROJECT_ID,ownerAddress:owner,line:'shared',dm},
    messageHandling:{databasePath:join(dirname(localOAuth.databasePath),'messages.sqlite'),workerIntervalMs:0,
      provider:{messages:{sendText:async(...args)=>{sends.push(args);return {guid:'outgoing-1'};}}}},
  }));
  return {...f,sends,get auth(){return f.auth;}};
}
const rpc=(f,token,name,args)=>f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`},
  json:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
const native=()=>({type:'message.received',isFromMe:false,chatGuid:dm,message:{guid:'incoming-1',isFromMe:false,chatGuids:[dm],
  sender:{address:owner,service:'iMessage'},itemType:'normal',dateCreated:new Date(Date.now()-1000),content:{text:'Owner request',attachments:[]}}});

test('local owner tokens authorize request-bound messaging and revoked tokens cannot claim',async t=>{
  assert.equal(typeof module.createLocalMessageService,'function');
  const f=await setup(t),{code}=await f.login(),tokens=(await f.exchange(code)).body;
  const incoming=f.auth.messages.receive(native());assert.equal(incoming.accepted,true);
  assert.equal((await rpc(f,'invalid','claim_message',{request_id:incoming.request_id})).status,401);
  const claim=await rpc(f,tokens.access_token,'claim_message',{request_id:incoming.request_id});
  assert.equal(claim.body.result.structuredContent.text,'Owner request');
  const reply=await rpc(f,tokens.access_token,'reply_message',{request_id:incoming.request_id,response_id:'answer',text:'Owner response',final:true});
  assert.equal(reply.body.result.structuredContent.state,'queued');await f.auth.messages.flush();
  assert.equal(f.sends.length,1);assert.equal(f.sends[0][0],dm);
  await f.request('/token/revocation',{method:'POST',form:{client_id:'athena',token:tokens.refresh_token}});
  assert.equal((await rpc(f,tokens.access_token,'message_status',{})).status,401);
  await f.restart();assert.equal((await rpc(f,tokens.access_token,'message_status',{})).status,401);
});
test('OAuth persistence does not remove the existing bounded activation session',async t=>{
  const f=await setup(t,{expiresAt:new Date(Date.now()-1000).toISOString()});
  const {code}=await f.login(),tokens=(await f.exchange(code)).body;
  assert.equal(f.auth.messages.receive(native()).accepted,false);
  assert.equal((await rpc(f,tokens.access_token,'message_status',{})).status,503);
  const discovery=await f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${tokens.access_token}`},json:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  assert.equal(discovery.status,200);assert.ok(discovery.body.result.tools.some(tool=>tool.name==='reply_message'));
});
test('HTTP composition bounds JSON, rejects browser origins and exposes protected metadata',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('/mcp',{method:'POST',raw:'{'})).status,400);
  assert.equal((await f.request('/mcp',{method:'POST',raw:'x'.repeat(16385)})).status,413);
  assert.equal((await f.request('/mcp',{headers:{origin:'https://other.example'}})).status,403);
  assert.equal((await f.request('/mcp',{headers:{host:'attacker.example'}})).status,400);
  assert.equal((await f.request('/.well-known/oauth-protected-resource/mcp')).body.resource,f.config.resource);
  assert.equal((await f.request('/healthz')).body.mode,'message-session');
  await f.auth.close();assert.equal((await f.request('/healthz')).status,503);
});
