import {createOAuthGate} from './oauth.mjs';
import {createBridge,isDiscoveryRequest} from './bridge.mjs';
import {openMessageStore,MessageError,validId} from './message-store.mjs';
import {messageEvent,messageTools,MESSAGE_SCOPE,exact,ownerText} from './messages.mjs';
import {PROJECT_ID} from './photon.mjs';
import {createMessageBackup} from './message-backup.mjs';

async function bounded(operation,timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new MessageError('operation_timeout')),timeoutMs);
    })]);
  } finally {clearTimeout(timer);}
}

// Explicit, trusted composition only. runtime.mjs never opts into this path.
// The host supplies an SDK client for the pinned line and forwards native events
// from its owner-scoped subscription to receive(). Construction does not connect.
export function createMessageService(config) {
  const options=config.messageHandling,now=config.now??Date.now;
  const route=Object.freeze({...config.photon});
  if(route.projectId!==PROJECT_ID || !/^\+[1-9]\d{7,14}$/.test(route.ownerAddress??'') ||
    route.dm!==`any;-;${route.ownerAddress}` || !validId(route.line) ||
    typeof options?.provider?.messages?.sendText!=='function')throw new MessageError('invalid_message_configuration');
  const interval=options.workerIntervalMs??1000,timeout=options.sendTimeoutMs??5000;
  if(!Number.isSafeInteger(interval)||interval<0||interval>60000||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)
    throw new MessageError('invalid_worker_configuration');
  // Only trusted in-process composition can supply a local authorization gate.
  const gate=config.authorizationGate??createOAuthGate({...config,scope:MESSAGE_SCOPE});
  const store=openMessageStore({path:options.databasePath,now,identity:{...route,issuer:config.issuer,
    clientId:config.clientId,subject:config.ownerSubject}});
  store.recover();
  let stopped=false,flushing=null,reconciling=null,timer,stopPromise;
  const active=()=>!stopped && gate.enabled;
  const working=()=>active() && !store.isPaused();
  const requireOpen=()=>{if(stopped)throw new MessageError('message_service_stopped');};
  const inspect=()=>{requireOpen();return {operations:store.operations(),requests:store.listRequests()};};
  const bridge=createBridge({expiresAt:config.expiresAt,now,event:messageEvent,tools:messageTools,
    authorize:(headers,settings)=>gate.authenticate(headers,settings),postCallback:config.postCallback,
    subscriptionStore:{load:()=>store.getPrivate('subscription',messageEvent.name),
      save:target=>store.putPrivate('subscription',messageEvent.name,target),
      clear:()=>store.deletePrivate('subscription',messageEvent.name)},
    onTool:async(name,args)=>{
      if(!active())return {state:'unavailable'};
      try {
        if(name==='message_status' && exact(args,[]))return {state:'ready',...inspect()};
        if(!working())return {state:'unavailable',reason:'paused'};
        if(name==='claim_message' && exact(args,['request_id']) && validId(args.request_id))return store.claim(args.request_id);
        if(name==='reply_message' && exact(args,['request_id','response_id','text','final']))return store.enqueueReply(args);
        return {state:'unavailable',reason:'invalid_arguments'};
      } catch(error) {
        if(error instanceof MessageError)return {state:'unavailable',reason:error.code};
        // Raw SQLite/provider errors may contain private content.
        return {state:'unavailable',reason:'storage_failed'};
      }
    }});
  async function drain() {
    // Limit each batch so a busy inbox cannot starve replies or monopolize the process.
    for(let i=0;i<32 && working() && bridge.hasSubscription();i++){
      const event=store.reserveEvent();if(!event)break;
      let accepted=false;
      try {
        accepted=await bridge.publish({request_id:event.request_id},working,
          {eventId:event.id,timestamp:new Date(event.created_at).toISOString()});
      } catch {/* Only fixed state categories are persisted. */}
      store.settleEvent(event.id,accepted);
    }
    for(let i=0;i<32 && working();i++){
      const reply=store.reserveReply();if(!reply)break;
      let provider_id=null;
      try {
        const result=await bounded(()=>{
          if(!working())throw new MessageError('session_inactive');
          return options.provider.messages.sendText(route.dm,reply.text,{replyTo:reply.incoming_id,
            clientMessageId:reply.client_message_id,enableLinkPreview:false,enableDataDetection:false});
        },timeout);
        if(validId(result?.guid))provider_id=result.guid;
      } catch {/* A timeout or any thrown error is an unknown send outcome. */}
      store.settleReply(reply.request_id,reply.response_id,{provider_id});
    }
  }
  function flush() {
    if(!working())return Promise.resolve();
    if(flushing)return flushing;
    flushing=drain().finally(()=>{flushing=null;});
    return flushing;
  }
  async function reconcileUnknown() {
    const lookup=options.lookup;
    if(lookup?.verified!==true || typeof lookup.findByClientMessageId!=='function')return;
    for(const reply of store.unknownReplies()){
      if(!active())break;
      try {
        const found=await bounded(()=>lookup.findByClientMessageId(reply.client_message_id),timeout);
        if(active() && found?.clientMessageId===reply.client_message_id && validId(found.guid))
          store.reconcileReply(reply.request_id,reply.response_id,{client_message_id:found.clientMessageId,provider_id:found.guid});
      } catch {/* Absence, timeout or lookup failure never permits another send. */}
    }
  }
  function reconcile() {
    if(!active())return Promise.resolve();
    if(reconciling)return reconciling;
    reconciling=reconcileUnknown().finally(()=>{reconciling=null;});return reconciling;
  }
  if(interval>0){timer=setInterval(()=>{void flush().catch(()=>{stopped=true;clearInterval(timer);});},interval);timer.unref?.();}
  return {
    receive(event,checkpoint=null) {
      if(!active())return {accepted:false};
      if(store.isPaused())return {accepted:false,reason:'paused'};
      const message=ownerText(event,route,now());if(!message)return {accepted:false};
      const floor=store.ingestionFloor();
      if(floor!==null && event.message.dateCreated.getTime()<=floor)return {accepted:false,reason:'restore_gap'};
      // Caller must treat a thrown persistence error as failure, not advance its cursor.
      return {accepted:true,...store.accept({...message,checkpoint})};
    },
    flush,reconcile,inspect,
    async pause(){
      requireOpen();store.pause();
      await Promise.allSettled([flushing,reconciling]);
      return stopped?{state:'stopped'}:inspect();
    },
    resume(options){requireOpen();store.resume(options);return inspect();},
    resolveRequest(id,options){requireOpen();store.resolveRequest(id,options);return store.status(id);},
    completeRestore(options){requireOpen();store.completeRestore(options);return inspect();},
    backup(options){
      requireOpen();
      if(flushing || reconciling)throw new MessageError('operations_in_flight');
      return createMessageBackup(store,{...options,now});
    },
    // Local operator API only. Requires actual owner verification outside Athena.
    resolveReply(request_id,response_id,resolution){
      requireOpen();
      return store.resolveReply(request_id,response_id,resolution);
    },
    stop(){
      if(stopPromise)return stopPromise;
      stopped=true;clearInterval(timer);
      stopPromise=Promise.allSettled([flushing,reconciling]).then(()=>store.close());return stopPromise;
    },
    async handle(method,path,headers,body) {
      if(path==='/.well-known/oauth-protected-resource' || path==='/.well-known/oauth-protected-resource/mcp')
        return {status:method==='GET'?200:405,body:method==='GET'?gate.metadata:{error:'method_not_allowed'}};
      if(method==='GET' && path==='/healthz')return {status:200,body:{service:'quicksilver',mode:active()?(store.isPaused()?'paused':'message-session'):'disabled'}};
      if(path==='/proof')return {status:403,body:{error:'operator_trigger_not_configured'}};
      if(path!=='/mcp')return {status:404,body:{error:'not_found'}};
      if(stopped)return {status:503,body:{error:'message_service_stopped'}};
      const auth=await gate.authenticate(headers,{requireSession:!isDiscoveryRequest(method,path,body)});
      if(!auth.principal)return auth;
      if(stopped)return {status:503,body:{error:'message_service_stopped'}};
      return bridge.handle(method,path,headers,body);
    },
  };
}
