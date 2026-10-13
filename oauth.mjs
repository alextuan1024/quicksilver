import { createRemoteJWKSet, jwtVerify } from 'jose';

const SCOPE = 'quicksilver:probe';
const MAX_SESSION_MS = 3600_000;
export function createOAuthGate({ issuer, resource, clientId, ownerSubject, expiresAt,
  now = Date.now, jwks } = {}) {
  // Configuration is trusted operator input, never derived from token claims or headers.
  const issuerUrl = new URL(issuer);
  const resourceUrl = new URL(resource);
  if (issuerUrl.protocol !== 'https:' || resourceUrl.protocol !== 'https:' ||
      issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash ||
      resourceUrl.username || resourceUrl.password || resourceUrl.search || resourceUrl.hash ||
      !issuer.endsWith('/')) throw new Error('Invalid OAuth configuration');
  const startedAt = now();
  const deadline = Date.parse(expiresAt);
  const configured = typeof clientId === 'string' && clientId.length > 0 &&
    typeof ownerSubject === 'string' && /^google-oauth2\|.+$/.test(ownerSubject) &&
    Number.isFinite(deadline) && deadline > startedAt && deadline <= startedAt + MAX_SESSION_MS;
  const keys = jwks ?? createRemoteJWKSet(new URL('.well-known/jwks.json', issuerUrl), {timeoutDuration:5000});
  const metadataUrl = new URL('/.well-known/oauth-protected-resource' + resourceUrl.pathname, resourceUrl).href;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${SCOPE}"`;
  const failure = (status, error) => ({status, body:{error}, headers:{'WWW-Authenticate':challenge}});
  return {
    get enabled() { return configured && now() < deadline; },
    metadata: { resource, authorization_servers:[issuer], scopes_supported:[SCOPE], bearer_methods_supported:['header'] },
    async authenticate(headers) {
      const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(headers.authorization ?? '');
      if (!match) return failure(401,'invalid_token');
      try {
        const {payload} = await jwtVerify(match[1],keys,{issuer,audience:resource,algorithms:['RS256'],typ:'at+jwt',
          requiredClaims:['sub','exp','iat','client_id','scope','jti'],currentDate:new Date(now()),clockTolerance:0});
        if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > Math.floor(now()/1000) ||
            payload.exp <= payload.iat || payload.exp-payload.iat > 3600 || typeof payload.jti !== 'string' || !payload.jti.length) return failure(401,'invalid_token');
        if (!configured || now() >= deadline) return failure(503,'owner_or_session_not_configured');
        if (payload.sub !== ownerSubject || payload.client_id !== clientId ||
            typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(SCOPE)) return failure(403,'insufficient_access');
        return {principal:{issuer,subject:payload.sub,clientId,scope:SCOPE}};
      } catch { return failure(401,'invalid_token'); }
    },
  };
}
