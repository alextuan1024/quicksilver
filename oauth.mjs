import { createRemoteJWKSet, jwtVerify, errors } from 'jose';

const SCOPE = 'quicksilver:probe';
const MAX_SESSION_MS = 3600_000;
// Inspect only error classes; never retain messages, claims, headers, or causes.
function verificationFailure(error) {
  if (error instanceof errors.JWTExpired) return 'jwt_expired';
  if (error instanceof errors.JWTClaimValidationFailed) return 'jwt_claim_invalid';
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'jwt_signature_invalid';
  if (error instanceof errors.JOSEAlgNotAllowed) return 'jwt_algorithm_invalid';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return 'jwt_malformed';
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys ||
      error instanceof errors.JWKInvalid || error instanceof errors.JWKSInvalid) return 'jwks_key_invalid';
  return 'jwt_verification_failed';
}
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
      // This field is internal: server.mjs serializes only body/headers to HTTP.
      const invalid = authFailure => ({...failure(401,'invalid_token'),authFailure});
      if (!match) return invalid(headers.authorization == null ? 'bearer_missing' : 'bearer_malformed');
      let keyFailure;
      const resolveKeys = typeof keys === 'function' ? async (...args) => {
        try { return await keys(...args); }
        catch (error) {
          keyFailure = verificationFailure(error);
          if (keyFailure === 'jwt_verification_failed') keyFailure = 'jwks_unavailable';
          throw error;
        }
      } : keys;
      try {
        const {payload} = await jwtVerify(match[1],resolveKeys,{issuer,audience:resource,algorithms:['RS256'],typ:'at+jwt',
          requiredClaims:['sub','exp','iat','client_id','scope','jti'],currentDate:new Date(now()),clockTolerance:0});
        if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > Math.floor(now()/1000) ||
            payload.exp <= payload.iat || payload.exp-payload.iat > 3600 || typeof payload.jti !== 'string' || !payload.jti.length) return invalid('jwt_policy_invalid');
        if (!configured || now() >= deadline) return failure(503,'owner_or_session_not_configured');
        if (payload.sub !== ownerSubject || payload.client_id !== clientId ||
            typeof payload.scope !== 'string' || !payload.scope.split(' ').includes(SCOPE)) return failure(403,'insufficient_access');
        return {principal:{issuer,subject:payload.sub,clientId,scope:SCOPE}};
      } catch (error) { return invalid(keyFailure ?? verificationFailure(error)); }
    },
  };
}
