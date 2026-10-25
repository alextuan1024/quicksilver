import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {createIsolatedOtel} from '@photon-ai/otel';
import ogs from 'open-graph-scraper';

// Resolve through Photon so the test exercises its actual overridden graph.
const photonRequire=createRequire(import.meta.resolve('@photon-ai/otel'));
const {MeterProvider,PeriodicExportingMetricReader}=photonRequire('@opentelemetry/sdk-metrics');
const {OTLPMetricExporter}=photonRequire('@opentelemetry/exporter-metrics-otlp-http');
async function listen(t,handler) {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Photon telemetry exports correlated spans and logs through the coordinated dependency graph',async t=>{
  const received=[];
  const endpoint=await listen(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    received.push({path:req.url,body:JSON.parse(body)});
    res.writeHead(200,{'content-type':'application/json'}).end('{}');
  });
  const runtime=createIsolatedOtel({serviceName:'quicksilver-local-fixture',endpoint,traceparentHeader:'x-fixture-trace'});
  const logger=runtime.createLogger('dependency-fixture');
  try {
    await runtime.withSpan('local-operation',async()=>{logger.emit({body:'fixture-operation-completed',severityNumber:9});});
  }finally{await runtime.shutdown();}
  const spans=received.filter(r=>r.path==='/v1/traces').flatMap(r=>r.body.resourceSpans).flatMap(r=>r.scopeSpans).flatMap(r=>r.spans);
  const logs=received.filter(r=>r.path==='/v1/logs').flatMap(r=>r.body.resourceLogs).flatMap(r=>r.scopeLogs).flatMap(r=>r.logRecords);
  assert.equal(spans.length,1);assert.equal(spans[0].name,'local-operation');
  assert.equal(logs.length,1);assert.equal(logs[0].body.stringValue,'fixture-operation-completed');
  assert.equal(logs[0].traceId,spans[0].traceId);assert.equal(logs[0].spanId,spans[0].spanId);
});

test('Photon metric provider and HTTP exporter preserve measured values',async t=>{
  const received=[];
  const endpoint=await listen(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;received.push(JSON.parse(body));
    res.writeHead(200,{'content-type':'application/json'}).end('{}');
  });
  const reader=new PeriodicExportingMetricReader({exporter:new OTLPMetricExporter({url:endpoint+'/v1/metrics'}),exportIntervalMillis:60000});
  const provider=new MeterProvider({readers:[reader]});
  try {
    provider.getMeter('dependency-fixture').createCounter('fixture_requests').add(3);
    await provider.forceFlush();
    const metrics=received.flatMap(r=>r.resourceMetrics).flatMap(r=>r.scopeMetrics).flatMap(r=>r.metrics);
    assert.ok(metrics.some(m=>m.name==='fixture_requests'&&m.sum.dataPoints.some(p=>Number(p.asDouble??p.asInt)===3)));
  }finally{await provider.shutdown();}
});

test('the SDK metadata dependency fetches a normal page through patched-compatible Undici',async t=>{
  const url=await listen(t,(_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end('<html><head><meta property="og:title" content="Local fixture title"></head><body>Fixture</body></html>'));
  const result=await ogs({url,timeout:2});
  assert.equal(result.error,false);assert.equal(result.result.ogTitle,'Local fixture title');
});
