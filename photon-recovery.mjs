import {createHash} from 'node:crypto';
import {ownerText} from './messages.mjs';

class RecoveryFault extends Error {
  constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new RecoveryFault(code);};
const routeFields=['projectId','ownerAddress','dm','line'];
const sameRoute=(a,b)=>a&&b&&routeFields.every(k=>typeof a[k]==='string'&&a[k]===b[k]);
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;

// This contract is deliberately stronger than the pinned SDK's unfiltered,
// per-line catchUp API. No production Photon adapter is supplied or inferred.
export function createPhotonRecovery({route,store,adapter,receive,isActive,expiresAt,now=Date.now,
  retryDelaysMs=[1000,2000,4000,8000],operationTimeoutMs=10000,activityPollMs=100,maxBuffered=128,gapTimeoutMs=operationTimeoutMs}) {
  const contract=adapter?.contract;
  if(contract?.version!==1||contract.verified!==true||contract.scope!=='owner-text-dm'||
    contract.sequence!=='contiguous-owner-text'||!sameRoute(route,contract.route)||typeof adapter.open!=='function')
    fail('recovery_scoped_adapter_required');
  if(!sameRoute(route,store?.identity)||route.dm!==`any;-;${route.ownerAddress}`||
    !/^\+[1-9]\d{7,14}$/.test(route.ownerAddress)||typeof receive!=='function'||typeof isActive!=='function')fail('recovery_invalid_configuration');
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()||expiresAt>now()+3600000||
    !integer(operationTimeoutMs,1,10000)||!integer(gapTimeoutMs,1,60000)||!integer(activityPollMs,1,1000)||!integer(maxBuffered,1,1024)||
    !Array.isArray(retryDelaysMs)||retryDelaysMs.length>8||!retryDelaysMs.every(n=>integer(n,1,60000)))fail('recovery_invalid_configuration');
  const pinned=Object.freeze({...route}),delays=[...retryDelaysMs],lifetime=new AbortController();
  let state='idle',reason=null,started=false,stopped=false,generation=0,sessionAbort,done=Promise.resolve();
  const status=()=>({state,reason,checkpoint:store.checkpoint()});
  const active=()=>!stopped&&!lifetime.signal.aborted&&now()<expiresAt&&isActive()===true;
  function bounded(task,signal,ms=operationTimeoutMs) {
    return new Promise((resolve,reject)=>{
      let timer,settled=false;
      const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);fn(value);};
      const aborted=()=>finish(reject,new RecoveryFault('recovery_aborted'));
      if(signal?.aborted){aborted();return;}
      signal?.addEventListener('abort',aborted,{once:true});
      timer=setTimeout(()=>finish(reject,new RecoveryFault('recovery_timeout')),ms);
      try{Promise.resolve(task()).then(v=>finish(resolve,v),e=>finish(reject,e));}
      catch(error){finish(reject,error);}
    });
  }
  function waitBackoff(ms) {
    return new Promise(resolve=>{
      let timer;
      const finish=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',finish);resolve();};
      if(lifetime.signal.aborted){resolve();return;}
      lifetime.signal.addEventListener('abort',finish,{once:true});timer=setTimeout(finish,ms);
    });
  }
  async function closeSession(session){
    if(!session)return;
    try{await bounded(()=>session.close(),null);}catch{/* Retired generations cannot ingest even if close fails. */}
  }
  const fingerprint=event=>createHash('sha256').update(JSON.stringify([
    event.message.guid,event.message.content.text,event.message.dateCreated.getTime(),event.chatGuid,event.message.sender.address,
  ])).digest('hex');
  async function runSession() {
    const myGeneration=++generation,abort=new AbortController();sessionAbort=abort;
    const terminate=()=>abort.abort();lifetime.signal.addEventListener('abort',terminate,{once:true});
    let session,rotation,poll,ending,gapTimer,gapFailure;
    try{
      state='connecting';reason=null;
      const after=store.checkpoint();
      // Discard and close authentication results arriving after cancellation.
      const opening=Promise.resolve().then(()=>adapter.open({route:pinned,after,signal:abort.signal}));
      opening.then(value=>{if(abort.signal.aborted||myGeneration!==generation)void closeSession(value);},()=>{});
      session=await bounded(()=>opening,abort.signal);
      if(!active())fail('recovery_inactive');
      if(!Number.isSafeInteger(session?.expiresAt)||session.expiresAt<=now()||typeof session.close!=='function'||
        typeof session.catchUp!=='function'||typeof session.live?.[Symbol.asyncIterator]!=='function')fail('recovery_invalid_session');
      const remaining=session.expiresAt-now();
      rotation=setTimeout(()=>{ending='renew';abort.abort();},Math.max(1,Math.min(Math.floor(remaining*0.8),expiresAt-now())));
      poll=setInterval(()=>{if(!active()){ending=now()>=expiresAt?'expired':'paused';abort.abort();}},activityPollMs);
      const buffer=new Map();
      const usable=()=>active()&&now()<session.expiresAt&&!abort.signal.aborted&&myGeneration===generation;
      function accept(input) {
        if(!usable())fail('recovery_inactive');
        if(input?.type==='heartbeat')return;
        if(!integer(input?.sequence,1,Number.MAX_SAFE_INTEGER))fail('recovery_invalid_sequence');
        if(!ownerText(input,pinned,now()))fail('recovery_owner_rejected');
        const event=structuredClone(input),hash=fingerprint(event),sequence=event.sequence;
        if(sequence<=store.checkpoint()){
          if(store.receipt(sequence)!==hash)fail('recovery_sequence_conflict');
          return;
        }
        const previous=buffer.get(sequence);
        if(previous){if(previous.hash!==hash)fail('recovery_sequence_conflict');return;}
        if(buffer.size>=maxBuffered&&sequence!==store.checkpoint()+1)fail('recovery_buffer_full');
        buffer.set(sequence,{event,hash});
        while(buffer.has(store.checkpoint()+1)){
          if(!usable())fail('recovery_inactive');
          const next=store.checkpoint()+1,item=buffer.get(next);let result;
          try{result=receive(item.event,String(next));}catch{fail('recovery_ingestion_failed');}
          if(result?.then){Promise.resolve(result).catch(()=>{});fail('recovery_ingestion_rejected');}
          if(result?.accepted!==true)fail('recovery_ingestion_rejected');
          // receive is synchronous and must commit the deduplicating message store.
          // A crash here replays the same message; it cannot re-execute a claim.
          try{store.commit(next,item.hash);}catch{fail('recovery_checkpoint_failed');}
          buffer.delete(next);
        }
        if(buffer.size===0){clearTimeout(gapTimer);gapTimer=undefined;}
        else if(gapTimer===undefined)gapTimer=setTimeout(()=>{
          gapFailure=new RecoveryFault('recovery_sequence_gap_timeout');abort.abort();
        },gapTimeoutMs);
      }
      async function consumeLive(){
        const iterator=session.live[Symbol.asyncIterator]();
        for(;;){const item=await bounded(()=>iterator.next(),abort.signal);if(item.done)throw Error('stream_closed');accept(item.value);}
      }
      state='recovering';
      const live=consumeLive(); // Start consuming before constructing catch-up.
      const history=(async()=>{
        const stream=session.catchUp({after,signal:abort.signal});
        if(typeof stream?.[Symbol.asyncIterator]!=='function')fail('recovery_invalid_session');
        const iterator=stream[Symbol.asyncIterator]();
        for(;;){
          const item=await bounded(()=>iterator.next(),abort.signal);
          if(item.done)fail('recovery_incomplete_history');
          if(item.value?.type==='catchup.complete'){
            const end=item.value;
            if(end.truncated!==false)fail('recovery_history_truncated');
            if(!integer(end.headSequence,after,Number.MAX_SAFE_INTEGER)||end.headSequence>store.checkpoint())fail('recovery_history_gap');
            if(!usable())fail('recovery_inactive');
            state='listening';return;
          }
          accept(item.value);
        }
      })();
      // History success leaves the live reader active. Either reader's failure
      // retires the whole generation; no catch-up/live handover gap is introduced.
      await Promise.race([live,history.then(()=>live)]);
    }catch(error){
      if(gapFailure)throw gapFailure;
      if(ending==='renew'&&active())return 'renew';
      if(!active())return now()>=expiresAt?'expired':stopped?'stopped':'paused';
      if(error instanceof RecoveryFault&&!['recovery_timeout','recovery_aborted'].includes(error.code))throw error;
      return 'retry';
    }finally{
      abort.abort();clearTimeout(rotation);clearTimeout(gapTimer);clearInterval(poll);
      lifetime.signal.removeEventListener('abort',terminate);generation++;
      await closeSession(session);
    }
  }
  async function run(){
    let retries=0;
    try{
      while(active()){
        const outcome=await runSession();
        if(outcome==='renew')continue;
        if(outcome!=='retry'){state=outcome;reason=outcome==='expired'?'recovery_activation_expired':null;return;}
        if(retries>=delays.length)fail('recovery_retries_exhausted');
        state='backoff';reason='recovery_connection_failed';
        const delay=delays[retries++];
        await waitBackoff(delay);
      }
      if(!stopped){state=now()>=expiresAt?'expired':'paused';reason=state==='expired'?'recovery_activation_expired':null;}
    }catch(error){if(!stopped){state='stalled';reason=error instanceof RecoveryFault?error.code:'recovery_internal_failure';}}
  }
  return {status,
    start(){if(started||stopped)fail('recovery_already_started');started=true;done=run();return status();},
    async stop(){stopped=true;state='stopped';reason=null;lifetime.abort();sessionAbort?.abort();await done;},
  };
}
