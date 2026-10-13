import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpectrumTransport,SPECTRUM_LIVE_TRANSPORT_ALLOWED} from './spectrum-transport.mjs';
import {PROJECT_ID} from './photon.mjs';
const fixtureSecret='public-test-fixture';
test('production SDK connection stays locked even with fixture credentials',async()=>{
 assert.equal(SPECTRUM_LIVE_TRANSPORT_ALLOWED,false);
 const transport=createSpectrumTransport({projectId:PROJECT_ID,projectSecret:fixtureSecret});
 await assert.rejects(transport.start(()=>{}),/sdk_review_required/);
});
test('Spectrum contract awaits factory, disables telemetry, preserves original tuple and stops',async()=>{
 let options,stops=0;const received=[];
 const pair=[{id:'dm'},{id:'message'}];
 const transport=createSpectrumTransport({projectId:PROJECT_ID,projectSecret:fixtureSecret,sdkLoader:async()=>({
  imessage:{config:()=>({fixture:true})},Spectrum:async opts=>{options=opts;return {
   messages:(async function*(){yield pair;})(),stop:async()=>{stops++;}};}})});
 await transport.start((...value)=>received.push(value));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(options.projectId,PROJECT_ID);assert.equal(options.telemetry,false);
 assert.deepEqual(options.options,{flattenGroups:false,logLevel:'silent'});
 assert.deepEqual(received,[pair]);assert.equal(stops,1);
 await assert.rejects(transport.start(()=>{}),/transport_unavailable/);
});
test('stop or deadline during async SDK startup closes late app before consuming messages',async()=>{
 for(const action of ['stop','expire']) {
  let resolveFactory,active=true,reads=0,stops=0;
  const transport=createSpectrumTransport({projectId:PROJECT_ID,projectSecret:fixtureSecret,sdkLoader:async()=>({
   imessage:{config:()=>({})},Spectrum:()=>new Promise(resolve=>{resolveFactory=resolve;})})});
  const start=transport.start(()=>{reads++;},()=>active);await new Promise(resolve=>setImmediate(resolve));
  if(action==='stop')await transport.stop();else active=false;
  resolveFactory({messages:(async function*(){yield [{},{}];})(),stop:async()=>{stops++;}});
  await start;assert.equal(reads,0);assert.equal(stops,1);
 }
});
test('pinned public SDK exports and strict provider configuration are available offline',async()=>{
 const {Spectrum}=await import('@spectrum-ts/core');const {imessage}=await import('@spectrum-ts/imessage');
 assert.equal(typeof Spectrum,'function');assert.equal(typeof imessage,'function');
 assert.ok(imessage.config());
 // Import/configuration is not a provider connection or live integration test.
});
