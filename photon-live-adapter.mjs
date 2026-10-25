import {selectLine} from './photon-transport.mjs';
import {validId,validText} from './message-store.mjs';

export class PhotonLiveError extends Error {
  constructor(code){super(code);this.code=code;}
}
const fail=code=>{throw new PhotonLiveError(code);};
const classify=error=>error instanceof PhotonLiveError?error:new PhotonLiveError(
  [401,403].includes(error?.status)||[7,16].includes(error?.grpcCode)||[7,16].includes(error?.code)?
    'photon_auth_failed':'photon_transport_failed');
async function officialLoader() {
  if(process.env.SPECTRUM_CLOUD_URL&&process.env.SPECTRUM_CLOUD_URL!=='https://spectrum.photon.codes')fail('photon_scope_failed');
  const [{cloud},{setLogLevel},{createGrpcClient}]=await Promise.all([
    import('@spectrum-ts/core'),import('@spectrum-ts/core/authoring'),import('@photon-ai/advanced-imessage/grpc'),
  ]);
  setLogLevel('silent');
  return {issueTokens:cloud.issueImessageTokens,createClient:createGrpcClient};
}

// Trusted in-process composition only. This adapter subscribes to future events
// for one exact DM; it never calls catchUp or any account-wide stream/list API.
export function createPhotonLiveAdapter({route,projectSecret,now=Date.now,sdkLoader=officialLoader,operationTimeoutMs=5000}) {
  if(!route||!validId(route.projectId)||!/^\+[1-9]\d{7,14}$/.test(route.ownerAddress)||
    route.dm!==`any;-;${route.ownerAddress}`||!(route.line==='shared'||/^\+[1-9]\d{7,14}$/.test(route.line))||
    typeof projectSecret!=='string'||!projectSecret.trim()||typeof sdkLoader!=='function'||
    !Number.isInteger(operationTimeoutMs)||operationTimeoutMs<1||operationTimeoutMs>5000)fail('photon_scope_failed');
  const pinned=Object.freeze({...route});
  return {async open({signal,isActive,onActivity=()=>{}}={}) {
    if(typeof isActive!=='function'||typeof onActivity!=='function')fail('photon_scope_failed');
    let client,stream,closed=false,closing,expiresAt=Infinity;
    const cancellation=new AbortController();
    const active=()=>!closed&&!signal?.aborted&&now()<expiresAt&&isActive()===true;
    const ensureActive=()=>{if(!active())fail('photon_inactive');};
    function bounded(task,abort=cancellation.signal,ms=operationTimeoutMs) {
      return new Promise((resolve,reject)=>{
        let timer,settled=false;
        const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);abort?.removeEventListener('abort',aborted);fn(value);};
        const aborted=()=>finish(reject,new PhotonLiveError('photon_inactive'));
        if(abort?.aborted){aborted();return;}
        abort?.addEventListener('abort',aborted,{once:true});
        timer=setTimeout(()=>finish(reject,new PhotonLiveError('photon_transport_failed')),ms);
        try{Promise.resolve(task()).then(value=>finish(resolve,value),error=>finish(reject,classify(error)));}
        catch(error){finish(reject,classify(error));}
      });
    }
    async function close() {
      if(!closing){
        closed=true;cancellation.abort();signal?.removeEventListener('abort',onAbort);
        closing=Promise.allSettled([
          bounded(()=>stream?.close(),null),bounded(()=>client?.close(),null),
        ]).then(()=>{});
      }
      await closing;
    }
    const onAbort=()=>{void close();};
    const activity=kind=>{if(active()){try{onActivity(kind);}catch{/* Activity reporting cannot alter transport semantics. */}}};
    try{
      ensureActive();signal?.addEventListener('abort',onAbort,{once:true});
      const sdk=await bounded(sdkLoader);ensureActive();
      if(typeof sdk?.issueTokens!=='function'||typeof sdk?.createClient!=='function')fail('photon_scope_failed');
      const issuedAt=now();
      // The pinned public cloud helper has no AbortSignal parameter. Local waiting
      // is bounded; a late credential response is discarded before client creation.
      const data=await bounded(()=>sdk.issueTokens(pinned.projectId,projectSecret));ensureActive();
      let line;try{line=selectLine(data,pinned.line);}catch{fail('photon_scope_failed');}
      const tokenDeadline=issuedAt+data.expiresIn*1000-5000;
      if(!Number.isSafeInteger(tokenDeadline))fail('photon_scope_failed');
      expiresAt=tokenDeadline;ensureActive();
      client=sdk.createClient({address:line.address,token:line.token,tls:true,retry:false,autoIdempotency:true,
        timeout:Math.min(operationTimeoutMs,expiresAt-now()),channelOptions:{'grpc.enable_retries':0},onHeartbeat:()=>activity('heartbeat')});
      ensureActive();stream=client.messages.subscribeEvents({chat:pinned.dm});
      const live={async *[Symbol.asyncIterator](){
        try{
          for await(const event of stream){ensureActive();activity('event');yield event;}
        }catch(error){throw classify(error);}
        finally{await close();}
      }};
      return {expiresAt,live,close,
        async sendText(dm,text,options){
          try{
            ensureActive();
            const keys=['replyTo','clientMessageId','enableLinkPreview','enableDataDetection'];
            if(dm!==pinned.dm||!validText(text)||!options||Object.keys(options).some(k=>!keys.includes(k))||
              !validId(options.replyTo)||!validId(options.clientMessageId)||options.enableLinkPreview!==false||options.enableDataDetection!==false)fail('photon_scope_failed');
            const result=await bounded(()=>client.messages.sendText(pinned.dm,text,{replyTo:options.replyTo,
              clientMessageId:options.clientMessageId,enableLinkPreview:false,enableDataDetection:false}),cancellation.signal,
              Math.min(operationTimeoutMs,Math.max(1,expiresAt-now())));
            ensureActive();if(!validId(result?.guid))fail('photon_transport_failed');return {guid:result.guid};
          }catch(error){const safe=classify(error);if(safe.code!=='photon_scope_failed')await close();throw safe;}
        },
      };
    }catch(error){await close();throw classify(error);}
  }};
}
