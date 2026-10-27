import {isIP} from 'node:net';

// Map IPv4 and IPv4-mapped IPv6 peers to the same exact address. No CIDRs,
// wildcard trust, hop counts, or client-provided address headers are accepted.
export function addressKey(value) {
  const family=typeof value==='string'?isIP(value):0;
  if(!family)throw new Error('invalid_proxy_address');
  return new URL(`http://[${family===4?'::ffff:'+value:value}]/`).hostname;
}
export function platformGuard(listener,issuer) {
  const peers=new Set(listener.trustedProxyAddresses.map(addressKey));
  const host=new URL(issuer).host;
  return req=>{
    let peer;try{peer=addressKey(req.socket.remoteAddress);}catch{return false;}
    if(!peers.has(peer))return false;
    const count=name=>req.rawHeaders.filter((_,i)=>i%2===0&&req.rawHeaders[i].toLowerCase()===name).length;
    if(count('host')!==1||count('x-forwarded-proto')!==1||count('forwarded')||count('x-forwarded-host'))return false;
    if(req.headers.host!==host||req.headers['x-forwarded-proto']!=='https')return false;
    // Never expose a client-selected IP to downstream proxy-aware libraries.
    delete req.headers['x-forwarded-for'];
    req.rawHeaders=req.rawHeaders.filter((_,i)=>req.rawHeaders[i-i%2].toLowerCase()!=='x-forwarded-for');
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
