import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_SESSION_MS = 60 * 60_000;
const discoveryMethods = new Set(['server/discover','initialize','notifications/initialized','ping','tools/list','events/list']);
// Shared by both authorization layers. No caller-supplied flag selects this path.
export function isDiscoveryRequest(method, path, body) {
  if (method !== 'POST' || path !== '/mcp' || !body || typeof body !== 'object' || Array.isArray(body) ||
      body.jsonrpc !== '2.0' || !discoveryMethods.has(body.method)) return false;
  if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) return false;
  if (body.method === 'notifications/initialized') return !Object.hasOwn(body,'id');
  return Object.hasOwn(body,'id') && (body.id === null || typeof body.id === 'string' ||
    (typeof body.id === 'number' && Number.isFinite(body.id)));
}
const EVENT = 'probe.created';
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const proofSchema = objectSchema({ proof_id: { type: 'string' }, nonce: { type: 'string' } });
const eventDefinition = { name: EVENT, description: 'A single synthetic connection probe. Contains no user messages.', delivery: ['webhook'],
  inputSchema: objectSchema({ session: { type: 'string', enum: ['quicksilver'] } }), payloadSchema: proofSchema };
const toolDefinition = { name: 'acknowledge_probe', description: 'Acknowledge only an active synthetic probe when the user has instructed you to run this connection test. Does not send any message.',
  inputSchema: proofSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const triggerDefinition = { name: 'trigger_synthetic_probe', description: 'Emit the one approved synthetic connection test to the verified event subscription. Accepts no message or destination. Call only after explicit user approval. Retries return the existing state without resending. Never automatically retry after a server restart.',
  inputSchema: objectSchema({}), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const reply = (status, body) => ({ status, body });
const failure = (id, code, message, data) => reply(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

export function publicAddress(address) {
  if (isIP(address) !== 4) return false; // IPv6 deliberately unsupported for this bounded test.
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function callbackTarget(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid callback');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port ||
      isIP(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.')) throw new Error('invalid callback');
  return url;
}
export async function postCallback(value, body, headers, { isActive = () => true, resolve = resolve4, request = https.request } = {}) {
  const url = callbackTarget(value);
  // Resolve afresh for every connection, reject the entire set if any address is private,
  // and pin the socket to the checked address while retaining hostname TLS verification.
  const addresses = await resolve(url.hostname);
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw new Error('invalid callback address');
  if (!isActive()) throw new Error('callback no longer active');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, headers, family: 4,
      lookup: (_hostname, options, done) => options.all ? done(null, [{ address: addresses[0], family: 4 }]) : done(null, addresses[0], 4),
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; if (Buffer.byteLength(text) > 8192) req.destroy(new Error('callback response too large')); });
      response.on('error', reject);
      response.on('end', () => { clearTimeout(deadline); let parsed = {}; try { parsed = JSON.parse(text); } catch {} resolve({ status: response.statusCode, body: parsed }); });
    });
    // Native https does not follow redirects. No caller headers except the generated signature.
    const deadline = setTimeout(() => req.destroy(new Error('callback timeout')), 5000);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
    req.end(body);
  });
}

export function createBridge({ key, authorize, expiresAt, now = Date.now, postCallback: post = postCallback, event = eventDefinition, tools, onTool } = {}) {
  const EVENT = event.name;
  const startedAt = now();
  const configuredExpiry = Date.parse(expiresAt);
  const enabled = (typeof authorize === 'function' || (typeof key === 'string' && key.length >= 32)) && Number.isFinite(configuredExpiry) && configuredExpiry > startedAt && configuredExpiry <= startedAt + MAX_SESSION_MS;
  let subscription = null;
  let proof = null;
  let busy = false;
  let spent = false; // Never reset on unsubscribe or subscription expiry within this process.
  function active() {
    if (!enabled || now() >= configuredExpiry) { subscription = null; proof = null; return false; }
    if (subscription && now() >= subscription.expires) { subscription = null; proof = null; }
    return true;
  }
  async function deliver(target, payload, id, isActive = () => active() && now() < target.expires) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now() / 1000));
    const signature = createHmac('sha256', Buffer.from(target.secret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
    return post(target.url, body, { 'Content-Type': 'application/json', 'webhook-id': id,
      'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`, 'X-MCP-Subscription-Id': target.id }, {isActive});
  }
  async function emitProof() {
    spent = true;
    proof = { id: randomUUID(), nonce: randomUUID(), state: 'sending' };
    const current = proof;
    const target = subscription;
    const unchanged = () => active() && subscription === target && proof === current;
    try {
      const result = await deliver(target, { eventId: current.id, name: EVENT, timestamp: new Date(now()).toISOString(), data: { proof_id: current.id, nonce: current.nonce }, cursor: null }, current.id, unchanged);
      if (!unchanged()) return reply(409, { error: 'session_changed' });
      if (current.state === 'sending') current.state = result.status >= 200 && result.status < 300 ? 'callback_accepted' : 'callback_rejected';
    } catch { if (proof === current && current.state === 'sending') current.state = 'unknown_outcome'; }
    if (!unchanged()) return reply(409, { error: 'session_changed' });
    return reply(200, { proof_id: current.id, state: current.state });
  }
  return {
    hasSubscription: () => active() && Boolean(subscription) && !busy,
    async publish(data, guard = () => true) {
      if (!active() || !subscription || busy || !guard()) return false;
      const target = subscription, id = randomUUID();
      const unchanged = () => active() && subscription === target && guard();
      const result = await deliver(target, {eventId:id,name:EVENT,timestamp:new Date(now()).toISOString(),data,cursor:null},id,unchanged);
      return unchanged() && result.status >= 200 && result.status < 300;
    },
    async handle(method, path, headers, body) {
    const available = active();
    if (method === 'GET' && path === '/healthz') return reply(200, { service: 'quicksilver', mode: available ? 'synthetic-session' : 'disabled', syntheticOnly: true });
    // Legacy fixture-key mode keeps its existing session requirement.
    const discovery = typeof authorize === 'function' && isDiscoveryRequest(method,path,body);
    if (!available && !discovery) return reply(503, { error: 'disabled_or_expired' });
    if (authorize) { const auth = await authorize(headers,{requireSession:!discovery}); if (!auth.principal) return auth; }
    else if (!equal(headers.authorization, `Bearer ${key}`)) return reply(401, { error: 'unauthorized' });
    // Authentication can await JWKS/network work. Recheck session and subscription
    // lifetime at the mutation boundary so expired proofs cannot be acknowledged.
    if (!active() && !discovery) return reply(503, { error: 'disabled_or_expired' });
    if (path === '/proof') {
      if (tools) return reply(403, {error:'operator_trigger_not_configured'});
      if (method === 'GET') return reply(200, { subscription: Boolean(subscription), state: proof?.state ?? 'not_started', proof_id: proof?.id ?? null });
      if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
      if (!exact(body, [])) return reply(400, { error: 'no_input_allowed' });
      if (!subscription || spent || busy) return reply(409, { error: 'no_active_subscription_or_probe_already_started' });
      return emitProof();
    }
    if (path !== '/mcp') return reply(404, { error: 'not_found' });
    if (method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || Array.isArray(body)) return failure(null, -32600, 'Invalid request');
    const { id, method: rpcMethod, params = {} } = body;
    if (rpcMethod === 'notifications/initialized') return reply(202, null);
    if (id === undefined) return failure(null, -32600, 'Request id required');
    const success = result => reply(200, { jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
    if (rpcMethod === 'server/discover') return success({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} } });
    if (rpcMethod === 'initialize') return success({ protocolVersion: '2026-07-28', capabilities: { tools: {}, events: {} }, serverInfo: { name: 'quicksilver', version: '0.1.0' } });
    if (rpcMethod === 'ping') return success({});
    if (rpcMethod === 'events/list') return success({ events: [event] });
    if (rpcMethod === 'tools/list') return success({ tools: tools ?? [toolDefinition, triggerDefinition] });
    if (rpcMethod === 'events/subscribe' || rpcMethod === 'events/unsubscribe') {
      if (params.name !== EVENT || !exact(params.arguments, ['session']) || params.arguments.session !== 'quicksilver' || params.delivery?.mode !== 'webhook') return failure(id, -32602, 'Unsupported subscription');
      let url;
      try { url = callbackTarget(params.delivery.url).href; } catch { return failure(id, -32602, 'Invalid callback'); }
      if (rpcMethod === 'events/unsubscribe') {
        if (busy) return failure(id, -32000, 'Subscription busy');
        if (subscription?.url === url) { subscription = null; proof = null; }
        return success({});
      }
      const secret = params.delivery.secret;
      if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.slice(6), 'base64').length < 24 || Buffer.from(secret.slice(6), 'base64').length > 64) return failure(id, -32602, 'Invalid signing secret');
      if (params.cursor != null || (params.ttlMs != null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0))) return failure(id, -32602, 'Invalid cursor or lifetime');
      if (busy || (subscription && subscription.url !== url)) return failure(id, -32000, 'Single subscription only');
      const target = { id: createHash('sha256').update(`single-owner:${url}:${EVENT}:quicksilver`).digest('hex'), url, secret,
        expires: Math.min(configuredExpiry, now() + (params.ttlMs ?? 30 * 60_000)) };
      busy = true;
      try {
        const challenge = randomUUID();
        const result = await deliver(target, { type: 'verification', challenge }, randomUUID());
        if (!(result.status >= 200 && result.status < 300 && equal(result.body?.challenge, challenge)) || !active() || now() >= target.expires) throw new Error('challenge failed');
        subscription = target;
        return success({ id: target.id, refreshBefore: new Date(target.expires).toISOString(), cursor: null, truncated: false });
      } catch { return failure(id, -32015, 'Callback verification failed', { reason: 'challenge_failed' }); }
      finally { busy = false; }
    }
    if (rpcMethod === 'tools/call') {
      const args = params.arguments;
      if (tools) {
        if (!tools.some(tool => tool.name === params.name)) return failure(id,-32602,'Unknown tool');
        const result = await onTool(params.name,args);
        return success({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:result.state==='unavailable'});
      }
      if (params.name === 'trigger_synthetic_probe') {
        if (!exact(args, []) || !subscription || busy || (spent && !proof)) return failure(id, -32602, 'No active subscription or probe unavailable');
        const outcome = proof ? reply(200, {proof_id:proof.id,state:proof.state}) : await emitProof();
        if (outcome.status !== 200) return failure(id, -32000, 'Session changed');
        return success({content:[{type:'text',text:JSON.stringify(outcome.body)}],structuredContent:outcome.body,isError:false});
      }
      if (params.name !== 'acknowledge_probe' || !exact(args, ['proof_id', 'nonce']) || !subscription || !proof || !equal(args.proof_id, proof.id) || !equal(args.nonce, proof.nonce)) return failure(id, -32602, 'No matching active synthetic probe');
      proof.state = 'acknowledged';
      const result = { proof_id: proof.id, state: proof.state };
      return success({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    }
    return failure(id, -32601, 'Method not found');
  } };
}
