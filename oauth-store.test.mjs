import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as module from './oauth-store.mjs';

const identity={issuer:'https://quicksilver.example/',resource:'https://quicksilver.example/mcp',clientId:'athena',ownerSubject:'google-owner'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'qs-oauth-'));let now=1700000000000;const stores=[];
  t.after(()=>{for(const s of stores)s.close();rmSync(dir,{recursive:true,force:true});});
  return {path:join(dir,'oauth.sqlite'),advance:ms=>{now+=ms;},open(overrides={}) {
    const store=module.openOAuthStore({path:join(dir,'oauth.sqlite'),identity,now:()=>now,...overrides});stores.push(store);return store;
  }};
}
test('OAuth records and consumed state survive restart, then expire',async t=>{
  assert.equal(typeof module.openOAuthStore,'function');
  const f=fixture(t);let s=f.open();let a=new s.Adapter('AuthorizationCode');
  await a.upsert('code',{grantId:'grant',accountId:'google-owner'},60);await a.consume('code');
  s.close();s=f.open();a=new s.Adapter('AuthorizationCode');
  assert.equal((await a.find('code')).consumed,1700000000);
  assert.equal(statSync(f.path).mode&0o777,0o600);
  f.advance(60000);assert.equal(await a.find('code'),undefined);
});
test('grant revocation removes every token and prevents resurrection',async t=>{
  const s=fixture(t).open();const grant=new s.Adapter('Grant');
  await grant.upsert('g',{accountId:'google-owner'},600);
  for(const name of ['AuthorizationCode','AccessToken','RefreshToken'])await new s.Adapter(name).upsert(name,{grantId:'g'},600);
  await new s.Adapter('RefreshToken').revokeByGrantId('g');
  for(const name of ['AuthorizationCode','AccessToken','RefreshToken'])assert.equal(await new s.Adapter(name).find(name),undefined);
  assert.equal(await grant.find('g'),undefined);
  await assert.rejects(new s.Adapter('AccessToken').upsert('late',{grantId:'g'},600));
});
test('login transactions are browser-bound, one-use and expire',t=>{
  const f=fixture(t),s=f.open();s.saveLogin('state',{uid:'interaction',browser:'digest',verifier:'secret'},60);
  assert.equal(s.takeLogin('state','wrong'),undefined);
  assert.equal(s.takeLogin('state','digest').uid,'interaction');
  assert.equal(s.takeLogin('state','digest'),undefined);
  s.saveLogin('expired',{browser:'digest'},1);f.advance(1000);
  assert.equal(s.takeLogin('expired','digest'),undefined);
});
test('database refuses another owner or concurrent process connection',t=>{
  const f=fixture(t),s=f.open();
  assert.throws(()=>f.open(),/oauth_database_in_use/);s.close();
  assert.throws(()=>f.open({identity:{...identity,ownerSubject:'another-owner'}}),/oauth_identity_mismatch/);
  assert.doesNotThrow(()=>f.open());
});
test('secondary lookup and consumed code cannot be reused',async t=>{
  const s=fixture(t).open(),a=new s.Adapter('Session');
  await a.upsert('session',{uid:'uid'},30);assert.equal((await a.findByUid('uid')).uid,'uid');
  await a.destroy('session');assert.equal(await a.findByUid('uid'),undefined);
  const c=new s.Adapter('AuthorizationCode');await c.upsert('code',{},30);await c.consume('code');
  await assert.rejects(c.consume('code'),/oauth_record_consumed/);
});
