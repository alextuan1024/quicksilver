import { createOAuthGate } from './oauth.mjs';
import { createBridge, isDiscoveryRequest } from './bridge.mjs';
import {createPhotonTest,photonEvent,photonTools} from './photon.mjs';

export function createService(config) {
  const gate = createOAuthGate(config);
  const bridge = createBridge({expiresAt:config.expiresAt,now:config.now,
    authorize:(headers,options)=>gate.authenticate(headers,options)});
  let photon;
  const photonBridge=createBridge({expiresAt:config.expiresAt,now:config.now,
    authorize:(headers,options)=>gate.authenticate(headers,options),event:photonEvent,tools:photonTools,
    postCallback:config.postCallback,onTool:(name,args)=>photon.call(name,args)});
  photon=createPhotonTest({config:config.photon,transport:config.photonTransport,
    expiresAt:config.expiresAt,now:config.now,ready:()=>gate.enabled && photonBridge.hasSubscription(),
    publish:(data,guard)=>photonBridge.publish(data,guard)});
  return {stop:()=>photon.stop(),async handle(method,path,headers,body) {
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return {status:method === 'GET' ? 200 : 405,body:method === 'GET' ? gate.metadata : {error:'method_not_allowed'}};
    }
    if (method === 'GET' && path === '/healthz') return {status:200,body:{service:'quicksilver',mode:gate.enabled?'synthetic-session':'disabled',syntheticOnly:!config.photonTransport,photon:config.photonTransport?photon.status().state:'disabled',photonTransport:config.photonTransport?'fixture_or_reviewed_transport':'locked_pending_sdk_review'}};
    // Only the approved owner-gated, empty-argument MCP tool may initiate a proof.
    // Keep this direct HTTP route inaccessible, including to valid OAuth tokens.
    if (path === '/proof') return {status:403,body:{error:'operator_trigger_not_configured'}};
    if (path !== '/mcp') return {status:404,body:{error:'not_found'}};
    const auth = await gate.authenticate(headers,{requireSession:!isDiscoveryRequest(method,path,body)});
    if (!auth.principal) return auth;
    if (method==='POST' && ['tools/list','events/list'].includes(body?.method)) {
      const result=await bridge.handle(method,path,headers,body);
      if(result.body?.result) {
        const field=body.method==='tools/list'?'tools':'events';
        result.body.result[field].push(...(field==='tools'?photonTools:[photonEvent]));
      }
      return result;
    }
    if ((body?.method==='tools/call' && photonTools.some(t=>t.name===body.params?.name)) ||
        (['events/subscribe','events/unsubscribe'].includes(body?.method) && body.params?.name===photonEvent.name))
      return photonBridge.handle(method,path,headers,body);
    return bridge.handle(method,path,headers,body);
  }};
}
