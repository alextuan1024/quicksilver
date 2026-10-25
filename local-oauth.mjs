import Provider,{errors} from 'oidc-provider';
import * as oidc from 'openid-client';
import {createHash,createPrivateKey,randomBytes} from 'node:crypto';
import {openOAuthStore} from './oauth-store.mjs';

const SCOPE='quicksilver:messages',GOOGLE='https://accounts.google.com';
const fail=()=>{throw new Error('invalid_local_oauth_configuration');};
function httpsUrl(value) {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search)fail();return url;
}
function validate(config) {
  const issuer=httpsUrl(config.issuer),resource=httpsUrl(config.resource);
  if(issuer.pathname!=='/'||config.issuer!==issuer.href||config.resource!==resource.href||
    issuer.origin!==resource.origin||resource.pathname!=='/mcp')fail();
  if(config.requestTimeoutMs!==undefined&&(!Number.isInteger(config.requestTimeoutMs)||config.requestTimeoutMs<1||config.requestTimeoutMs>10000))fail();
  for(const value of [config.ownerSubject,config.clientId,config.google?.clientId,config.google?.clientSecret])
    if(typeof value!=='string'||!value.length||value.length>512)fail();
  if(!Array.isArray(config.redirectUris)||!config.redirectUris.length||config.redirectUris.length>4)fail();
  config.redirectUris.forEach(httpsUrl);
  if(!Array.isArray(config.cookieKeys)||!config.cookieKeys.length||config.cookieKeys.some(k=>typeof k!=='string'||Buffer.byteLength(k)<32))fail();
  if(!Array.isArray(config.jwks?.keys)||!config.jwks.keys.length)fail();
  const kids=new Set();
  for(const key of config.jwks.keys){
    if(key.kty!=='RSA'||key.alg!=='RS256'||key.use!=='sig'||typeof key.kid!=='string'||!key.kid||kids.has(key.kid)||!key.d)fail();
    if(createPrivateKey({key,format:'jwk'}).asymmetricKeyDetails.modulusLength<2048)fail();kids.add(key.kid);
  }
  return issuer;
}
const digest=value=>createHash('sha256').update(value).digest('base64url');
function cookie(headers,name) {
  const matches=(headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));
  return matches.length===1?matches[0].slice(name.length+1):null;
}
function json(res,status,body) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(body));
}

// Trusted composition only. Keys and Google credentials are supplied by the host;
// construction does not contact Google, connect Photon or change the parked runtime.
export function createLocalOAuth(config) {
  const issuerUrl=validate(config),{issuer,resource,clientId,ownerSubject}=config;
  const now=config.now??Date.now,deadline=Date.parse(config.expiresAt),started=now();
  const sessionConfigured=Number.isFinite(deadline)&&deadline>started&&deadline<=started+3600000;
  const store=openOAuthStore({path:config.databasePath,identity:{issuer,resource,clientId,ownerSubject}});
  let provider,google;
  try {
    google=new oidc.Configuration({issuer:GOOGLE,authorization_endpoint:GOOGLE+'/o/oauth2/v2/auth',
      token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',
      id_token_signing_alg_values_supported:['RS256']},config.google.clientId,config.google.clientSecret);
    if(config.google.fetch)google[oidc.customFetch]=config.google.fetch;
    google.timeout=5;oidc.enableNonRepudiationChecks(google);
    provider=new Provider(issuer,{
      adapter:store.Adapter,jwks:structuredClone(config.jwks),
      clients:[{client_id:clientId,redirect_uris:[...config.redirectUris],response_types:['code'],
        grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'}],
      responseTypes:['code'],scopes:['openid','offline_access'],claims:{openid:['sub']},
      pkce:{required:()=>true},rotateRefreshToken:true,issueRefreshToken:()=>true,
      expiresWithSession:()=>false,clockTolerance:0,
      ttl:{AccessToken:300,IdToken:300,AuthorizationCode:60,Interaction:300,Session:86400,Grant:2592000,
        RefreshToken:(_ctx,token)=>Math.max(0,(token.iiat??Math.floor(Date.now()/1000))+2592000-Math.floor(Date.now()/1000))},
      cookies:{keys:[...config.cookieKeys],long:{secure:true,httpOnly:true,sameSite:'lax'},
        short:{secure:true,httpOnly:true,sameSite:'lax'},
        names:{session:'__Host-quicksilver_session',interaction:'__Secure-quicksilver_interaction',resume:'__Secure-quicksilver_resume'}},
      features:{devInteractions:{enabled:false},registration:{enabled:false},userinfo:{enabled:false},
        clientIdMetadataDocument:{enabled:false},rpInitiatedLogout:{enabled:false},
        pushedAuthorizationRequests:{enabled:false},dPoP:{enabled:false},
        revocation:{enabled:true,allowedPolicy:(_ctx,client,token)=>client.clientId===clientId&&token.clientId===clientId},resourceIndicators:{enabled:true,
          defaultResource:()=>resource,useGrantedResource:()=>true,
          getResourceServerInfo:(_ctx,indicator)=>{
            if(indicator!==resource)throw new errors.InvalidTarget();
            return {scope:SCOPE,audience:resource,accessTokenTTL:300,accessTokenFormat:'opaque'};
          }}},
      interactions:{url:()=>issuer+'interaction'},
      findAccount:async(_ctx,id)=>id===ownerSubject?{accountId:id,claims:async()=>({sub:id})}:undefined,
      renderError:async(ctx)=>{ctx.status=400;ctx.type='application/json';ctx.body={error:'authorization_failed'};},
    });
    provider.proxy=config.trustProxy===true;
    // Never write provider error messages or token-bearing request URLs to logs.
    provider.on('server_error',()=>{});
    provider.on('error',()=>{}); // Koa transport errors otherwise log raw stacks.
  } catch(error){store.close();throw error;}
  let closed=false,tail=Promise.resolve(),queued=0,closePromise;
  const active=()=>!closed&&sessionConfigured&&now()<deadline;
  const challenge=`Bearer resource_metadata="${issuer}.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;
  const denied=(status,error)=>({status,body:{error},headers:{'WWW-Authenticate':challenge}});
  const gate={
    get enabled(){return active();},
    metadata:{resource,authorization_servers:[issuer],scopes_supported:[SCOPE],bearer_methods_supported:['header']},
    async authenticate(headers,{requireSession=true}={}) {
      if(closed)return denied(503,'authorization_unavailable');
      const match=/^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(headers.authorization??'');
      if(!match)return denied(401,'invalid_token');
      try {
        const token=await provider.AccessToken.find(match[1]);
        if(!token)return denied(401,'invalid_token');
        const grant=await provider.Grant.find(token.grantId);
        if(!grant)return denied(401,'invalid_token');
        if(token.isSenderConstrained()||token.accountId!==ownerSubject||token.clientId!==clientId||token.aud!==resource||
          !token.scope?.split(' ').includes(SCOPE)||grant.accountId!==ownerSubject||grant.clientId!==clientId)
          return denied(403,'insufficient_access');
        if(requireSession&&!active())return denied(503,'owner_or_session_not_configured');
        return {principal:{issuer,subject:ownerSubject,clientId,scope:SCOPE}};
      }catch{return denied(401,'invalid_token');}
    },
  };
  const callback=provider.callback();
  async function interaction(req,res,url) {
    try {
      const details=await provider.interactionDetails(req,res);
      if(details.params.client_id!==clientId)throw new Error();
      if(url.pathname==='/interaction'){
        const state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
        const browser=randomBytes(32).toString('base64url');
        store.saveLogin(state,{uid:details.uid,browser:digest(browser),nonce,verifier},300);
        const target=oidc.buildAuthorizationUrl(google,{redirect_uri:issuer+'interaction/google/callback',scope:'openid',
          state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',prompt:'select_account'});
        res.setHeader('Set-Cookie',`__Host-quicksilver_login=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300`);
        res.writeHead(303,{Location:target.href});res.end();return;
      }
      const state=url.searchParams.get('state'),browser=cookie(req.headers,'__Host-quicksilver_login');
      if(!state||!browser)throw new Error();
      const login=store.takeLogin(state,digest(browser));
      if(!login||login.uid!==details.uid)throw new Error();
      const tokens=await oidc.authorizationCodeGrant(google,url,{pkceCodeVerifier:login.verifier,expectedState:state,expectedNonce:login.nonce,idTokenExpected:true});
      if(req.destroyed||res.destroyed||closed||tokens.claims()?.sub!==ownerSubject)throw new Error();
      // This deployment pre-authorizes exactly one owner/client/resource/scope.
      const grant=new provider.Grant({accountId:ownerSubject,clientId});
      grant.addOIDCScope('openid offline_access');grant.addResourceScope(resource,SCOPE);
      const grantId=await grant.save();
      res.setHeader('Set-Cookie','__Host-quicksilver_login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
      await provider.interactionFinished(req,res,{login:{accountId:ownerSubject},consent:{grantId}},{mergeWithLastSubmission:false});
    }catch{if(!res.headersSent)json(res,403,{error:'login_failed'});else res.end();}
  }
  const acceptsRequest=req=>req.headers.host===issuerUrl.host&&!req.headers['x-forwarded-host']&&
    Boolean(req.socket.encrypted||(config.trustProxy===true&&req.headers['x-forwarded-proto']==='https'));
  async function dispatch(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    if(closed){json(res,503,{error:'authorization_unavailable'});return;}
    if(!acceptsRequest(req)){json(res,400,{error:'invalid_request_origin'});return;}
    if(req.url.length>8192||!req.url.startsWith('/')||req.url.startsWith('//')){json(res,400,{error:'invalid_request'});return;}
    const url=new URL(req.url,issuer);
    if(['/interaction','/interaction/google/callback'].includes(url.pathname)){
      if(req.method!=='GET'){json(res,405,{error:'method_not_allowed'});return;}
      await interaction(req,res,url);return;
    }
    if(url.pathname==='/auth'){
      if(req.method!=='GET'){json(res,405,{error:'method_not_allowed'});return;}
      const scopes=(url.searchParams.get('scope')??'').split(' ');
      if(!scopes.includes(SCOPE)||scopes.some(s=>!['openid','offline_access',SCOPE].includes(s))){json(res,400,{error:'invalid_scope'});return;}
      if(url.searchParams.getAll('resource').length!==1||url.searchParams.get('resource')!==resource){json(res,400,{error:'invalid_target'});return;}
    }
    const publicPaths=new Set(['/auth','/token','/token/revocation','/jwks','/.well-known/oauth-authorization-server','/.well-known/openid-configuration']);
    if(!publicPaths.has(url.pathname)&&!/^\/auth\/[A-Za-z0-9_-]+$/.test(url.pathname)){json(res,404,{error:'not_found'});return;}
    // MCP uses OAuth discovery; the provider also offers OIDC discovery.
    if(url.pathname==='/.well-known/oauth-authorization-server')req.url='/.well-known/openid-configuration';
    await callback(req,res);
  }
  return {gate,acceptsRequest,
    // Serialize authorization state transitions so simultaneous refresh/code
    // exchanges cannot both pass a read-before-consume check in the library.
    handle(req,res) {
      if(closed||queued>=32){json(res,503,{error:'authorization_unavailable'});return Promise.resolve();}
      queued++;
      const job=tail.then(async()=>{
        if(req.destroyed||res.destroyed)return;
        const deadline=setTimeout(()=>req.destroy(),config.requestTimeoutMs??10000);deadline.unref();
        try{await dispatch(req,res);}finally{clearTimeout(deadline);}
      }).catch(()=>{if(!res.headersSent&&!res.destroyed)json(res,500,{error:'authorization_failed'});else res.end();}).finally(()=>{queued--;});
      tail=job;return job;
    },
    revokeGrant(id){if(closed)throw new Error('authorization_unavailable');store.revokeGrant(id);},
    close(){if(!closePromise){closed=true;closePromise=tail.then(()=>store.close());}return closePromise;},
  };
}
