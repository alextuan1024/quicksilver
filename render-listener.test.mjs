import test from 'node:test';
import assert from 'node:assert/strict';
import {request,createServer} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {productionDrill,until} from './test-support/production-drill-fixture.mjs';
import {renderPort,addressKey} from './platform-listener.mjs';

const listener={mode:'render',host:'0.0.0.0',port:0,trustedProxyAddresses:['127.0.0.1']};
function raw(address,headers,path='/mcp',localAddress='127.0.0.1') {
  return new Promise((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port:Number(new URL(address).port),localAddress});let response='';
    socket.on('connect',()=>socket.end(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`));
    socket.on('data',chunk=>{response+=chunk;});socket.on('error',reject);socket.on('end',()=>resolve(response));
  });
}

test('Render boundary rejects spoofed/duplicate headers and untrusted socket peers before OAuth',async t=>{
  const d=await productionDrill(t,{listener}),{f}=d;
  const valid='Host: quicksilver.example\r\nX-Forwarded-Proto: https';
  for(const headers of [
    'Host: quicksilver.example',valid.replace('https','http'),valid.replace('https','https, http'),
    valid.replace('quicksilver.example','evil.example'),valid+'\r\nhOSt: evil.example',
    valid+'\r\nx-forwarded-proto: https',valid+'\r\nForwarded:',valid+'\r\nX-Forwarded-Host:',
    valid+'\r\nForwarded: proto=https;host=quicksilver.example',
  ])assert.match(await raw(f.address,headers),/^HTTP\/1.1 400 /);
  assert.match(await raw(f.address,valid+'\r\nX-Forwarded-For: 127.0.0.1','/mcp','127.0.0.2'),/^HTTP\/1.1 400 /);
  assert.match(await raw(f.address,valid),/^HTTP\/1.1 401 /);
  assert.equal((await f.request('/mcp',{headers:{origin:'https://evil.example'}})).status,403);
  // Only process liveness bypasses peer/Host checks; never discovery or auth.
  assert.match(await raw(f.address,'Host: anything','/livez','127.0.0.2'),/^HTTP\/1.1 200 /);
  for(const path of ['/livez?x=1','/livez/','/.well-known/oauth-authorization-server','/healthz','/auth'])
    assert.match(await raw(f.address,'Host: anything',path,'127.0.0.2'),/^HTTP\/1.1 400 /);
  assert.equal((await f.request('/livez',{method:'POST',headers:{host:'evil.example'}})).status,400);
  const discovery=await f.request('/.well-known/oauth-authorization-server');
  assert.equal(discovery.body.issuer,'https://quicksilver.example/');
  assert.ok(discovery.body.authorization_endpoint.startsWith('https://quicksilver.example/'));
  const tokens=await d.token();assert.equal((await d.rpc(tokens.access_token,'tools/list')).status,200);
  await f.auth.command('pause');await f.restart();
  assert.equal((await f.request('/healthz')).body.mode,'paused');
  assert.deepEqual((await f.request('/livez',{headers:{host:'platform-health'}})).body,{status:'listening'});
  const old=f.address;await f.auth.close();await assert.rejects(()=>raw(old,valid));d.check();
});

test('Render PORT is explicit and exact addresses normalize without wildcard trust',()=>{
  assert.equal(renderPort({PORT:'10000'}),10000);
  for(const PORT of [undefined,'','0','-1','01','65536','18012','18013','19099','10000junk'])assert.throws(()=>renderPort({PORT}));
  assert.equal(addressKey('127.0.0.1'),addressKey('::ffff:127.0.0.1'));
  assert.equal(addressKey('2001:db8::1'),addressKey('2001:0db8:0:0:0:0:0:1'));
  for(const value of ['*','10.0.0.0/8','localhost','unknown'])assert.throws(()=>addressKey(value));
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
