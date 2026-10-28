// Explicit Render deployment mode: public TLS terminates at the platform edge.
// Supply the configured external origin to proxy-aware OAuth internals without
// trusting any caller's forwarding metadata or treating network peers as users.
export function renderOriginGuard(issuer) {
  const url=new URL(issuer),host=url.host;
  if(url.protocol!=='https:')throw new Error('invalid_external_origin');
  const forwarding=name=>name==='forwarded'||name.startsWith('x-forwarded-')||name==='x-real-ip';
  return req=>{
    const count=name=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
    if(count('host')!==1||req.headers.host!==host)return false;
    for(const name of Object.keys(req.headers))if(forwarding(name.toLowerCase()))delete req.headers[name];
    req.rawHeaders=req.rawHeaders.filter((_,i)=>!forwarding(req.rawHeaders[i-i%2].toLowerCase()));
    // oidc-provider uses this for secure cookies AND URL construction, including
    // contexts created outside its callback middleware (interactionDetails).
    req.headers['x-forwarded-proto']='https';
    req.rawHeaders.push('X-Forwarded-Proto','https');
    return true;
  };
}
export function renderPort(env=process.env) {
  const value=env.PORT;
  if(typeof value!=='string'||!/^[1-9]\d{0,4}$/.test(value)||Number(value)>65535||[18012,18013,19099].includes(Number(value)))
    throw new Error('invalid_render_port');
  return Number(value);
}
export function liveness(req,res) {
  if(req.url!=='/livez'||req.method!=='GET')return false;
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"status":"listening"}');
  return true;
}
