// Explicit, temporary Google identity proof. No Photon, MCP provider, app keys,
// databases, owner assignment, or automatic transition to the production host.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import * as oidc from 'openid-client';
import {readPrivateFile} from './production-config.mjs';
import {renderOriginGuard,renderPort} from './platform-listener.mjs';

const GOOGLE='https://accounts.google.com',COOKIE='__Host-quicksilver_owner_proof';
const digest=value=>createHash('sha256').update(value).digest();
const fail=()=>{throw Error('invalid_owner_verification_configuration');};
function fields(value,keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))fail();
}
export function validateOwnerVerification(config,now=Date.now()) {
  fields(config,['issuer','expiresAt','google','setupTicket']);fields(config.google,['clientId','clientSecret']);
  const url=new URL(config.issuer),deadline=Date.parse(config.expiresAt);
  if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||url.username||url.password||url.href!==config.issuer||
    typeof config.expiresAt!=='string'||!Number.isFinite(deadline)||deadline<=now||deadline>now+600000)fail();
  for(const value of [config.google.clientId,config.google.clientSecret])if(typeof value!=='string'||!value.length||value.length>512)fail();
  if(typeof config.setupTicket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(config.setupTicket)||
    Buffer.from(config.setupTicket,'base64url').toString('base64url')!==config.setupTicket)fail();
  return config;
}
export function loadOwnerVerification(path) {
  try{return validateOwnerVerification(JSON.parse(readPrivateFile(path)));}catch{fail();}
}
function send(res,status,body,type='application/json') {
  if(!res.destroyed)res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'"})
    .end(type==='application/json'?JSON.stringify(body):body);
}
const unavailable=res=>send(res,503,{error:'verification_unavailable'});
function browserCookie(req) {
  const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
  return values.length===1?values[0].slice(COOKIE.length+1):null;
}

export async function startOwnerVerification(config,{port=renderPort(),host='0.0.0.0',fetchGoogle=globalThis.fetch,now=Date.now}={}) {
  validateOwnerVerification(config,now());
  const issuer=config.issuer,origin=new URL(issuer).origin,callback=issuer+'interaction/google/callback';
  const deadline=Date.parse(config.expiresAt),guard=renderOriginGuard(issuer),lifetime=new AbortController();
  const ticketHash=digest(config.setupTicket);let phase='unused',transaction,stopped=false,closing,server;
  const active=()=>!stopped&&!lifetime.signal.aborted&&now()<deadline;
  const google=new oidc.Configuration({issuer:GOOGLE,authorization_endpoint:GOOGLE+'/o/oauth2/v2/auth',
    token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs',
    id_token_signing_alg_values_supported:['RS256']},config.google.clientId,config.google.clientSecret);
  google.timeout=5;oidc.enableNonRepudiationChecks(google);
  google[oidc.customFetch]=(url,options)=>{
    if(!active())throw Error('verification_inactive');
    if(!['https://oauth2.googleapis.com/token','https://www.googleapis.com/oauth2/v3/certs'].includes(String(url)))throw Error('unexpected_google_endpoint');
    return fetchGoogle(url,{...options,signal:AbortSignal.any([lifetime.signal,...(options?.signal?[options.signal]:[])])});
  };
  const expiry=setTimeout(()=>{transaction=null;lifetime.abort();},deadline-now());expiry.unref();
  async function handle(req,res) {
    try {
      if(stopped){unavailable(res);return;}
      if(req.method==='GET'&&req.url==='/livez'){
        send(res,200,{mode:active()?'owner-verification':'disabled',photon:'disabled'});return;
      }
      if(!guard(req)||req.url.length>8192||!req.url.startsWith('/')||req.url.startsWith('//')){send(res,400,{error:'invalid_request'});return;}
      if(!active()){unavailable(res);return;}
      const url=new URL(req.url,issuer);
      if(req.method==='GET'&&req.url==='/setup/owner'&&phase==='unused') {
        send(res,200,'<!doctype html><meta charset="utf-8"><title>Verify Google identity</title><h1>Verify Google identity</h1><p>This does not select an owner or enable messaging. Choose the intended owner account in Google.</p><form method="post" action="/setup/owner/start"><label>One-time setup ticket <input type="password" name="ticket" autocomplete="off" required></label><button>Continue to Google</button></form>','text/html; charset=utf-8');return;
      }
      if(req.method==='POST'&&req.url==='/setup/owner/start') {
        if(req.headers.origin!==origin||!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')){
          send(res,403,{error:'verification_denied'});return;
        }
        const chunks=[];let size=0;
        for await(const chunk of req.iterator({destroyOnReturn:false})){
          size+=chunk.length;if(size>1024){send(res,413,{error:'request_too_large'});return;}chunks.push(chunk);
        }
        const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),value=form.get('ticket');
        if(!active()){unavailable(res);return;}
        if(phase!=='unused'||[...form.keys()].length!==1||!value||!timingSafeEqual(digest(value),ticketHash)){
          send(res,403,{error:'verification_denied'});return;
        }
        phase='starting'; // Consume before the first await; single-use per process.
        const browser=randomBytes(32).toString('base64url');
        const record={state:oidc.randomState(),nonce:oidc.randomNonce(),verifier:oidc.randomPKCECodeVerifier(),browser:digest(browser)};
        const challenge=await oidc.calculatePKCECodeChallenge(record.verifier);
        if(!active()||res.destroyed){phase='finished';unavailable(res);return;}
        transaction=record;phase='waiting';
        const target=oidc.buildAuthorizationUrl(google,{redirect_uri:callback,scope:'openid',state:record.state,nonce:record.nonce,
          code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'});
        res.setHeader('Set-Cookie',`${COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1,Math.floor((deadline-now())/1000))}`);
        res.setHeader('Location',target.href);send(res,303,{status:'continue_at_google'});return;
      }
      if(req.method==='GET'&&url.pathname==='/interaction/google/callback') {
        const browser=browserCookie(req),state=url.searchParams.get('state'),record=transaction;
        if(phase!=='waiting'||!record||url.searchParams.getAll('state').length!==1||state!==record.state||!browser||
          !timingSafeEqual(digest(browser),record.browser)){send(res,403,{error:'verification_denied'});return;}
        transaction=null;phase='exchanging'; // At most one exchange for this transaction.
        try {
          const tokens=await oidc.authorizationCodeGrant(google,url,{pkceCodeVerifier:record.verifier,
            expectedState:record.state,expectedNonce:record.nonce,idTokenExpected:true});
          const claims=tokens.claims();
          if(!active()||res.destroyed){unavailable(res);return;}
          if(typeof claims?.sub!=='string'||!claims.sub.length||claims.sub.length>512)throw Error();
          res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
          send(res,200,{verified:true,issuer:GOOGLE,subject:claims.sub,googleClientId:config.google.clientId,
            ownerPinned:false,photon:'disabled'});
        }catch{send(res,403,{error:'verification_failed'});}finally{phase='finished';}
        return;
      }
      unavailable(res);
    }catch{send(res,400,{error:'verification_failed'});}
  }
  server=createServer((req,res)=>{
    const timeout=setTimeout(()=>req.destroy(),10000);timeout.unref();
    void handle(req,res).finally(()=>clearTimeout(timeout));
  });
  server.headersTimeout=10000;server.requestTimeout=10000;server.timeout=10000;server.keepAliveTimeout=1000;
  const close=()=>{
    if(!closing){stopped=true;transaction=null;lifetime.abort();clearTimeout(expiry);
      closing=new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
    return closing;
  };
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});}
  catch{await close();throw Error('owner_verification_startup_failed');}
  return {address:()=>server.address(),close};
}

export async function main(args=process.argv.slice(2)) {
  let running;const stop=new AbortController(),onSignal=()=>stop.abort();
  try {
    const [major,minor,patch]=process.versions.node.split('.').map(Number);
    if(major!==22||minor<23||(minor===23&&patch<4)||args.length!==3||args[0]!=='--config'||args[2]!=='--verify-owner')throw Error();
    const config=loadOwnerVerification(args[1]),port=renderPort();
    process.once('SIGTERM',onSignal);process.once('SIGINT',onSignal);
    if(stop.signal.aborted)throw Error();
    running=await startOwnerVerification(config,{port});
    console.log('quicksilver owner verification; Photon disabled');
    await new Promise(resolve=>{if(stop.signal.aborted)resolve();else stop.signal.addEventListener('abort',resolve,{once:true});});
  }catch{console.error('quicksilver owner verification failed');process.exitCode=1;}
  finally{await running?.close();process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
