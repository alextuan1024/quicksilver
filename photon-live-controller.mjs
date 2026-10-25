import {ownerText} from './messages.mjs';

const fault=code=>Object.assign(new Error(code),{code});
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const terminal=new Set(['photon_auth_failed','photon_scope_failed','photon_ingestion_failed','photon_ingestion_rejected','photon_invalid_session']);

// Live sessions only: no history, provider watermark, or contiguous sequence gate.
export function createPhotonLiveController({route,adapter,receive,isActive,expiresAt,now=Date.now,
  retryDelaysMs=[1000,2000,4000,8000],operationTimeoutMs=10000,activityPollMs=100,idleTimeoutMs=60000}) {
  if(!route||!['projectId','line','ownerAddress','dm'].every(k=>typeof route[k]==='string'&&route[k].length>0)||
    !/^\+[1-9]\d{7,14}$/.test(route.ownerAddress)||route.dm!==`any;-;${route.ownerAddress}`||
    typeof adapter?.open!=='function'||typeof receive!=='function'||typeof isActive!=='function'||
    !integer(expiresAt,now()+1,now()+3600000)||!integer(operationTimeoutMs,1,10000)||
    !integer(activityPollMs,1,1000)||!integer(idleTimeoutMs,1,120000)||!Array.isArray(retryDelaysMs)||
    retryDelaysMs.length>8||!retryDelaysMs.every(n=>integer(n,1,60000)))throw fault('photon_invalid_configuration');
  const pinned=Object.freeze({...route}),delays=[...retryDelaysMs],lifetime=new AbortController();
  let started=false,stopped=false,generation=0,current=null,state='idle',reason=null,done=Promise.resolve();
  const active=()=>!stopped&&!lifetime.signal.aborted&&now()<expiresAt&&isActive()===true;
  const ready=()=>active()&&current!==null&&!current.abort.signal.aborted&&now()<current.session.expiresAt;
  function bounded(task,signal,ms=operationTimeoutMs){return new Promise((resolve,reject)=>{
    let timer,settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);fn(value);};
    const abort=()=>finish(reject,fault('photon_inactive'));
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    if(ms>0)timer=setTimeout(()=>finish(reject,fault('photon_transport_failed')),ms);
    try{Promise.resolve(task()).then(v=>finish(resolve,v),e=>finish(reject,e));}catch(e){finish(reject,e);}
  });}
  async function close(session){try{await bounded(()=>session?.close(),null);}catch{/* Retired generations remain fenced. */}}
  function wait(ms){return new Promise(resolve=>{
    let timer;const finish=()=>{clearTimeout(timer);lifetime.signal.removeEventListener('abort',finish);resolve();};
    if(lifetime.signal.aborted){resolve();return;}lifetime.signal.addEventListener('abort',finish,{once:true});timer=setTimeout(finish,ms);
  });}
  async function connect(){
    const mine=++generation,abort=new AbortController(),cancel=()=>abort.abort();
    lifetime.signal.addEventListener('abort',cancel,{once:true});
    let session,poll,rotate,ending=null,lastActivity=now(),observed=false;
    const usable=()=>active()&&!abort.signal.aborted&&mine===generation&&(!session||now()<session.expiresAt);
    const onActivity=kind=>{if(!usable()||!['heartbeat','event'].includes(kind))return;lastActivity=now();observed=true;if(session)state='listening';};
    try{
      state='connecting';reason=null;
      const opening=Promise.resolve().then(()=>{if(!usable())throw fault('photon_inactive');return adapter.open({signal:abort.signal,isActive:usable,onActivity});});
      opening.then(value=>{if(!usable())void close(value);},()=>{});
      session=await bounded(()=>opening,abort.signal);
      if(!usable())throw fault('photon_inactive');
      if(!integer(session?.expiresAt,now()+1,Number.MAX_SAFE_INTEGER)||typeof session?.close!=='function'||
        typeof session?.sendText!=='function'||typeof session?.live?.[Symbol.asyncIterator]!=='function')throw fault('photon_invalid_session');
      current={session,abort};state=observed?'listening':'subscribing';lastActivity=now();
      rotate=setTimeout(()=>{ending='renew';abort.abort();},Math.max(1,Math.min(Math.floor((session.expiresAt-now())*0.8),expiresAt-now())));
      poll=setInterval(()=>{
        if(!active()){ending=now()>=expiresAt?'expired':'paused';abort.abort();}
        else if(now()>=session.expiresAt){ending='renew';abort.abort();}
        else if(now()-lastActivity>=idleTimeoutMs){ending='retry';abort.abort();}
      },activityPollMs);
      const iterator=session.live[Symbol.asyncIterator]();
      for(;;){
        const next=await bounded(()=>iterator.next(),abort.signal,0);
        if(!usable())throw fault('photon_inactive');
        if(next.done)return 'retry';
        onActivity('event');
        if(!ownerText(next.value,pinned,now()))continue;
        let result;
        try{result=receive(next.value);}catch{throw fault('photon_ingestion_failed');}
        if(result?.then){Promise.resolve(result).catch(()=>{});throw fault('photon_ingestion_rejected');}
        if(result?.accepted!==true)throw fault('photon_ingestion_rejected');
      }
    }catch(error){
      if(!active())return now()>=expiresAt?'expired':stopped?'stopped':'paused';
      if(terminal.has(abort.signal.reason?.code))throw fault(abort.signal.reason.code);
      if(ending==='renew')return 'renew';
      if(terminal.has(error?.code))throw fault(error.code);
      return 'retry';
    }finally{
      if(current?.abort===abort)current=null;
      abort.abort();clearTimeout(rotate);clearInterval(poll);lifetime.signal.removeEventListener('abort',cancel);generation++;
      await close(session);
    }
  }
  async function run(){let retries=0;
    try{
      while(active()){
        const outcome=await connect();if(outcome==='renew')continue;
        if(outcome!=='retry'){state=outcome;reason=outcome==='expired'?'photon_activation_expired':null;return;}
        if(retries>=delays.length)throw fault('photon_retries_exhausted');
        state='backoff';reason='photon_transport_failed';await wait(delays[retries++]);
      }
      if(!stopped){state=now()>=expiresAt?'expired':'paused';reason=state==='expired'?'photon_activation_expired':null;}
    }catch(error){if(!stopped){state='stalled';reason=terminal.has(error?.code)||error?.code==='photon_retries_exhausted'?error.code:'photon_internal_failure';}}
  }
  return {
    status:()=>({state,reason}),
    provider:{ready,messages:{async sendText(...args){
      if(!ready())throw fault('photon_inactive');
      // Capture this generation once. A failed/ambiguous send never moves to a new session.
      const target=current;
      try{return await target.session.sendText(...args);}catch(error){
        if(error?.code==='photon_auth_failed'){
          // Stream termination will classify the session independently; no send retry.
          reason='photon_auth_failed';target.abort.abort(fault('photon_auth_failed'));
        }
        throw fault(error?.code==='photon_auth_failed'?'photon_auth_failed':'photon_transport_failed');
      }
    }}},
    start(){if(started||stopped)throw fault('photon_already_started');started=true;done=run();return this.status();},
    async stop(){stopped=true;state='stopped';reason=null;current?.abort.abort();lifetime.abort();await done;},
  };
}
