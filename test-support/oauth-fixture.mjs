import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createHash,randomBytes} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';

export const issuer='https://quicksilver.example/';
export const resource=issuer+'mcp';
export const redirect='https://chatgpt.example/oauth/callback';
export const scope='quicksilver:messages';
export const verifier='a'.repeat(64);
export const challenge=createHash('sha256').update(verifier).digest('base64url');
export async function oauthFixture(t,create,{addressOf,requestHeaders={},localAddress}={}) {
  const dir=mkdtempSync(join(tmpdir(),'qs-local-auth-'));
  const signing=await generateKeyPair('RS256',{extractable:true});
  const googleKey=await generateKeyPair('RS256',{extractable:true});
  const googlePublic={...await exportJWK(googleKey.publicKey),kid:'google',alg:'RS256',use:'sig'};
  const codes=new Map();let running,server,address;const cookies=new Map(),cookiePaths=new Map();
  const google={clientId:'google-client',clientSecret:'fixture-google-secret',
    async fetch(url,options) {
      url=String(url);
      if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[googlePublic]});
      assert.equal(url,'https://oauth2.googleapis.com/token');
      const body=new URLSearchParams(options.body);const record=codes.get(body.get('code'));codes.delete(body.get('code'));
      if(!record)return Response.json({error:'invalid_grant'},{status:400});
      assert.equal(body.get('grant_type'),'authorization_code');
      assert.equal(body.get('redirect_uri'),issuer+'interaction/google/callback');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'),record.challenge);
      let token=await new SignJWT({nonce:record.nonce,iss:'https://accounts.google.com',sub:record.subject,aud:'google-client',
        iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...record.claims})
        .setProtectedHeader({alg:'RS256',kid:'google'}).sign(googleKey.privateKey);
      if(record.tamperSignature){const pieces=token.split('.');pieces[2]=(pieces[2][0]==='a'?'b':'a')+pieces[2].slice(1);token=pieces.join('.');}
      return Response.json({access_token:'fixture-upstream-access',token_type:'Bearer',expires_in:300,id_token:token});
    }};
  const config={issuer,resource,clientId:'athena',ownerSubject:'google-owner',redirectUris:[redirect],
    databasePath:join(dir,'oauth.sqlite'),jwks:{keys:[{...await exportJWK(signing.privateKey),kid:'local',alg:'RS256',use:'sig'}]},
    cookieKeys:[randomBytes(32).toString('base64url')],google,trustProxy:true,
    expiresAt:new Date(Date.now()+600000).toISOString()};
  async function start() {
    running=await create(config);
    // Integration drills may supply an already-listening production process.
    if(addressOf){address=addressOf(running);return;}
    server=createServer((req,res)=>{void running.handle(req,res);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));address=`http://127.0.0.1:${server.address().port}`;
  }
  async function stop(){if(server){await new Promise(resolve=>server.close(resolve));server=null;}if(running)await running.close();}
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
  await start();
  async function request(path,{method='GET',form,json,raw,headers={}}={}) {
    const res=await new Promise((resolve,reject)=>{
      const req=httpRequest(address+path,{method,localAddress,headers:{host:'quicksilver.example','x-forwarded-proto':'https',
        cookie:[...cookies].filter(([k])=>{const p=cookiePaths.get(k)??'/';return path.split('?')[0]===p||path.startsWith(p.endsWith('/')?p:p+'/');}).map(([k,v])=>`${k}=${v}`).join('; '),
        ...(form?{'content-type':'application/x-www-form-urlencoded'}:{}),...(json?{'content-type':'application/json'}:{}),...requestHeaders,...headers}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});
        response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));
        response.on('error',reject);
      });req.on('error',reject);req.end(form?new URLSearchParams(form).toString():json?JSON.stringify(json):raw);
    });
    for(const cookie of res.headers['set-cookie']??[]){const pair=cookie.split(';')[0],i=pair.indexOf('=');const name=pair.slice(0,i);cookies.set(name,pair.slice(i+1));cookiePaths.set(name,/; path=([^;]+)/i.exec(cookie)?.[1]??'/');
      if(name.startsWith('__Host-')){assert.equal(cookiePaths.get(name),'/');assert.ok(/; secure/i.test(cookie));assert.ok(!/; domain=/i.test(cookie));}}
    const text=res.text;let body;try{body=JSON.parse(text);}catch{body=text;}
    return {status:res.status,body,location:res.headers.location,headers:res.headers};
  }
  const path=url=>{const u=new URL(url,issuer);assert.equal(u.origin,new URL(issuer).origin);return u.pathname+u.search;};
  function authorizeGoogle(location,{subject='google-owner',nonce,claims={},tamperSignature=false}={}) {
    const url=new URL(location);assert.equal(url.origin,'https://accounts.google.com');
    assert.equal(url.searchParams.get('client_id'),'google-client');
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    const code=randomBytes(24).toString('base64url');
    codes.set(code,{subject,tamperSignature,nonce:nonce??url.searchParams.get('nonce'),claims,challenge:url.searchParams.get('code_challenge')});
    const callback=new URL(url.searchParams.get('redirect_uri'));
    callback.searchParams.set('code',code);callback.searchParams.set('state',url.searchParams.get('state'));return path(callback);
  }
  async function begin(overrides={}) {
    return request('/auth?'+new URLSearchParams({client_id:'athena',redirect_uri:redirect,response_type:'code',scope:`openid offline_access ${scope}`,
      resource,state:'client-state',code_challenge:challenge,code_challenge_method:'S256',prompt:'consent',...overrides}));
  }
  async function login(options={}) {
    let r=await begin(options.auth);assert.equal(r.status,303,JSON.stringify(r));
    r=await request(path(r.location));assert.equal(r.status,303,JSON.stringify(r));
    const callback=authorizeGoogle(r.location,options);r=await request(callback);
    if(r.status!==303)return {response:r,callback};
    for(let i=0;i<5&&r.location?.startsWith(issuer);i++)r=await request(path(r.location));
    const target=new URL(r.location);assert.equal(target.origin,'https://chatgpt.example',JSON.stringify(r));
    assert.equal(target.searchParams.get('state'),'client-state');
    assert.equal(target.searchParams.has('error'),false,target.href);
    return {code:target.searchParams.get('code'),callback,response:r};
  }
  const exchange=(code,extra={})=>request('/token',{method:'POST',form:{client_id:'athena',grant_type:'authorization_code',code,
    redirect_uri:redirect,code_verifier:verifier,resource,...extra}});
  const refresh=token=>request('/token',{method:'POST',form:{client_id:'athena',grant_type:'refresh_token',refresh_token:token,resource}});
  return {config,request,begin,login,exchange,refresh,path,authorizeGoogle,cookies,
    get address(){return address;},get auth(){return running;},async restart(){await stop();await start();}};
}
