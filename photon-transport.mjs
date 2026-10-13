import {randomUUID} from 'node:crypto';
import {PROJECT_ID,INCOMING_TEXT,REPLY_TEXT} from './photon.mjs';

// Remains a code-review/activation gate, never an env or MCP switch.
export const PHOTON_LIVE_TRANSPORT_ALLOWED=false;
const loadSdk=async()=>{
 // The supported cloud helper has an environment URL override. Do not allow
 // a project credential to be directed anywhere except the official origin.
 if(process.env.SPECTRUM_CLOUD_URL && process.env.SPECTRUM_CLOUD_URL!=='https://spectrum.photon.codes')throw Error('cloud_origin_not_allowed');
 const [{cloud},{setLogLevel},{createGrpcClient}]=await Promise.all([
  import('@spectrum-ts/core'),import('@spectrum-ts/core/authoring'),import('@photon-ai/advanced-imessage/grpc')]);
 setLogLevel('silent');
 return {issueTokens:cloud.issueImessageTokens,createClient:createGrpcClient};
};

export function selectLine(data,line) {
 if(!Number.isFinite(data?.expiresIn) || data.expiresIn<=5)throw Error('token_lifetime_unavailable');
 if(data.type==='shared' && line==='shared' && typeof data.token==='string' && data.token.length)
  return {address:'imessage.spectrum.photon.codes:443',token:data.token,phone:'shared'};
 if(data.type==='dedicated' && /^\+[1-9]\d{7,14}$/.test(line??'')) {
  const matches=Object.entries(data.numbers??{}).filter(([,phone])=>phone===line);
  if(matches.length===1) {
   const [instance]=matches[0],token=data.auth?.[instance];
   if(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(instance) && typeof token==='string' && token.length)
    return {address:`${instance}.imsg.photon.codes:443`,token,phone:line};
  }
 }
 throw Error('exact_line_unavailable');
}
function accepted(event,config,armedAt,now) {
 const m=event?.message,c=m?.content,t=m?.dateCreated instanceof Date?m.dateCreated.getTime():NaN;
 return event?.type==='message.received' && event.isFromMe===false && event.chatGuid===config.dm &&
  m?.isFromMe===false && Array.isArray(m.chatGuids) && m.chatGuids.length===1 && m.chatGuids[0]===config.dm &&
  m.sender?.address===config.ownerAddress && m.sender?.service==='iMessage' &&
  typeof m.guid==='string' && m.guid.length>0 && m.itemType==='normal' &&
  Number.isFinite(t) && t>=armedAt && t<=now && c?.text===INCOMING_TEXT &&
  Array.isArray(c.attachments) && c.attachments.length===0 && !c.miniApp && !c.balloonBundleId &&
  !m.isAutoReply && !m.isSystemMessage && !m.isServiceMessage && !m.isSpam && !m.isCorrupt && !m.isAudioMessage &&
  !m.reaction && !m.reactionTargetGuid && (m.partCount==null || m.partCount===1);
}

// Uses only public SDK APIs. Loader injection is for local fixtures, never chosen
// by environment/HTTP/tool input. No Spectrum instance or provider is created.
export function createPhotonTransport({config={},projectSecret,expiresAt,now=Date.now,sdkLoader=loadSdk}={}) {
 const route=Object.freeze({...config});
 let client,stream,timer,stopped=false,started=false,received=false,sent=false,tokenDeadline=0,onTerminal=()=>{};
 const deadline=Date.parse(expiresAt);
 async function stop(reason='stopped'){
  if(!stopped){
   stopped=true;
   // Notify synchronously before cleanup awaits. This invalidates the request
   // even if a provider close is slow, and preserves uncertain in-flight sends.
   try{onTerminal(reason);}catch{/* No provider/request data is passed or logged. */}
  }
  clearTimeout(timer);
  const currentStream=stream,currentClient=client;stream=undefined;client=undefined;
  await Promise.allSettled([currentStream?.close(),currentClient?.close()]);
 }
 return {stop,async start(receive,isActive=()=>true,terminal=()=>{}) {
  const armedAt=now();
  if(started || stopped || route.projectId!==PROJECT_ID || !projectSecret || !isActive() ||
   !/^\+[1-9]\d{7,14}$/.test(route.ownerAddress??'') || route.dm!==`any;-;${route.ownerAddress}` ||
   !Number.isFinite(deadline) || deadline<=armedAt || deadline>armedAt+3600_000)throw Error('transport_unavailable');
  if(sdkLoader===loadSdk && !PHOTON_LIVE_TRANSPORT_ALLOWED)throw Error('live_transport_locked');
  started=true;onTerminal=terminal;
  const active=()=>!stopped && isActive() && now()<deadline && (!tokenDeadline || now()<tokenDeadline);
  try {
   const {issueTokens,createClient}=await sdkLoader();if(!active())return;
   const issuedAt=now();let authTimer;
   // Bound the wait; a late token result is discarded and never opens a client.
   const data=await Promise.race([issueTokens(PROJECT_ID,projectSecret),new Promise((_,reject)=>{
    authTimer=setTimeout(()=>reject(Error('token_exchange_timeout')),5000);
   })]).finally(()=>clearTimeout(authTimer));
   if(!active())return;
   const line=selectLine(data,route.line);tokenDeadline=Math.min(deadline,issuedAt+data.expiresIn*1000-5000);
   if(!active())throw Error('token_expired');
   const remaining=tokenDeadline-now();
   client=createClient({address:line.address,token:line.token,tls:true,retry:false,autoIdempotency:true,
    channelOptions:{'grpc.enable_retries':0},timeout:Math.min(5000,remaining)});
   timer=setTimeout(()=>{void stop(tokenDeadline<deadline?'token_expired':'session_expired');},remaining);timer.unref?.();
   stream=client.messages.subscribeEvents({chat:route.dm});
   const source=stream,sessionClient=client;
   const loop=(async()=>{
    let reason='transport_ended';
    try {
     for await(const event of source) {
      if(!active()){reason=now()>=tokenDeadline?(tokenDeadline<deadline?'token_expired':'session_expired'):'stopped';break;}
      if(received || !accepted(event,route,armedAt,now()))continue;
      received=true;
      const message=event.message,guid=message.guid,dm=route.dm,writeId=randomUUID();
      const space={id:dm,type:'dm',phone:line.phone,__platform:'imessage'};
      const bound={id:guid,platform:'imessage',direction:'inbound',timestamp:new Date(message.dateCreated),
       sender:{address:route.ownerAddress,service:'iMessage'},content:{type:'text',text:INCOMING_TEXT},space,
       reply:async text=>{
        if(sent || !active() || text!==REPLY_TEXT)throw Error('reply_unavailable');
        sent=true; // Reserve before the only outbound RPC; never retry ambiguity.
        const result=await sessionClient.messages.sendText(dm,REPLY_TEXT,{replyTo:guid,clientMessageId:writeId,
         enableLinkPreview:false,enableDataDetection:false});
        return result?.guid?{id:result.guid}:undefined;
       }};
      await receive(space,bound);
     }
    }catch{reason='transport_error'; /* Never expose errors or reconnect/catch up. */}
    finally{await stop(reason);}
   })();void loop.catch(()=>{});
  }catch{await stop('transport_failed');throw Error('transport_start_failed');}
 }};
}
