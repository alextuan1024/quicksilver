import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { createOAuthGate } from './oauth.mjs';

const now = 1_800_000_000;
const keys = await generateKeyPair('RS256');
const otherKeys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey);
const config = { issuer: 'https://issuer.example/', resource: 'https://resource.example/mcp',
  clientId: 'test-client', ownerSubject: 'google-oauth2|test-owner',
  expiresAt: new Date((now + 3600) * 1000).toISOString(), now: () => now * 1000,
  jwks: createLocalJWKSet({keys:[{...jwk,kid:'test',alg:'RS256',use:'sig'}]}) };
async function token(overrides = {}, signingKey = keys.privateKey, typ = 'at+jwt') {
  const claims = {iss:config.issuer,aud:config.resource,sub:config.ownerSubject,
    client_id:config.clientId,scope:'quicksilver:probe',iat:now,exp:now+3600,jti:'test-token',...overrides};
  for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({alg:'RS256',kid:'test',typ}).sign(signingKey);
}
const headers = async (...args) => ({authorization:`Bearer ${await token(...args)}`});
test('OAuth metadata and challenge use exact resource and configured issuer', async () => {
  const gate=createOAuthGate(config);
  assert.equal(gate.metadata.resource,config.resource);
  assert.deepEqual(gate.metadata.authorization_servers,[config.issuer]);
  assert.equal((await gate.authenticate({})).status,401);
  assert.match((await gate.authenticate({})).headers['WWW-Authenticate'],/resource_metadata="https:\/\/resource.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await gate.authenticate(await headers())).principal.subject,config.ownerSubject);
});
test('valid tokens never enroll an owner or open an unapproved/expired test session', async () => {
  for (const changes of [{ownerSubject:undefined},{clientId:undefined},{expiresAt:undefined},
    {expiresAt:new Date(now*1000).toISOString()}, {expiresAt:new Date((now+3601)*1000).toISOString()}]) {
    const gate=createOAuthGate({...config,...changes});
    assert.equal(gate.enabled,false);
    assert.ok((await gate.authenticate(await headers())).status >= 400);
    assert.equal(gate.enabled,false);
  }
});
test('OAuth rejects wrong issuer, audience, subject, scope, client, expiry and token type', async () => {
  const gate=createOAuthGate(config);
  const invalid = [{iss:'https://evil.example/'},{aud:'another-api'},{sub:'google-oauth2|someone-else'},
    {scope:'quicksilver:probe-extra'},{scope:undefined},{client_id:'other-client'},
    {exp:now-1},{exp:undefined},{iat:undefined},{iat:now+60},{exp:now+3601},{jti:undefined},
    {sub:'test-client@clients'}];
  for (const claims of invalid) assert.ok((await gate.authenticate(await headers(claims))).status >= 400,JSON.stringify(claims));
  assert.equal((await gate.authenticate(await headers({},otherKeys.privateKey))).status,401);
  assert.equal((await gate.authenticate(await headers({},keys.privateKey,'JWT'))).status,401);
  assert.equal((await gate.authenticate({authorization:'Bearer public-invalid-test-value'})).status,401);
});

test('authentication diagnostics distinguish fixed failure categories without changing HTTP errors', async () => {
  const gate=createOAuthGate(config);
  const cases=[
    [{},'bearer_missing'],
    [{authorization:''},'bearer_malformed'],
    [{authorization:'Basic must-never-be-logged'},'bearer_malformed'],
    [{authorization:'Bearer public-invalid-test-value'},'jwt_malformed'],
    [await headers({exp:now-1}),'jwt_expired'],
    [await headers({aud:'must-never-be-logged'}),'jwt_claim_invalid'],
    [await headers({client_id:undefined}),'jwt_claim_invalid'],
    [await headers({},keys.privateKey,'JWT'),'jwt_claim_invalid'],
    [await headers({},otherKeys.privateKey),'jwt_signature_invalid'],
    [await headers({iat:now+1}),'jwt_policy_invalid'],
    [await headers({exp:now+3601}),'jwt_policy_invalid'],
    [await headers({jti:''}),'jwt_policy_invalid'],
  ];
  const hs=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).sign(new Uint8Array(32));
  cases.push([{authorization:`Bearer ${hs}`},'jwt_algorithm_invalid']);
  const challenge=(await gate.authenticate({})).headers;
  for(const [input,category] of cases) {
    const result=await gate.authenticate(input);
    assert.equal(result.authFailure,category);
    assert.deepEqual(result,{status:401,body:{error:'invalid_token'},headers:challenge,authFailure:category});
    assert.equal(JSON.stringify(result).includes('must-never-be-logged'),false);
  }
  for(const [claims,status] of [[{},undefined],[{sub:'google-oauth2|other'},403],[{client_id:'other'},403],[{scope:'other'},403]]) {
    const result=await gate.authenticate(await headers(claims));
    assert.equal(result.status,status);assert.equal(result.authFailure,undefined);
  }
  const expired=createOAuthGate({...config,expiresAt:new Date(now*1000).toISOString()});
  const result=await expired.authenticate(await headers());
  assert.equal(result.status,503);assert.equal(result.authFailure,undefined);
});

test('key resolution failures log only fixed categories, including unavailable remote JWKS', async () => {
  const {createRemoteJWKSet,customFetch}=await import('jose');
  const goodHeaders=await headers();
  const keyless=createOAuthGate({...config,jwks:createLocalJWKSet({keys:[]})});
  assert.equal((await keyless.authenticate(goodHeaders)).authFailure,'jwks_key_invalid');
  const invalidKey=createOAuthGate({...config,jwks:async()=>({})});
  assert.equal((await invalidKey.authenticate(goodHeaders)).authFailure,'jwt_verification_failed');
  for(const fetchImpl of [
    async()=>{throw new TypeError('must-never-be-logged');},
    async()=>{throw new DOMException('must-never-be-logged','TimeoutError');},
    async()=>new Response('must-never-be-logged',{status:503}),
    async()=>new Response('must-never-be-logged',{status:200}),
  ]) {
    const jwks=createRemoteJWKSet(new URL('https://fixture.example/jwks'),{[customFetch]:fetchImpl});
    const result=await createOAuthGate({...config,jwks}).authenticate(goodHeaders);
    assert.equal(result.status,401);assert.deepEqual(result.body,{error:'invalid_token'});
    assert.equal(result.authFailure,'jwks_unavailable');
    assert.equal(JSON.stringify(result).includes('must-never-be-logged'),false);
  }
});
