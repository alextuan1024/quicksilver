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
