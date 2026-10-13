import test from 'node:test';
import assert from 'node:assert/strict';
import { requestSummary } from './diagnostics.mjs';

test('diagnostics expose only allowlisted discovery metadata and response status', () => {
  const secret = 'must-never-be-logged';
  const result = requestSummary('POST','/mcp',{jsonrpc:'2.0',id:secret,method:'initialize',params:{protocolVersion:'2025-11-25',token:secret}},
    {'mcp-protocol-version':'2025-11-25',authorization:secret},{status:401,body:{error:'invalid_token',token:secret}});
  assert.deepEqual(result,{event:'mcp_request',method:'initialize',requestedVersion:'2025-11-25',headerVersion:'2025-11-25',status:401,outcome:'invalid_token'});
  assert.equal(JSON.stringify(result).includes(secret),false);
  const hostile=requestSummary('POST','/mcp',{method:secret,params:{protocolVersion:secret}},{'mcp-protocol-version':secret},
    {status:200,body:{error:{code:-32601,message:secret}}});
  assert.equal(JSON.stringify(hostile).includes(secret),false);
  assert.equal(hostile.method,'other');
  assert.equal(hostile.outcome,'rpc_error');
  assert.equal(requestSummary('GET','/mcp?token='+secret,{}, {}, {status:404}),null);
});
