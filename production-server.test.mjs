import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {createServer,request} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {loadProductionConfig} from './production-config.mjs';
import {startProductionServer,requireSupportedNode} from './production-server.mjs';
import {createPhotonMessageHost} from './photon-message-host.mjs';
import {PROJECT_ID} from './photon.mjs';

const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'jwk'});
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'qs-production-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'production-config.local.json');
  const config={listener:{mode:'proxy',host:'127.0.0.1',port:0},expiresAt:new Date(Date.now()+600000).toISOString(),
    localOAuth:{issuer:'https://quicksilver.example/',resource:'https://quicksilver.example/mcp',clientId:'athena',
      redirectUris:['https://chatgpt.example/callback'],ownerSubject:'owner',databasePath:join(dir,'oauth.sqlite'),
      jwks:{keys:[{...key,kid:'fixture',alg:'RS256',use:'sig'}]},cookieKeys:[randomBytes(32).toString('base64url')],
      google:{clientId:'fixture-client',clientSecret:'fixture-google-secret'}},
    photon:{projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm:'any;-;+15550000001'},
    photonProjectSecret:'fixture-photon-secret',messageHandling:{databasePath:join(dir,'messages.sqlite'),workerIntervalMs:0}};
  const save=()=>writeFileSync(path,JSON.stringify(config),{mode:0o600});save();
  return {dir,path,config,save};
}
function get(port,path,headers={}) {
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path,headers:{host:'quicksilver.example','x-forwarded-proto':'https',...headers}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
    });req.on('error',reject);req.end();
  });
}
const wait=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('condition not reached');};

test('production config refuses unsafe listener, expired/rolling deadlines, injections and shared storage',t=>{
  const f=fixture(t);assert.equal(loadProductionConfig(f.path).localOAuth.trustProxy,true);
  for(const mutate of [
    c=>c.listener.host='0.0.0.0',c=>c.expiresAt=new Date(Date.now()-1).toISOString(),
    c=>c.expiresAt=new Date(Date.now()+7200000).toISOString(),c=>c.photonLive={},
    c=>c.localOAuth.trustProxy=true,c=>c.localOAuth.google.fetch='override',
    c=>c.messageHandling.databasePath=c.localOAuth.databasePath,
    c=>c.messageHandling.databasePath='relative.sqlite',
    c=>c.listener.trustedProxyAddresses=['127.0.0.1'],
    c=>c.listener={mode:'render',host:'0.0.0.0',port:10000,trustedProxyAddresses:[]},
    c=>c.listener={mode:'render',host:'0.0.0.0',port:10000,trustedProxyAddresses:['127.0.0.1']},
    c=>c.listener={mode:'render',host:'127.0.0.1',port:10000},
    c=>c.listener={mode:'render',host:'0.0.0.0',port:10000,certFile:'/private/cert',keyFile:'/private/key'},
  ]){
    const bad=structuredClone(f.config);mutate(bad);writeFileSync(f.path,JSON.stringify(bad));
    assert.throws(()=>loadProductionConfig(f.path),/invalid_production_configuration/);
  }
  f.save();chmodSync(f.path,0o644);assert.throws(()=>loadProductionConfig(f.path));chmodSync(f.path,0o600);
  const link=join(f.dir,'link.json');symlinkSync(f.path,link);assert.throws(()=>loadProductionConfig(link));
  const fifo=join(f.dir,'pipe');execFileSync('mkfifo',[fifo]);assert.throws(()=>loadProductionConfig(fifo));
  chmodSync(f.dir,0o755);assert.throws(()=>loadProductionConfig(f.path));chmodSync(f.dir,0o700);
});

test('Render CLI refuses missing/mismatched PORT before opening storage',async t=>{
  const f=fixture(t);f.config.listener={mode:'render',host:'0.0.0.0',port:10000};f.save();
  assert.equal(loadProductionConfig(f.path).localOAuth.trustProxy,true);
  for(const env of [{},{PORT:'10001'}]){
    const child=spawn(process.execPath,['production-server.mjs','--config',f.path,'--activate'],{env,stdio:'ignore'});
    assert.deepEqual(await once(child,'exit'),[1,null]);assert.equal(existsSync(f.config.localOAuth.databasePath),false);
  }
});

test('production listener runs real OAuth/message host, rejects spoofed origins and releases storage on shutdown',async t=>{
  const f=fixture(t);let opened=0,closed=0,finish;
  const running=await startProductionServer(loadProductionConfig(f.path),{createHost:config=>createPhotonMessageHost({...config,
    photonLive:{sdkLoader:async()=>({issueTokens:async()=>({type:'shared',token:'fixture',expiresIn:3600}),
      createClient:()=>{opened++;return {close(){closed++;finish?.({done:true});},messages:{sendText:async()=>({guid:'unused'}),
        subscribeEvents:()=>({[Symbol.asyncIterator](){return this;},next:()=>new Promise(resolve=>{finish=resolve;})})}};}})}})});
  t.after(()=>running.close());const port=running.address().port;await wait(()=>opened===1);
  const metadata=await get(port,'/.well-known/oauth-authorization-server');assert.equal(metadata.status,200);
  assert.equal(metadata.body.issuer,'https://quicksilver.example/');
  assert.equal((await get(port,'/healthz')).body.mode,'message-session');
  assert.equal((await get(port,'/mcp')).status,401);
  assert.equal((await get(port,'/mcp',{origin:'https://evil.example'})).status,403);
  assert.equal((await get(port,'/healthz',{'x-forwarded-proto':'http'})).status,400);
  assert.equal((await get(port,'/healthz',{'x-forwarded-host':'quicksilver.example'})).status,400);
  assert.equal((await get(port,'/healthz',{host:'evil.example'})).status,400);
  await Promise.all([running.close(),running.close()]);assert.equal(closed,1);
  await assert.rejects(()=>get(port,'/healthz'));
  const host=await createPhotonMessageHost(loadProductionConfig(f.path));await host.close();
});

test('bind failure closes the host without starting Photon',async t=>{
  const f=fixture(t),occupied=createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>occupied.close(resolve)));f.config.listener.port=occupied.address().port;f.save();
  let starts=0,closes=0;
  await assert.rejects(()=>startProductionServer(loadProductionConfig(f.path),{createHost:async()=>({start(){starts++;},close(){closes++;}})}),/production_startup_failed/);
  assert.equal(starts,0);assert.equal(closes,1);
});

test('signal during host construction closes it without listening or activating',async t=>{
  const f=fixture(t),signal=new AbortController();let closed=0;
  await assert.rejects(()=>startProductionServer(loadProductionConfig(f.path),{signal:signal.signal,createHost:async()=>{
    signal.abort();return {start(){assert.fail('must not activate');},close(){closed++;}};
  }}),/production_startup_failed/);assert.equal(closed,1);
});

test('shutdown fences host immediately and destroys stalled HTTP connections after grace',async t=>{
  const f=fixture(t),signal=new AbortController();let closed=false,received=false;
  const running=await startProductionServer(loadProductionConfig(f.path),{signal:signal.signal,shutdownGraceMs:20,
    createHost:async()=>({start(){},handle(){received=true;},close(){closed=true;},transportStatus:()=>({state:'listening'})})});
  t.after(()=>running.close());
  const pending=get(running.address().port,'/healthz');const rejected=assert.rejects(pending);
  await wait(()=>received);signal.abort();await running.close();await rejected;assert.equal(closed,true);
});

test('CLI refuses missing activation and malformed config without leaking secrets or opening databases',async t=>{
  const f=fixture(t);
  for(const args of [['--config',f.path],['--config',f.path,'--activate']]){
    if(args.length===3){f.config.expiresAt='invalid-private-deadline';f.save();}
    const child=spawn(process.execPath,['production-server.mjs',...args],{stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
    const [code]=await once(child,'exit');assert.equal(code,1);
    for(const secret of [f.path,f.config.photonProjectSecret,f.config.localOAuth.google.clientSecret,'invalid-private-deadline'])assert.equal(output.includes(secret),false);
    assert.equal(existsSync(f.config.localOAuth.databasePath),false);
  }
});

test('runtime gate accepts only supported Node 22 versions',()=>{
  for(const v of ['22.23.4','22.24.0'])assert.doesNotThrow(()=>requireSupportedNode(v));
  for(const v of ['20.20.0','22.23.3','24.0.0'])assert.throws(()=>requireSupportedNode(v));
});

test('direct TLS serves discovery with a trusted certificate and closes cleanly',async t=>{
  const f=fixture(t),cert=join(f.dir,'cert.pem'),keyFile=join(f.dir,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyFile,'-out',cert,
    '-days','1','-subj','/CN=quicksilver.example','-addext','subjectAltName=DNS:quicksilver.example'],{stdio:'ignore'});
  chmodSync(cert,0o600);chmodSync(keyFile,0o600);
  f.config.listener={mode:'tls',host:'127.0.0.1',port:0,certFile:cert,keyFile};f.save();
  const {readFileSync}=await import('node:fs');
  const running=await startProductionServer(loadProductionConfig(f.path),{createHost:async config=>{
    const host=await createPhotonMessageHost(config);await host.messages.pause();return host;
  }});t.after(()=>running.close());
  const response=await new Promise((resolve,reject)=>{
    const req=httpsRequest({hostname:'127.0.0.1',port:running.address().port,servername:'quicksilver.example',
      ca:readFileSync(cert),path:'/.well-known/oauth-authorization-server',headers:{host:'quicksilver.example'}},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.end();
  });
  assert.equal(response.status,200);assert.equal(response.body.issuer,'https://quicksilver.example/');await running.close();
});

for(const signal of ['SIGTERM','SIGINT'])test(`production CLI preserves pause and exits cleanly on ${signal}`,async t=>{
  const f=fixture(t),host=await createPhotonMessageHost(loadProductionConfig(f.path));
  await host.messages.pause();await host.close();
  const child=spawn(process.execPath,['production-server.mjs','--config',f.path,'--activate'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const exited=once(child,'exit');let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  await wait(()=>/port=\d+/.test(output)||child.exitCode!==null);
  assert.equal(child.exitCode,null,output);const port=Number(/port=(\d+)/.exec(output)[1]);
  assert.equal((await get(port,'/healthz')).body.mode,'paused');
  child.kill(signal);assert.deepEqual(await exited,[0,null]);
  assert.equal(output.includes(f.config.photonProjectSecret),false);assert.equal(output.includes(f.config.localOAuth.google.clientSecret),false);
  const reopened=await createPhotonMessageHost(loadProductionConfig(f.path));assert.equal(reopened.messages.recoveryActive(),false);await reopened.close();
});
