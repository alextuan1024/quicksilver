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

test('request diagnostics allowlist authentication categories and never copy arbitrary details', () => {
  const categories=['bearer_missing','bearer_malformed','jwt_malformed','jwt_expired','jwt_claim_invalid',
    'jwt_signature_invalid','jwt_algorithm_invalid','jwt_policy_invalid','jwks_key_invalid','jwks_unavailable','jwt_verification_failed'];
  for(const category of categories) {
    const summary=requestSummary('POST','/mcp',{}, {},{status:401,body:{error:'invalid_token'},authFailure:category});
    assert.equal(summary.authFailure,category);
    assert.deepEqual(Object.keys(summary).sort(),['authFailure','event','headerVersion','method','outcome','requestedVersion','status']);
  }
  for(const authFailure of ['must-never-be-logged',{message:'must-never-be-logged'},undefined]) {
    const summary=requestSummary('POST','/mcp',{}, {},{status:401,body:{error:'invalid_token'},authFailure});
    assert.equal(summary.authFailure,undefined);
    assert.equal(JSON.stringify(summary).includes('must-never-be-logged'),false);
  }
});
