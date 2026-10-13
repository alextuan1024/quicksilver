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
