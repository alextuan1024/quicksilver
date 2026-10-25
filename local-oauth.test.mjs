import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import * as module from './local-oauth.mjs';
import {oauthFixture,resource,scope} from './test-support/oauth-fixture.mjs';
const setup=t=>oauthFixture(t,config=>module.createLocalOAuth(config));
const principal=(f,token)=>f.auth.gate.authenticate({authorization:`Bearer ${token}`});

test('Google owner login yields an MCP token and persistent rotating refresh grant',async t=>{
  assert.equal(typeof module.createLocalOAuth,'function');
  const f=await setup(t),{code}=await f.login();const first=await f.exchange(code);
  assert.equal(first.status,200,JSON.stringify(first));assert.ok(first.body.refresh_token);
  assert.equal((await principal(f,first.body.access_token)).principal.subject,'google-owner');
  await f.restart();assert.ok((await principal(f,first.body.access_token)).principal);
  const second=await f.refresh(first.body.refresh_token);assert.equal(second.status,200,JSON.stringify(second));
  assert.notEqual(second.body.refresh_token,first.body.refresh_token);
  await f.restart();const reuse=await f.refresh(first.body.refresh_token);assert.equal(reuse.body.error,'invalid_grant');
  assert.equal((await principal(f,second.body.access_token)).status,401);
  assert.equal((await f.refresh(second.body.refresh_token)).body.error,'invalid_grant');
});
test('refresh revocation immediately rejects access and survives restart',async t=>{
  const f=await setup(t),{code}=await f.login(),tokens=(await f.exchange(code)).body;
  assert.equal((await f.request('/token/revocation',{method:'POST',form:{client_id:'athena',token:tokens.refresh_token}})).status,200);
  assert.equal((await principal(f,tokens.access_token)).status,401);await f.restart();
  assert.equal((await f.refresh(tokens.refresh_token)).body.error,'invalid_grant');
});
test('PKCE is mandatory and incorrect verifier cannot exchange the code',async t=>{
  const f=await setup(t);
  const noPkce=await f.begin({code_challenge:'',code_challenge_method:''});
  assert.ok(noPkce.status>=400||new URL(noPkce.location).searchParams.has('error'));
  const {code}=await f.login();const bad=await f.exchange(code,{code_verifier:'b'.repeat(64)});
  assert.equal(bad.body.error,'invalid_grant');assert.equal((await principal(f,'invented')).status,401);
});
test('unknown client, redirect, scope and resource cannot obtain a code',async t=>{
  const f=await setup(t);
  for(const override of [{client_id:'stranger'},{redirect_uri:'https://attacker.example/callback'},{scope:`openid ${scope} admin`},{resource:'https://attacker.example/mcp'}]){
    const r=await f.begin(override);assert.ok(r.status>=400||new URL(r.location).searchParams.has('error'),JSON.stringify(r));
    assert.ok(!r.location?.startsWith('https://attacker.example'));
  }
});
test('wrong Google owner and nonce are rejected without issuing a code',async t=>{
  const f=await setup(t);
  for(const options of [{subject:'another-owner'},{nonce:'wrong-nonce'}]){
    const r=await f.login(options);assert.equal(r.response.status,403);assert.deepEqual(r.response.body,{error:'login_failed'});
  }
});
test('Google callback is browser-bound, state checked and single-use',async t=>{
  const f=await setup(t);let r=await f.begin();r=await f.request(f.path(r.location));
  const callback=f.authorizeGoogle(r.location),cookie=f.cookies.get('__Host-quicksilver_login');
  f.cookies.delete('__Host-quicksilver_login');assert.equal((await f.request(callback)).status,403);
  f.cookies.set('__Host-quicksilver_login',cookie);
  assert.equal((await f.request(callback.replace(/state=[^&]+/,'state=wrong'))).status,403);
  assert.equal((await f.request(callback)).status,303);
  assert.equal((await f.request(callback)).status,403);
});
test('authorization codes are single-use and resource token cannot cross audience',async t=>{
  const f=await setup(t),{code}=await f.login();const wrong=await f.exchange(code,{resource:'https://elsewhere.example/mcp'});
  assert.ok(wrong.status>=400);
  const next=await f.login(),tokens=await f.exchange(next.code);assert.equal(tokens.status,200);
  assert.equal((await f.exchange(next.code)).body.error,'invalid_grant');
  assert.equal((await principal(f,tokens.body.access_token)).status,401);
});
test('discovery is pinned, host checks reject spoofing and stopped gate fails closed',async t=>{
  const f=await setup(t);const discovery=await f.request('/.well-known/oauth-authorization-server');
  assert.equal(discovery.body.issuer,f.config.issuer);assert.equal(discovery.body.registration_endpoint,undefined);
  assert.deepEqual(discovery.body.code_challenge_methods_supported,['S256']);
  assert.equal(f.auth.gate.metadata.resource,resource);
  assert.equal((await f.request('/auth',{headers:{host:'attacker.example'}})).status,400);
  await f.auth.close();assert.equal((await principal(f,'anything')).status,503);
});

test('simultaneous refresh use cannot leave two usable token families',async t=>{
  const f=await setup(t),{code}=await f.login(),first=(await f.exchange(code)).body;
  const responses=await Promise.all([f.refresh(first.refresh_token),f.refresh(first.refresh_token)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  const winner=responses.find(r=>r.status===200).body;
  assert.equal((await principal(f,winner.access_token)).status,401);
  assert.equal((await f.refresh(winner.refresh_token)).body.error,'invalid_grant');
});
test('expired authorization codes and Google transactions are unusable',async t=>{
  const f=await setup(t),{code}=await f.login();
  t.mock.timers.enable({apis:['Date'],now:Date.now()+61000});
  assert.equal((await f.exchange(code)).body.error,'invalid_grant');
  let r=await f.begin();r=await f.request(f.path(r.location));const callback=f.authorizeGoogle(r.location);
  t.mock.timers.tick(301000);assert.equal((await f.request(callback)).status,403);
});
test('invalid Google issuer, audience, expiry and signature fail closed',async t=>{
  const f=await setup(t);
  for(const options of [{claims:{iss:'https://attacker.example'}},{claims:{aud:'different-client'}},{claims:{exp:1}},{tamperSignature:true}]){
    const result=await f.login(options);assert.equal(result.response.status,403);
  }
});
test('unsupported OAuth endpoints and untrusted proxy headers cannot bypass configuration',async t=>{
  const f=await setup(t);
  for(const path of ['/reg','/request','/session/end','/me'])assert.equal((await f.request(path)).status,404);
  for(const headers of [{'x-forwarded-host':'attacker.example'},{'x-forwarded-proto':'http'},{'x-forwarded-proto':'https,http'}])
    assert.equal((await f.request('/jwks',{headers})).status,400);
  const metadata=await f.request('/.well-known/oauth-authorization-server');
  assert.equal(metadata.body.pushed_authorization_request_endpoint,undefined);
  assert.equal(metadata.body.dpop_signing_alg_values_supported,undefined);
});
test('missing persistent keys or changed owner cannot open local authorization',async t=>{
  const f=await setup(t);await f.auth.close();
  for(const changes of [{jwks:{keys:[]}},{cookieKeys:[]},{ownerSubject:'different'},{redirectUris:['http://insecure.example/callback']}])
    assert.throws(()=>module.createLocalOAuth({...f.config,...changes}));
  const auth=module.createLocalOAuth(f.config);await auth.close();
});


test('an incomplete token request times out without blocking discovery or shutdown',async t=>{
  const f=await oauthFixture(t,config=>module.createLocalOAuth({...config,requestTimeoutMs:50}));
  const logged=[];t.mock.method(console,'error',(...args)=>logged.push(args));
  const pending=httpRequest(f.address+'/token',{method:'POST',headers:{host:'quicksilver.example',
    'x-forwarded-proto':'https','content-type':'application/x-www-form-urlencoded','content-length':'100'}});
  pending.on('error',()=>{});t.after(()=>pending.destroy());
  pending.write('client_id=athena&');
  const result=await Promise.race([f.request('/jwks'),new Promise(resolve=>setTimeout(()=>resolve({status:'timed_out'}),500))]);
  // Abort explicitly on the red run so teardown cannot hang on this regression.
  pending.destroy();
  assert.equal(result.status,200);
  await f.auth.close();assert.deepEqual(logged,[]);
});

test('issuer must be canonical with a trailing slash before any database is opened',async t=>{
  const f=await setup(t);await f.auth.close();
  for(const issuer of ['https://quicksilver.example','https://QUICKSILVER.example/','https://quicksilver.example:443/']){
    let candidate;
    try{assert.throws(()=>{candidate=module.createLocalOAuth({...f.config,issuer,databasePath:f.config.databasePath+String(issuer.length)});},/invalid_local_oauth_configuration/);}
    finally{await candidate?.close();}
  }
});
