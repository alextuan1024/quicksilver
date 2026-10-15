const methods = new Set(['server/discover','initialize','notifications/initialized','ping','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
const versions = new Set(['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28']);
const outcomes = new Set(['invalid_token','owner_or_session_not_configured','insufficient_access','disabled_or_expired','method_not_allowed']);
const authFailures = new Set(['bearer_missing','bearer_malformed','jwt_malformed','jwt_expired','jwt_claim_invalid',
  'jwt_signature_invalid','jwt_algorithm_invalid','jwt_policy_invalid','jwks_key_invalid','jwks_unavailable','jwt_verification_failed']);
// Never include headers, IDs, arbitrary method names, parameters, token claims,
// callbacks, response bodies, or exception messages in diagnostic output.
export function requestSummary(method,path,body,headers,result) {
  if (path !== '/mcp') return null;
  const version = value => value == null ? 'absent' : versions.has(value) ? value : 'other';
  return {event:'mcp_request',method:method === 'POST' ? methods.has(body?.method) ? body.method : 'other' : 'non_post',
    requestedVersion:version(body?.params?.protocolVersion),headerVersion:version(headers['mcp-protocol-version']),
    status:result.status,outcome:outcomes.has(result.body?.error) ? result.body.error : result.body?.error ? 'rpc_error' : 'ok',
    ...(authFailures.has(result.authFailure) ? {authFailure:result.authFailure} : {})};
}

const transportPhases = new Set(['sdk_load','token_exchange','route_selection','client_create','subscription','stream','receive','send','shutdown']);
const grpcCategories = ['unknown','cancelled','unknown','invalid_argument','deadline_exceeded','not_found','already_exists',
  'permission_denied','resource_exhausted','failed_precondition','aborted','out_of_range','unimplemented','internal','unavailable','data_loss','unauthenticated'];
const transportCategories = new Set([...grpcCategories,'started','observed','stopped','transport_ended','transport_error',
  'transport_failed','token_expired','session_expired']);
const safeGrpcCode = code => Number.isInteger(code) && code >= 0 && code <= 16 ? code : null;
export function transportFailure(error) {
  // The SDK carries provider text/context on errors. Read only the numeric status.
  let grpcCode=null;
  try { grpcCode=safeGrpcCode(error?.grpcCode); } catch { /* No getters or raw errors escape. */ }
  return {category:grpcCode === null ? 'unknown' : grpcCategories[grpcCode],grpcCode};
}
export function transportSummary({phase,category,grpcCode,elapsedMs,heartbeatSeen,eventSeen}={}) {
  return {event:'photon_transport',phase:transportPhases.has(phase)?phase:'unknown',
    category:transportCategories.has(category)?category:'unknown',grpcCode:safeGrpcCode(grpcCode),
    elapsedMs:Number.isSafeInteger(elapsedMs) && elapsedMs>=0?elapsedMs:0,
    heartbeatSeen:heartbeatSeen===true,eventSeen:eventSeen===true};
}
export function logTransportDiagnostic(input) {
  console.log(JSON.stringify(transportSummary(input)));
}
