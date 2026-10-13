import {randomUUID} from 'node:crypto';

export const PROJECT_ID='77c7d003-2bf1-4638-b866-2e2ce16ab091';
export const INCOMING_TEXT='Athena connection test.';
export const REPLY_TEXT='Athena received your connection test.';
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const exact=(value,keys)=>value && typeof value==='object' && !Array.isArray(value) &&
 Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
const annotations={readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true};
export const photonEvent={name:'photon.test.received',description:'The single approved fixed-text owner DM. Reply only when the user authorized this bounded test.',
 delivery:['webhook'],inputSchema:schema({session:{type:'string',enum:['quicksilver']}}),
 payloadSchema:schema({request_id:{type:'string'},text:{type:'string',enum:[INCOMING_TEXT]}})};
export const photonTools=[
 {name:'photon_test_status',description:'Inspect the disabled or bounded Photon test state and current boot ID. No messages or credentials.',inputSchema:schema({}),annotations:{...annotations,readOnlyHint:true,openWorldHint:false}},
 {name:'arm_photon_test',description:'Only after fresh explicit user approval: activate one fixed-text DM test for this exact boot and configured deadline. Never automatically rearm after restart or ambiguity. Currently transport-locked pending SDK review.',inputSchema:schema({boot_id:{type:'string'}}),annotations},
 {name:'reply_photon_test',description:'Reply once to the exact approved inbound test request in its original DM. Fixed text only; no target or content inputs. Provider acceptance does not prove recipient delivery.',inputSchema:schema({request_id:{type:'string'}}),annotations},
];

// No env credentials are read here. Production supplies no transport while the
// pinned provider's retries and automatic contact sharing remain unresolved.
export function createPhotonTest({config={},transport,ready=()=>false,publish,expiresAt,now=Date.now}={}) {
 const boot_id=randomUUID(), started=now(), deadline=Date.parse(expiresAt);
 const configured=config.projectId===PROJECT_ID && /^\+[1-9]\d{7,14}$/.test(config.ownerAddress??'') &&
  typeof config.line==='string' && config.line.length>0 && typeof config.dm==='string' && config.dm.length>0 &&
  Number.isFinite(deadline) && deadline>started && deadline<=started+3600_000;
 let state='disarmed', used=false, request, armedAt, timer;
 const active=()=>configured && now()<deadline && ready();
 const status=()=>({boot_id,state,transport:transport?'fixture_or_reviewed_transport':'locked',configured:Boolean(configured),
  deadline:Number.isFinite(deadline)?new Date(deadline).toISOString():null});
 async function close() {clearTimeout(timer);try{await transport?.stop();}catch{/* Never log provider errors. */}}
 async function stop() {state='stopped';request=undefined;await close();}
 async function receive(space,message) {
  if(state!=='listening' || !active())return;
  const timestamp=message.timestamp instanceof Date?message.timestamp.getTime():NaN;
  if(message.platform!=='imessage' || message.direction!=='inbound' || space.__platform!=='imessage' ||
   space.type!=='dm' || space.id!==config.dm || space.phone!==config.line ||
   message.space?.id!==space.id || message.space?.phone!==space.phone || message.space?.type!=='dm' ||
   message.sender?.address!==config.ownerAddress || message.sender?.service!=='iMessage' ||
   message.content?.type!=='text' || message.content.text!==INCOMING_TEXT ||
   typeof message.id!=='string' || !message.id.length || typeof message.reply!=='function' ||
   !Number.isFinite(timestamp) || timestamp<armedAt || timestamp>now() ||
   message.isAutoReply || message.isSystemMessage || message.isServiceMessage || message.isSpam ||
   message.isCorrupt || message.parentId || (message.partCount!=null && message.partCount!==1))return;
  // Reserve synchronously before callback delivery: concurrent/duplicate events
  // cannot replace the only reply target. Capture the bound function privately.
  request={id:randomUUID(),reply:message.reply.bind(message)};
  const current=request;
  state='delivering';
  try {
   const accepted=await publish({request_id:current.id,text:INCOMING_TEXT},()=>active() && request===current);
   if(request===current && state==='delivering')state=accepted?'awaiting_reply':'callback_rejected';
  }catch{if(request===current && state==='delivering')state='callback_unknown';}
  if(['callback_rejected','callback_unknown'].includes(state)){request=undefined;await close();}
 }
 return {status,stop,async call(name,args) {
  if(name==='photon_test_status' && exact(args,[]))return status();
  if(name==='arm_photon_test') {
   if(!exact(args,['boot_id']) || args.boot_id!==boot_id || !active() || !transport || used)return {state:'unavailable'};
   used=true;armedAt=now();state='listening';
   timer=setTimeout(()=>{void stop();},Math.max(1,deadline-now()));timer.unref?.();
   try{await transport.start(receive,()=>active() && !['stopped','provider_accepted','unknown_outcome','callback_unknown','callback_rejected','transport_failed'].includes(state));if(!active() || state==='stopped')await stop();}
   catch{state='transport_failed';request=undefined;await close();}
   return {state};
  }
  if(name==='reply_photon_test') {
   if(!exact(args,['request_id']) || !active() || !request || args.request_id!==request.id)return {state:'unavailable'};
   if(['sending','provider_accepted','unknown_outcome'].includes(state))return {state};
   // Permit a fast Athena callback during signed event POST, but never after a
   // failed callback. Exact request ID exists only in the authenticated event.
   if(!['delivering','awaiting_reply'].includes(state))return {state:'unavailable'};
   state='sending';const current=request;
   try{const result=await current.reply(REPLY_TEXT);if(request===current && state==='sending')state=result?.id?'provider_accepted':'unknown_outcome';}
   catch{if(request===current && state==='sending')state='unknown_outcome';}
   await close();return {state};
  }
  return {state:'unavailable'};
 }};
}
