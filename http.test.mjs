import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

for (const legacyKeyConfigured of [false, true]) {
test(`real HTTP server stays disabled with legacy key configured=${legacyKeyConfigured}`, async () => {
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
    assert.equal((await (await fetch(url + '/healthz')).json()).mode, 'disabled');
    for (const path of ['/mcp', '/proof']) {
      for (const headers of [{}, { Authorization: `Bearer ${fixtureKey}` }]) {
        const response = await fetch(url + path, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, 503);
      }
    }
    assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
}
