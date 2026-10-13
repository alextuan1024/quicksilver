import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('real HTTP server remains disabled and denies origins and oversized bodies', async () => {
  const child = spawn(process.execPath, ['server.mjs'], { env: { PATH: process.env.PATH, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [line] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('server exited before listening'); })]);
    const match = line.toString().match(/port=(\d+)/);
    assert.ok(match, 'startup must report actual listening port without credentials');
    const url = `http://127.0.0.1:${match[1]}`;
    assert.equal((await (await fetch(url + '/healthz')).json()).mode, 'disabled');
    for (const path of ['/mcp', '/proof']) {
      const response = await fetch(url + path, { method: 'POST', body: '{}' });
      assert.equal(response.status, 503);
    }
    assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url + '/mcp', { method: 'POST', body: 'x'.repeat(17000) })).status, 413);
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
