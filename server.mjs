import { createServer } from 'node:http';
import { createBridge } from './bridge.mjs';

// The static bearer key in bridge.mjs is a local contract-test mechanism only.
// Keep the deployable entrypoint disabled until a supported OAuth resource-server
// adapter and the approved owner/issuer configuration have been implemented.
const bridge = createBridge();
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
    const result = await bridge.handle(request.method, request.url, request.headers, body);
    response.writeHead(result.status).end(result.body === null ? '' : JSON.stringify(result.body));
  } catch { response.writeHead(500).end('{"error":"request_failed"}'); }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? 10000), process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`quicksilver port=${server.address().port}; health-only; OAuth setup pending`));
process.on('SIGTERM', () => server.close());
