import { createServer } from 'node:http';
import { createRuntimeService } from './runtime.mjs';
import { requestSummary } from './diagnostics.mjs';

// Read approved runtime configuration without connecting or activating Photon.
// The transport source lock and explicit boot-bound arm remain separate gates.
const service = createRuntimeService(process.env);
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
    const diagnostic = requestSummary(request.method,request.url,body,request.headers,result);
    if (diagnostic) console.log(JSON.stringify(diagnostic));
    response.writeHead(result.status, result.headers ?? {}).end(result.body === null ? '' : JSON.stringify(result.body));
  } catch { response.writeHead(500).end('{"error":"request_failed"}'); }
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT ?? 10000), process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`quicksilver port=${server.address().port}; OAuth metadata available; owner/session gate enforced`));
process.on('SIGTERM', () => { void service.stop(); server.close(); });
