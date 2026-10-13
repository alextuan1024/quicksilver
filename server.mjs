import { createServer } from 'node:http';
import { createService } from './service.mjs';

// Public OAuth coordinates only. Secrets stay with Auth0/ChatGPT. Owner and absolute
// deadline must be explicitly configured after the owner's application login.
const service = createService({
  issuer: 'https://dev-ar7fhtveuwv8gobu.us.auth0.com/',
  resource: 'https://quicksilver-kvt8.onrender.com/mcp',
  clientId: 'tpc_caXSmFzUtRmg6MaouZ9Dij',
  ownerSubject: process.env.QUICKSILVER_OWNER_SUBJECT,
  expiresAt: process.env.QUICKSILVER_SESSION_EXPIRES_AT,
});
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (request.headers.origin) { response.writeHead(403).end('{"error":"browser_origin_not_allowed"}'); return; }
    let raw = '';
    for await (const chunk of request) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 16384) { response.writeHead(413).end('{"error":"too_large"}'); return; }
    }
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { response.writeHead(400).end('{"error":"invalid_json"}'); return; } }
    const result = await service.handle(request.method, request.url, request.headers, body);
    response.writeHead(result.status, result.headers ?? {}).end(result.body === null ? '' : JSON.stringify(result.body));
  } catch { response.writeHead(500).end('{"error":"request_failed"}'); }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? 10000), process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`quicksilver port=${server.address().port}; OAuth metadata available; owner/session gate enforced`));
process.on('SIGTERM', () => server.close());
