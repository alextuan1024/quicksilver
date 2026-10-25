import {createLocalOAuth} from './local-oauth.mjs';
import {createMessageService} from './message-service.mjs';

function send(res,result) {
  res.writeHead(result.status,{'Content-Type':'application/json','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',...result.headers});
  res.end(result.body===null?'':JSON.stringify(result.body));
}
const error=(res,status,code)=>send(res,{status,body:{error:code}});

// Explicit host composition; neither runtime.mjs nor server.mjs selects this.
// The host owns TLS/proxy configuration, the HTTP listener and Photon lifecycle.
export async function createLocalMessageService(config) {
  const local={...config.localOAuth,expiresAt:config.expiresAt,now:config.now};
  const auth=createLocalOAuth(local);let messages;
  try {
    messages=createMessageService({...config,issuer:local.issuer,resource:local.resource,
      clientId:local.clientId,ownerSubject:local.ownerSubject,authorizationGate:auth.gate});
  }catch(error){await auth.close();throw error;}
  let closed=false,closePromise;
  const paths=new Set(['/mcp','/healthz','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']);
  return {messages,gate:auth.gate,
    async handle(req,res) {
      if(closed){error(res,503,'service_stopped');return;}
      if(!auth.acceptsRequest(req)){error(res,400,'invalid_request_origin');return;}
      if(req.url.length>8192||!req.url.startsWith('/')||req.url.startsWith('//')){error(res,400,'invalid_request');return;}
      const url=new URL(req.url,local.issuer);
      if(!paths.has(url.pathname)){await auth.handle(req,res);return;}
      if(url.search){error(res,400,'invalid_request');return;}
      if(req.headers.origin){error(res,403,'browser_origin_not_allowed');return;}
      const deadline=setTimeout(()=>req.destroy(),10000);deadline.unref();
      try {
        const chunks=[];let length=0;
        for await(const chunk of req.iterator({destroyOnReturn:false})){
          length+=chunk.length;
          if(length>16384){error(res,413,'too_large');return;}
          chunks.push(chunk);
        }
        let body={};
        if(length){try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{error(res,400,'invalid_json');return;}}
        if(closed){error(res,503,'service_stopped');return;}
        send(res,await messages.handle(req.method,url.pathname,req.headers,body));
      }catch{if(!res.headersSent&&!res.destroyed)error(res,500,'request_failed');}
      finally{clearTimeout(deadline);}
    },
    revokeGrant:id=>auth.revokeGrant(id),
    close(){
      if(!closePromise){closed=true;closePromise=Promise.allSettled([auth.close(),messages.stop()]).then(results=>{
        if(results.some(r=>r.status==='rejected'))throw new Error('service_shutdown_failed');
      });}return closePromise;
    },
  };
}
