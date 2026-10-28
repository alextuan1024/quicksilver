import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {request,createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {startOwnerVerification,validateOwnerVerification,loadOwnerVerification} from './owner-verification-server.mjs';
// A broken start/callback must fail the test instead of hanging on a race barrier.
const test=(name,fn)=>nodeTest(name,{timeout:10000},fn);

const issuer='https://quicksilver.example/',ticket=Buffer.alloc(32,7).toString('base64url');
const config=()=>({issuer,expiresAt:new Date(Date.now()+300000).toISOString(),
  google:{clientId:'fixture-client',clientSecret:'fixture-secret'},setupTicket:ticket});
async function fixture(t) {
  let now=Date.now(),record,exchangeCount=0,hold,started;
  const key=await generateKeyPair('RS256',{extractable:true}),publicKey={...await exportJWK(key.publicKey),kid:'google',alg:'RS256',use:'sig'};
  const calls=[],cookies=new Map();const f=config();
  const running=await startOwnerVerification(f,{port:0,host:'127.0.0.1',now:()=>now,fetchGoogle:async(url,options)=>{
    calls.push(String(url));assert.equal(options.signal.aborted,false);
    if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[publicKey]});
    assert.equal(String(url),'https://oauth2.googleapis.com/token');exchangeCount++;
    const form=new URLSearchParams(options.body);assert.equal(form.get('redirect_uri'),issuer+'interaction/google/callback');
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),record.challenge);
    started?.();if(hold)await hold;
    let token=await new SignJWT({iss:'https://accounts.google.com',sub:'verified-google-sub',aud:'fixture-client',
      nonce:record.nonce,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...record.claims})
      .setProtectedHeader({alg:'RS256',kid:'google'}).sign(key.privateKey);
    if(record.badSignature){const pieces=token.split('.');pieces[2]=(pieces[2][0]==='a'?'b':'a')+pieces[2].slice(1);token=pieces.join('.');}
    return Response.json({access_token:'synthetic-upstream-access',token_type:'Bearer',id_token:token,expires_in:300});
  }});
  t.after(()=>running.close());
  async function send(path,{method='GET',headers={},form,raw}={}) {
    const response=await new Promise((resolve,reject)=>{
      const req=request({host:'127.0.0.1',port:running.address().port,path,method,headers:{host:'quicksilver.example',
        'x-forwarded-proto':'http','x-forwarded-host':'attacker.example',forwarded:'proto=http;host=attacker.example',
        cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),
        ...(form?{'Content-Type':'application/x-www-form-urlencoded',Origin:'https://quicksilver.example'}:{}),...headers}},res=>{
        let body='';res.on('data',b=>{body+=b;});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:body}));
      });req.on('error',reject);req.end(form?new URLSearchParams(form).toString():raw);
    });
    for(const c of response.headers['set-cookie']??[]){const [name,value]=c.split(';')[0].split('=');cookies.set(name,value);
      assert.match(c,/; Secure/);assert.match(c,/; HttpOnly/);assert.match(c,/; SameSite=Lax/);assert.doesNotMatch(c,/; Domain=/i);}
    try{response.body=JSON.parse(response.text);}catch{response.body=response.text;}return response;
  }
  async function begin(options={}) {
    const response=await send('/setup/owner/start',{method:'POST',form:{ticket},...options});
    if(response.status!==303)return {response};
    const url=new URL(response.headers.location);assert.equal(url.origin,'https://accounts.google.com');
    assert.equal(url.searchParams.get('scope'),'openid');assert.equal(url.searchParams.get('prompt'),'select_account');
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('redirect_uri'),issuer+'interaction/google/callback');
    record={nonce:url.searchParams.get('nonce'),challenge:url.searchParams.get('code_challenge'),claims:{}};
    return {response,callback:'/interaction/google/callback?'+new URLSearchParams({code:'synthetic-code',state:url.searchParams.get('state')})};
  }
  return {send,begin,cookies,calls,running,record:()=>record,count:()=>exchangeCount,
    expire(){now=Date.parse(f.expiresAt)+1;},
    hold(){let release;hold=new Promise(resolve=>{release=resolve;});return {release,started:new Promise(resolve=>{started=resolve;})};}};
}

test('owner proof uses Google only, returns verified identity to its browser, and leaves MCP unavailable',async t=>{
  const f=await fixture(t);assert.equal((await f.send('/setup/owner')).status,200);
  assert.equal((await f.send('/setup/owner')).text.includes(ticket),false);assert.deepEqual(f.calls,[]);
  for(const path of ['/mcp','/auth','/token','/.well-known/openid-configuration','/setup/owner/result'])assert.equal((await f.send(path)).status,503);
  const start=await f.begin();assert.equal(start.response.status,303);
  assert.equal(start.response.headers.location.includes(ticket),false);assert.deepEqual(f.calls,[]);
  const result=await f.send(start.callback);
  assert.equal(result.status,200);assert.deepEqual(result.body,{verified:true,issuer:'https://accounts.google.com',subject:'verified-google-sub',
    googleClientId:'fixture-client',ownerPinned:false,photon:'disabled'});
  assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['referrer-policy'],'no-referrer');
  assert.equal(result.text.includes('synthetic-upstream-access'),false);assert.equal(result.text.includes(ticket),false);
  assert.equal((await f.send(start.callback)).status,403);assert.equal((await f.begin()).response.status,403);
  assert.equal((await f.send('/livez')).body.photon,'disabled');assert.equal(f.count(),1);
});

test('ticket POST requires exact Origin and Host; bounded invalid requests do not consume the ticket',async t=>{
  const f=await fixture(t);
  for(const options of [{headers:{origin:'https://attacker.example'}},{headers:{origin:''}},{form:{ticket:'wrong'}},
    {headers:{'content-type':'text/plain'}},{form:{ticket,extra:'field'}}])assert.equal((await f.begin(options)).response.status,403);
  assert.equal((await f.begin({headers:{host:'attacker.example'}})).response.status,400);
  assert.equal((await f.begin({form:{ticket:'a'.repeat(1025)}})).response.status,413);
  const responses=await Promise.all([f.begin(),f.begin()]);assert.deepEqual(responses.map(x=>x.response.status).sort(),[303,403]);
  assert.deepEqual(f.calls,[]);
});

test('callback is browser/state-bound and parallel replay causes only one token exchange',async t=>{
  const f=await fixture(t),{callback}=await f.begin();
  assert.equal((await f.send(callback,{headers:{cookie:''}})).status,403);
  assert.equal((await f.send(callback.replace(/state=[^&]+/,'state=wrong'))).status,403);
  assert.equal((await f.send(callback+'&state=duplicate')).status,403);assert.equal(f.count(),0);
  const hold=f.hold(),first=f.send(callback);await hold.started;
  assert.equal((await f.send(callback)).status,403);hold.release();assert.equal((await first).status,200);assert.equal(f.count(),1);
});

for(const invalid of ['signature','nonce','issuer','audience','expiry'])test(`owner proof rejects wrong Google ${invalid}`,async t=>{
  const f=await fixture(t),{callback}=await f.begin(),record=f.record();
  if(invalid==='signature')record.badSignature=true;
  else record.claims[{nonce:'nonce',issuer:'iss',audience:'aud',expiry:'exp'}[invalid]]=invalid==='expiry'?1:'wrong';
  assert.equal((await f.send(callback)).status,403);assert.equal((await f.begin()).response.status,403);
});

test('absolute expiry fences starts and late verification results',async t=>{
  const f=await fixture(t),{callback}=await f.begin(),hold=f.hold(),pending=f.send(callback);await hold.started;
  f.expire();hold.release();const result=await pending;assert.notEqual(result.status,200);assert.equal(result.text.includes('verified-google-sub'),false);
  assert.equal((await f.begin()).response.status,503);assert.equal((await f.send('/livez')).body.mode,'disabled');
});

test('shutdown cancels verification and never exposes a late identity',async t=>{
  const f=await fixture(t),{callback}=await f.begin(),hold=f.hold(),pending=assert.rejects(f.send(callback));await hold.started;
  await f.running.close();hold.release();await pending;
});

test('listener startup failure is closed and restart cannot extend the original deadline',async t=>{
  const f=config(),running=await startOwnerVerification(f,{port:0,host:'127.0.0.1'});
  t.after(()=>running.close());
  await assert.rejects(startOwnerVerification(f,{port:running.address().port,host:'127.0.0.1'}),/startup_failed/);
  await running.close();
  await assert.rejects(startOwnerVerification(f,{port:0,host:'127.0.0.1',now:()=>Date.parse(f.expiresAt)+1}),/configuration/);
  // Ticket consumption is deliberately process-local, not durable. An operator
  // retry before the absolute deadline requires a fresh ticket/configuration.
  const restarted=await startOwnerVerification(f,{port:0,host:'127.0.0.1'});await restarted.close();
});

test('owner-verification config is private, bounded, and rejects all production/Photon inputs',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qs-owner-proof-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'owner-verification.local.json'),valid=config();writeFileSync(path,JSON.stringify(valid),{mode:0o600});
  assert.equal(loadOwnerVerification(path).issuer,issuer);
  for(const change of [{issuer:'http://quicksilver.example/'},{issuer:'https://quicksilver.example'},
    {expiresAt:new Date(Date.now()+601000).toISOString()},{expiresAt:new Date(Date.now()-1).toISOString()},
    {photon:{}},{localOAuth:{}},{setupTicket:'short'},{google:{...valid.google,fetch:'injection'}}])assert.throws(()=>validateOwnerVerification({...valid,...change}));
  chmodSync(path,0o644);assert.throws(()=>loadOwnerVerification(path));
  assert.deepEqual(readdirSync(dir),['owner-verification.local.json']);
});

test('verification CLI requires explicit selection and creates no databases or production credentials',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'qs-owner-cli-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'owner-verification.local.json');writeFileSync(path,JSON.stringify(config()),{mode:0o600});
  const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const refused=spawn(process.execPath,['owner-verification-server.mjs','--config',path],{env:{PORT:String(port)},stdio:'ignore'});
  assert.deepEqual(await once(refused,'exit'),[1,null]);
  const child=spawn(process.execPath,['owner-verification-server.mjs','--config',path,'--verify-owner'],{env:{PORT:String(port)},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});const exited=once(child,'exit');let output='';
  child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  for(let i=0;i<100&&!output.includes('Photon disabled')&&child.exitCode===null;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(child.exitCode,null,output);assert.match(output,/Photon disabled/);child.kill('SIGTERM');assert.deepEqual(await exited,[0,null]);
  for(const value of [ticket,path,'fixture-secret'])assert.equal(output.includes(value),false);
  assert.deepEqual(readdirSync(dir),['owner-verification.local.json']);
});
