import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {productionDrill,native,until,dm} from './test-support/production-drill-fixture.mjs';
import {restoreMessageBackup} from './message-backup.mjs';
import {PROJECT_ID} from './photon.mjs';

for(const mode of ['proxy','render'])test(`production ${mode} HTTP drill: OAuth rotation/revocation, owner filtering, future reconnect and durable MCP replay`,async t=>{
  const d=await productionDrill(t,mode==='render'?{listener:{mode,host:'0.0.0.0',port:0,trustedProxyAddresses:['127.0.0.1']}}:{}),{f}=d;await d.connected();
  assert.equal((await f.login({subject:'different-owner'})).response.status,403);
  const tokens=await d.token(),access=tokens.access_token;
  assert.equal((await d.rpc(access,'initialize')).body.result.serverInfo.name,'quicksilver');
  assert.equal((await d.rpc(access,'tools/list')).body.result.tools.length,3);
  assert.equal((await d.rpc(access,'events/list')).body.result.events[0].name,'photon.message.received');
  const initial=await d.subscribe(access);assert.equal(typeof initial.cursor,'string');
  const wrongOwner=native('wrong-owner');wrongOwner.message.sender.address='+15550000002';
  const group=native('group');group.message.chatGuids.push('group-chat');
  const attachment=native('attachment');attachment.message.content.attachments.push({guid:'media'});
  await f.auth.command('emit',wrongOwner,group,attachment,native('one'),native('one'),native('two',{sequence:1000}));
  await until(()=>d.callbacks.length===2,'two filtered owner callbacks');d.check();
  const originals=d.callbacks.slice(),one=originals[0].data.request_id;
  assert.equal((await d.tool(access,'message_status')).requests.length,2);
  let actions=0;const claim=await d.tool(access,'claim_message',{request_id:one});if(claim.acquired)actions++;
  assert.equal(claim.text,'Synthetic request one');
  assert.equal((await d.tool(access,'claim_message',{request_id:one})).acquired,false);
  const sessions=d.subscriptions.length;await f.auth.command('disconnect');
  await until(()=>d.subscriptions.length===sessions+1,'future-only reconnect');await d.connected();
  await f.auth.command('emit',native('one'),native('three',{sequence:90000}));
  await until(()=>d.callbacks.length===3,'post-reconnect new event');originals.push(d.callbacks[2]);
  assert.equal((await d.tool(access,'message_status')).requests.length,3);
  for(const subscription of d.subscriptions)assert.deepEqual(subscription,{args:{chat:dm},tls:true,retry:false});

  await f.restart();await d.connected();
  assert.equal((await d.tool(access,'message_status')).requests.find(r=>r.request_id===one).reason,'processing_interrupted');
  const replayStart=d.callbacks.length;
  assert.equal((await d.subscribe(access,initial.cursor)).truncated,false);
  await until(()=>d.callbacks.length===replayStart+3,'durable replay after process restart');
  assert.deepEqual(d.callbacks.slice(replayStart).map(e=>[e.eventId,e.data.request_id,e.cursor]),
    originals.map(e=>[e.eventId,e.data.request_id,e.cursor]));
  const duplicate=await d.tool(access,'claim_message',{request_id:one});if(duplicate.acquired)actions++;
  assert.equal(actions,1);assert.equal(duplicate.acquired,false);

  const rotated=await f.refresh(tokens.refresh_token);assert.equal(rotated.status,200);
  assert.notEqual(rotated.body.refresh_token,tokens.refresh_token);
  await f.restart();
  assert.equal((await d.rpc(rotated.body.access_token,'tools/list')).status,200);
  assert.equal((await f.refresh(tokens.refresh_token)).status,400);
  assert.equal((await d.rpc(rotated.body.access_token,'tools/list')).status,401);
  const fresh=await d.token();
  assert.equal((await f.request('/token/revocation',{method:'POST',form:{client_id:'athena',token:fresh.refresh_token}})).status,200);
  await f.restart();assert.equal((await d.rpc(fresh.access_token,'tools/list')).status,401);
  assert.equal((await f.refresh(fresh.refresh_token)).status,400);d.check();
});

test('production process drill: kill during callback/claim and send reservation never repeats work or an uncertain send',async t=>{
  const d=await productionDrill(t),{f}=d;await d.connected();const tokens=await d.token(),access=tokens.access_token;
  const initial=await d.subscribe(access);d.holdCallbacks(true);
  await f.auth.command('emit',native('crash-work'));await until(()=>d.callbacks.length===1,'in-flight signed callback');
  const event=d.callbacks[0],id=event.data.request_id;
  assert.equal((await d.tool(access,'claim_message',{request_id:id})).acquired,true);
  assert.equal((await d.tool(access,'message_status')).requests[0].event,'in_flight');
  await f.auth.kill();d.holdCallbacks(false);await f.restart();await d.connected();
  await until(()=>d.callbacks.length>=2,'callback recovery after SIGKILL');
  assert.equal(d.callbacks[1].eventId,event.eventId);
  assert.equal((await d.tool(access,'claim_message',{request_id:id})).acquired,false);
  assert.equal((await d.tool(access,'message_status')).requests[0].reason,'processing_interrupted');
  await d.subscribe(access,initial.cursor);
  await f.auth.command('sendMode','block');
  const reply={request_id:id,response_id:'stable-answer',text:'Synthetic reply',final:false};
  assert.equal((await d.tool(access,'reply_message',reply)).state,'queued');
  await until(()=>d.sends.length===1,'provider invocation after durable reservation');
  assert.equal((await d.tool(access,'message_status')).requests[0].replies[0].state,'send_attempted');
  await f.auth.kill();await f.restart();await d.connected();
  let status=await d.tool(access,'message_status');
  assert.deepEqual(status.requests[0].replies,[{response_id:'stable-answer',state:'unknown_outcome',attempts:1}]);
  assert.equal((await d.tool(access,'reply_message',reply)).state,'unknown_outcome');
  const sessions=d.subscriptions.length;await f.auth.command('disconnect');
  await until(()=>d.subscriptions.length===sessions+1,'reconnect after uncertain send');await d.connected();
  await f.restart();await d.connected();
  assert.equal((await d.tool(access,'reply_message',reply)).state,'unknown_outcome');

  // Prove the worker is still live, so "no retry" cannot pass just because it stopped.
  await f.auth.command('emit',native('independent-work'));
  status=await until(async()=>{const s=await d.tool(access,'message_status');return s.requests.length===2&&s;},'independent request');
  const freshId=status.requests[1].request_id;
  assert.equal((await d.tool(access,'claim_message',{request_id:freshId})).acquired,true);
  await d.tool(access,'reply_message',{request_id:freshId,response_id:'fresh-answer',text:'New synthetic reply',final:true});
  await until(async()=>(await d.tool(access,'message_status')).requests[1].replies[0]?.state==='provider_accepted','independent send');
  assert.equal(d.sends.length,2);assert.equal(d.sends[0][2].replyTo,'crash-work');assert.equal(d.sends[1][2].replyTo,'independent-work');
  assert.notEqual(d.sends[0][2].clientMessageId,d.sends[1][2].clientMessageId);
  assert.equal((await d.tool(access,'message_status')).requests[0].replies[0].attempts,1);d.check();
});

test('production restore drill: persistent pause, fenced source, fresh OAuth, cursor truncation and missing reply quarantine',async t=>{
  const d=await productionDrill(t),{f}=d;await d.connected();const tokens=await d.token(),access=tokens.access_token;
  const initial=await d.subscribe(access);await f.auth.command('emit',native('snapshot-work'));
  await until(()=>d.callbacks.length===1,'snapshot request');const id=d.callbacks[0].data.request_id;
  assert.equal((await d.tool(access,'claim_message',{request_id:id})).acquired,true);
  await f.auth.command('pause');await until(async()=>(await f.auth.command('transport')).state==='paused','persistent pause');
  const beforePause=d.subscriptions.length;await f.restart();
  assert.equal((await f.request('/healthz')).body.mode,'paused');
  assert.equal(d.subscriptions.length,beforePause);
  assert.deepEqual(await d.tool(access,'claim_message',{request_id:id}),{state:'unavailable',reason:'paused'});
  const directory=dirname(f.config.databasePath),backup=join(directory,'snapshot.qsb'),key=randomBytes(32);
  await f.auth.command('backup',{path:backup,key:key.toString('base64')});
  await f.auth.command('resume',{ownerVerified:true});await f.restart();await d.connected();
  const postSnapshotReply={request_id:id,response_id:'after-snapshot',text:'Synthetic post-snapshot reply',final:false};
  await d.tool(access,'reply_message',postSnapshotReply);
  await until(async()=>(await d.tool(access,'message_status')).requests[0].replies[0]?.state==='provider_accepted','post-snapshot send');
  assert.equal(d.sends.length,1);
  // Await real process exit before touching the backup or opening the restored host.
  const oldAddress=f.address,oldPid=f.auth.pid;await f.auth.close();
  assert.throws(()=>process.kill(oldPid,0),{code:'ESRCH'});
  await assert.rejects(()=>fetch(oldAddress+'/healthz'));
  const restored=join(directory,'restored.sqlite');
  const identity={projectId:PROJECT_ID,ownerAddress:'+15550000001',line:'shared',dm,
    issuer:f.config.issuer,clientId:f.config.clientId,subject:f.config.ownerSubject};
  assert.equal(restoreMessageBackup({path:backup,databasePath:restored,key,identity}).state,'paused');
  d.useMessagePath(restored);f.config.databasePath=join(directory,'fresh-oauth.sqlite');
  const beforeRestore=d.subscriptions.length;await f.restart();
  assert.equal((await f.request('/healthz')).body.mode,'paused');assert.equal(d.subscriptions.length,beforeRestore);
  assert.equal((await d.rpc(access,'tools/list')).status,401);
  const fresh=await d.token(),newAccess=fresh.access_token;
  let status=await d.tool(newAccess,'message_status');assert.equal(status.operations.restore_required,true);assert.equal(status.requests[0].restore_hold,true);
  await assert.rejects(()=>f.auth.command('resume',{ownerVerified:true}),/restore_reconciliation_required/);
  await assert.rejects(()=>f.auth.command('completeRestore',{ownerVerified:true,intakeAfter:Date.now()}),/unreviewed_requests/);
  const callbackCount=d.callbacks.length;assert.equal((await d.subscribe(newAccess,initial.cursor)).truncated,true);
  assert.equal((await d.tool(newAccess,'claim_message',{request_id:id})).reason,'paused');
  await f.auth.command('resolveRequest',id,{outcome:'continuing',ownerVerified:true});
  status=await f.auth.command('completeRestore',{ownerVerified:true,intakeAfter:Date.now()});const boundary=status.operations.ingest_after;
  await f.auth.command('resume',{ownerVerified:true});await f.restart();await d.connected();
  assert.equal((await d.tool(newAccess,'claim_message',{request_id:id})).acquired,false);
  assert.equal((await d.tool(newAccess,'reply_message',postSnapshotReply)).state,'unknown_outcome');
  assert.equal(d.sends.length,1);assert.equal(d.callbacks.length,callbackCount);

  // A frame at/before the reviewed boundary is not safe intake. The live host stalls.
  await f.auth.command('emit',native('old-interval',{date:boundary}));
  await until(async()=>(await f.auth.command('transport')).state==='stalled','restore-boundary intake fence');
  assert.equal((await d.tool(newAccess,'message_status')).requests.length,1);
  await f.restart();await d.connected();await until(()=>Date.now()>boundary);
  await f.auth.command('emit',native('after-restore'));
  status=await until(async()=>{const s=await d.tool(newAccess,'message_status');return s.requests.length===2&&s;},'new post-boundary request');
  const freshId=status.requests[1].request_id;assert.equal((await d.tool(newAccess,'claim_message',{request_id:freshId})).acquired,true);
  await d.tool(newAccess,'reply_message',{request_id:freshId,response_id:'new-answer',text:'Synthetic recovered reply',final:true});
  await until(async()=>(await d.tool(newAccess,'message_status')).requests[1].replies[0]?.state==='provider_accepted','recovered host send');
  assert.equal(d.sends.length,2);assert.equal(d.sends[1][2].replyTo,'after-restore');
  status=await d.tool(newAccess,'message_status');assert.equal(status.requests[0].replies[0].state,'unknown_outcome');
  assert.equal(status.requests[0].replies[0].attempts,0);d.check();
});
