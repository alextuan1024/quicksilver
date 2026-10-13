import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBridge, callbackTarget, publicAddress } from './bridge.mjs';

// These are deliberately public fixtures, never deployment credentials.
const key = 'fixture-only-'.repeat(4);
const signingBytes = Buffer.alloc(32, 7);
const signingSecret = 'whsec_' + signingBytes.toString('base64');
const baseTime = Date.now();
const expiresAt = new Date(baseTime + 30 * 60_000).toISOString();
const headers = { authorization: `Bearer ${key}` };
const subscribe = { name: 'probe.created', arguments: { session: 'quicksilver' }, delivery: {
  mode: 'webhook', url: 'https://callback.example.com/events', secret: signingSecret,
} };
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
function setup(options = {}) {
  const deliveries = [];
  let now = baseTime;
  const bridge = createBridge({ key, expiresAt, now: () => now, postCallback: async (url, body, signedHeaders) => {
    const expected = 'v1,' + createHmac('sha256', signingBytes)
      .update(`${signedHeaders['webhook-id']}.${signedHeaders['webhook-timestamp']}.${body}`).digest('base64');
    assert.equal(signedHeaders['webhook-signature'], expected);
    assert.equal(url, 'https://callback.example.com/events');
    const decoded = JSON.parse(body);
    deliveries.push(decoded);
    return { status: 200, body: decoded.type === 'verification' ? { challenge: decoded.challenge } : {} };
  }, ...options });
  return { bridge, deliveries, advance: ms => { now += ms; }, call: (method, params) => bridge.handle('POST', '/mcp', headers, rpc(method, params)) };
}
test('unconfigured deployment exposes health only and cannot create a proof', async () => {
  const { bridge } = setup({ key: undefined });
  assert.deepEqual((await bridge.handle('GET', '/healthz', {}, null)).body, { service: 'quicksilver', mode: 'disabled', syntheticOnly: true });
  for (const path of ['/mcp', '/proof']) assert.equal((await bridge.handle('POST', path, headers, {})).status, 503);
});
test('missing, wrong and expired authentication denies all control access', async () => {
  const { bridge, advance } = setup();
  assert.equal((await bridge.handle('POST', '/mcp', {}, rpc('server/discover'))).status, 401);
  assert.equal((await bridge.handle('POST', '/proof', { authorization: 'Bearer wrong' }, {})).status, 401);
  advance(31 * 60_000);
  assert.equal((await bridge.handle('POST', '/mcp', headers, rpc('server/discover'))).status, 503);
});
test('MCP discovery exposes only the synthetic event and acknowledgement tool', async () => {
  const { call } = setup();
  assert.deepEqual((await call('server/discover')).body.result.capabilities, { tools: {}, events: {} });
  assert.equal((await call('events/list')).body.result.events[0].name, 'probe.created');
  assert.deepEqual((await call('tools/list')).body.result.tools.map(t => t.name), ['acknowledge_probe']);
});
test('verified subscription delivers one signed nonce and accepts only its acknowledgement', async () => {
  const { bridge, call, deliveries } = setup();
  const result = await call('events/subscribe', subscribe);
  assert.ok(result.body.result.id);
  assert.equal(deliveries[0].type, 'verification');
  const proof = await bridge.handle('POST', '/proof', headers, {});
  assert.equal(proof.status, 200);
  assert.equal(proof.body.state, 'callback_accepted');
  const event = deliveries[1];
  assert.equal(event.name, 'probe.created');
  assert.equal(event.data.proof_id, proof.body.proof_id);
  const bad = await call('tools/call', { name: 'acknowledge_probe', arguments: { proof_id: event.data.proof_id, nonce: 'wrong' } });
  assert.ok(bad.body.error);
  const good = await call('tools/call', { name: 'acknowledge_probe', arguments: event.data });
  assert.equal(good.body.result.structuredContent.state, 'acknowledged');
  assert.equal((await call('tools/call', { name: 'acknowledge_probe', arguments: event.data })).body.result.structuredContent.state, 'acknowledged');
  assert.equal((await bridge.handle('POST', '/proof', headers, {})).status, 409);
});
test('failed callback verification does not activate a subscription', async () => {
  const { bridge, call } = setup({ postCallback: async () => ({ status: 200, body: { challenge: 'wrong' } }) });
  assert.equal((await call('events/subscribe', subscribe)).body.error.code, -32015);
  assert.equal((await bridge.handle('POST', '/proof', headers, {})).status, 409);
});
test('expiry, unsubscribe and restart invalidate outstanding acknowledgements', async () => {
  for (const action of ['expire', 'unsubscribe', 'restart']) {
    const s = setup();
    await s.call('events/subscribe', { ...subscribe, ttlMs: 1000 });
    await s.bridge.handle('POST', '/proof', headers, {});
    const event = s.deliveries[1];
    let call = s.call;
    if (action === 'expire') s.advance(1001);
    if (action === 'unsubscribe') await call('events/unsubscribe', { ...subscribe, delivery: { mode: 'webhook', url: subscribe.delivery.url } });
    if (action === 'restart') call = setup().call;
    assert.ok((await call('tools/call', { name: 'acknowledge_probe', arguments: event.data })).body.error);
  }
});
test('unsupported subscriptions and competing callbacks fail without delivery', async () => {
  const { call, deliveries } = setup();
  assert.ok((await call('events/subscribe', { ...subscribe, arguments: { session: 'other' } })).body.error);
  assert.ok((await call('events/subscribe', { ...subscribe, delivery: { ...subscribe.delivery, secret: 'short' } })).body.error);
  assert.equal(deliveries.length, 0);
  await call('events/subscribe', subscribe);
  assert.ok((await call('events/subscribe', { ...subscribe, delivery: { ...subscribe.delivery, url: 'https://other.example.com/events' } })).body.error);
});
test('callback targets reject unsafe schemes, credentials, ports, fragments and private IPs', () => {
  for (const url of ['http://example.com', 'https://u:p@example.com', 'https://example.com:8443', 'https://example.com/#x', 'https://127.0.0.1', 'https://[::1]']) assert.throws(() => callbackTarget(url));
  assert.equal(callbackTarget('https://callback.example.com/events').hostname, 'callback.example.com');
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1']) assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});
