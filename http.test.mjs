import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const legacyKeyConfigured of [false, true]) {
test(`real HTTP OAuth server stays owner-locked with legacy key configured=${legacyKeyConfigured}`, async () => {
  const fixtureKey = 'fixture-only-'.repeat(4);
  const env = { PATH: process.env.PATH, PORT: '0' };
  if (legacyKeyConfigured) {
    env.QUICKSILVER_API_KEY = fixtureKey;
    env.QUICKSILVER_SESSION_EXPIRES_AT = new Date(Date.now() + 30 * 60_000).toISOString();
  }
  const child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [line] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited before listening'); })]);
    const match = line.toString().match(/port=(\d+)/);
    assert.ok(match, 'startup must report actual listening port without credentials');
    const url = `http://127.0.0.1:${match[1]}`;
    const health=await (await fetch(url + '/healthz')).json();
    assert.equal(health.mode,'disabled');assert.equal(health.photon,'disabled');
    assert.equal(health.photonTransport,'locked_pending_sdk_review');
    const metadata = await fetch(url + '/.well-known/oauth-protected-resource/mcp');
    assert.equal(metadata.status,200);
    assert.deepEqual((await metadata.json()).scopes_supported,['quicksilver:probe']);
    for (const path of ['/mcp', '/proof']) {
      for (const headers of [{}, { Authorization: `Bearer ${fixtureKey}` }]) {
        const response = await fetch(url + path, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, path === '/proof' ? 403 : 401);
        if (path === '/mcp') assert.match(response.headers.get('www-authenticate'),/oauth-protected-resource/);
      }
    }
    assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
}
