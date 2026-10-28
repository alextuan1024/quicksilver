import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {productionDrill,until} from './test-support/production-drill-fixture.mjs';
import {renderPort,renderOriginGuard} from './platform-listener.mjs';

const listener={mode:'render',host:'0.0.0.0',port:0};
const poisoned={'x-forwarded-proto':'http, https','x-forwarded-host':'attacker.example',
  'x-forwarded-port':'80','x-forwarded-for':'127.0.0.1','x-real-ip':'127.0.0.1',
  forwarded:'for=127.0.0.1;host=attacker.example;proto=http'};
function raw(address,headers,path='/mcp',localAddress='127.0.0.1') {
  return new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:Number(new URL(address).port),localAddress});let response='';
    socket.on('connect',()=>socket.end(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`));
    socket.on('data',chunk=>{response+=chunk;});socket.on('error',reject);socket.on('end',()=>resolve(response));
  });
}

test('Render pins Host, discards forwarding claims, and never authenticates a private peer',async t=>{
  const d=await productionDrill(t,{listener}),{f}=d;
  const valid='Host: quicksilver.example\r\nX-Forwarded-Proto: https';
  for(const headers of [
    valid.replace('quicksilver.example','evil.example'),valid+'\r\nhOSt: evil.example',
    valid+'\r\nhOSt: quicksilver.example',valid.replace('quicksilver.example','quicksilver.example, evil.example'),
  ])assert.match(await raw(f.address,headers),/^HTTP\/1.1 400 /);
  for(const headers of ['Host: quicksilver.example',valid.replace('https','http'),valid.replace('https','https, http'),
    valid+'\r\nx-forwarded-proto: http',valid+'\r\nForwarded:',valid+'\r\nX-Forwarded-Host: evil.example',
    valid+'\r\nForwarded: proto=http;host=evil.example',valid+'\r\nX-Forwarded-For: 127.0.0.1\r\nAuthorization: Bearer invented'])
    assert.match(await raw(f.address,headers,'/mcp','127.0.0.2'),/^HTTP\/1.1 401 /);
  assert.match(await raw(f.address,valid,'http://evil.example/mcp'),/^HTTP\/1.1 400 /);
  assert.match(await raw(f.address,valid),/^HTTP\/1.1 401 /);
  assert.equal((await f.request('/mcp',{headers:{origin:'https://evil.example'}})).status,403);
  // Only exact process liveness bypasses Host checks; never discovery or auth.
  assert.match(await raw(f.address,'Host: anything','/livez','127.0.0.2'),/^HTTP\/1.1 200 /);
  for(const path of ['/livez?x=1','/livez/','/.well-known/oauth-authorization-server','/healthz','/auth'])
    assert.match(await raw(f.address,'Host: anything',path,'127.0.0.2'),/^HTTP\/1.1 400 /);
  assert.equal((await f.request('/livez',{method:'POST',headers:{host:'evil.example'}})).status,400);
  const discovery=await f.request('/.well-known/oauth-authorization-server',{headers:poisoned});
  assert.equal(discovery.body.issuer,'https://quicksilver.example/');
  for(const name of ['authorization_endpoint','token_endpoint','revocation_endpoint','jwks_uri'])
    assert.ok(discovery.body[name].startsWith('https://quicksilver.example/'),name);
  const tokens=await d.token();assert.equal((await d.rpc(tokens.access_token,'tools/list')).status,200);
  await f.auth.command('pause');await f.restart();
  assert.equal((await f.request('/healthz')).body.mode,'paused');
  assert.deepEqual((await f.request('/livez',{headers:{host:'platform-health'}})).body,{status:'listening'});
  const old=f.address;await f.auth.close();await assert.rejects(()=>raw(old,valid));d.check();
});

test('Render PORT is explicit and only application-owned HTTPS metadata reaches OAuth',()=>{
  assert.equal(renderPort({PORT:'10000'}),10000);
  for(const PORT of [undefined,'','0','-1','01','65536','18012','18013','19099','10000junk'])assert.throws(()=>renderPort({PORT}));
  const guard=renderOriginGuard('https://quicksilver.example/');
  const req={headers:{host:'quicksilver.example',...poisoned,'x-forwarded-client-cert':'fake',authorization:'Bearer unchanged',origin:'https://attacker.example'},
    rawHeaders:['Host','quicksilver.example',...Object.entries(poisoned).flat(),'X-FORWARDED-PROTO','https',
      'X-Forwarded-Client-Cert','fake','Authorization','Bearer unchanged','Origin','https://attacker.example']};
  assert.equal(guard(req),true);
  assert.deepEqual(req.headers,{host:'quicksilver.example',authorization:'Bearer unchanged',origin:'https://attacker.example','x-forwarded-proto':'https'});
  assert.deepEqual(req.rawHeaders,['Host','quicksilver.example','Authorization','Bearer unchanged','Origin','https://attacker.example','X-Forwarded-Proto','https']);
  assert.throws(()=>renderOriginGuard('http://quicksilver.example/'));
});

test('direct private HTTP and forged forwarding metadata do not bypass owner, PKCE or browser binding',async t=>{
  const d=await productionDrill(t,{listener,localAddress:'127.0.0.2',requestHeaders:poisoned}),{f}=d;
  assert.equal((await f.login({subject:'another-owner'})).response.status,403);
  assert.equal((await f.login({nonce:'wrong-nonce'})).response.status,403);
  for(const overrides of [{client_id:'unknown'},{redirect_uri:'https://attacker.example/callback'},
    {code_challenge:'',code_challenge_method:''},{resource:'https://attacker.example/mcp'}]){
    const result=await f.begin(overrides);
    assert.ok(result.status>=400||new URL(result.location).searchParams.has('error'));
    assert.equal(result.location?.startsWith('https://attacker.example')??false,false);
  }
  const {code}=await f.login();assert.equal((await f.exchange(code,{code_verifier:'b'.repeat(64)})).body.error,'invalid_grant');
  let response=await f.begin();assert.ok(response.location.startsWith('https://quicksilver.example/'));
  for(const cookie of response.headers['set-cookie']??[]){assert.match(cookie,/; secure/i);assert.match(cookie,/; httponly/i);assert.doesNotMatch(cookie,/; domain=/i);}
  response=await f.request(f.path(response.location));
  assert.equal(new URL(response.location).searchParams.get('redirect_uri'),'https://quicksilver.example/interaction/google/callback');
  const callback=f.authorizeGoogle(response.location),browser=f.cookies.get('__Host-quicksilver_login');
  f.cookies.delete('__Host-quicksilver_login');assert.equal((await f.request(callback)).status,403);
  f.cookies.set('__Host-quicksilver_login',browser);
  assert.equal((await f.request(callback.replace(/state=[^&]+/,'state=wrong'))).status,403);
  assert.equal((await f.request(callback)).status,303);assert.equal((await f.request(callback)).status,403);
  const tokens=await d.token();assert.equal((await d.rpc(tokens.access_token,'tools/list')).status,200);
  assert.equal((await f.request('/mcp',{headers:{authorization:`Bearer ${tokens.access_token}`,origin:'https://attacker.example'}})).status,403);
  d.check();
});

test('disabled Render bootstrap exposes only fixed health and exits with stalled clients',async t=>{
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const child=spawn(process.execPath,['render-bootstrap.mjs','--disabled'],
    {env:{PORT:String(port)},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const exited=once(child,'exit');await until(()=>output.includes('bootstrap disabled')||child.exitCode!==null);
  assert.equal(child.exitCode,null,output);
  for(const [path,status] of [['/livez',200],['/healthz',503],['/mcp',503],['/auth',503],['/livez?x=1',503]]) {
    const response=await fetch(`http://127.0.0.1:${port}${path}`);assert.equal(response.status,status);
    assert.deepEqual(await response.json(),{mode:'disabled'});
  }
  const stalled=connect({host:'127.0.0.1',port});stalled.on('error',()=>{});await once(stalled,'connect');
  const closed=once(stalled,'close');stalled.write('GET /livez HTTP/1.1\r\n');child.kill('SIGTERM');
  assert.deepEqual(await exited,[0,null]);await closed;
  const invalid=spawn(process.execPath,['render-bootstrap.mjs','--activate'],{env:{PORT:String(port)},stdio:'ignore'});
  assert.deepEqual(await once(invalid,'exit'),[1,null]);
});
