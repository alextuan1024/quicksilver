const methods = new Set(['server/discover','initialize','notifications/initialized','ping','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
const versions = new Set(['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28']);
const outcomes = new Set(['invalid_token','owner_or_session_not_configured','insufficient_access','disabled_or_expired','method_not_allowed']);
// Never include headers, IDs, arbitrary method names, parameters, token claims,
// callbacks, response bodies, or exception messages in diagnostic output.
export function requestSummary(method,path,body,headers,result) {
  if (path !== '/mcp') return null;
  const version = value => value == null ? 'absent' : versions.has(value) ? value : 'other';
  return {event:'mcp_request',method:method === 'POST' ? methods.has(body?.method) ? body.method : 'other' : 'non_post',
    requestedVersion:version(body?.params?.protocolVersion),headerVersion:version(headers['mcp-protocol-version']),
    status:result.status,outcome:outcomes.has(result.body?.error) ? result.body.error : result.body?.error ? 'rpc_error' : 'ok'};
}
