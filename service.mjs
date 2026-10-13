import { createOAuthGate } from './oauth.mjs';
import { createBridge } from './bridge.mjs';

export function createService(config) {
  const gate = createOAuthGate(config);
  const bridge = createBridge({expiresAt:config.expiresAt,now:config.now,
    authorize:headers=>gate.authenticate(headers)});
  return { async handle(method,path,headers,body) {
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return {status:method === 'GET' ? 200 : 405,body:method === 'GET' ? gate.metadata : {error:'method_not_allowed'}};
    }
    if (method === 'GET' && path === '/healthz') return {status:200,body:{service:'quicksilver',mode:gate.enabled?'synthetic-session':'disabled',syntheticOnly:true}};
    // Only the approved owner-gated, empty-argument MCP tool may initiate a proof.
    // Keep this direct HTTP route inaccessible, including to valid OAuth tokens.
    if (path === '/proof') return {status:403,body:{error:'operator_trigger_not_configured'}};
    if (path !== '/mcp') return {status:404,body:{error:'not_found'}};
    const auth = await gate.authenticate(headers);
    if (!auth.principal) return auth;
    return bridge.handle(method,path,headers,body);
  }};
}
