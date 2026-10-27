// Test-only subprocess. All upstream I/O is synthetic; no runtime config can
// select these seams. Browser/MCP traffic uses the actual production listener.
import {request} from 'node:http';
import {loadProductionConfig} from '../production-config.mjs';
import {startProductionServer} from '../production-server.mjs';
import {createPhotonMessageHost} from '../photon-message-host.mjs';

globalThis.fetch=()=>{throw Error('unexpected_external_fetch');};
let app,running,stream,sendMode='success',sequence=0,closing;
const googleCalls=new Map(),stop=new AbortController();
const notify=(kind,value)=>{if(process.connected)process.send({kind,value});};
function source() {
  const queue=[];let next,closed=false;
  return {push(event){if(closed)return;if(next){const done=next;next=null;done({value:event,done:false});}else queue.push(event);},
    close(){closed=true;next?.({done:true});next=null;},[Symbol.asyncIterator](){return this;},
    next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(closed)return Promise.resolve({done:true});return new Promise(resolve=>{next=resolve;});}};
}
async function googleFetch(url,options) {
  const id=++sequence;
  const response=await new Promise((resolve,reject)=>{
    googleCalls.set(id,{resolve,reject});
    notify('google',{id,url:String(url),body:String(options?.body??''),headers:[...new Headers(options?.headers)]});
  });
  return Response.json(response.body,{status:response.status});
}
function callback(url,body,headers,{isActive}) {
  if(url!=='https://callback.example/events'||!isActive())throw Error('unexpected_callback');
  const target=new URL(process.argv[3]);
  if(target.hostname!=='127.0.0.1')throw Error('nonlocal_callback_fixture');
  return new Promise((resolve,reject)=>{
    const req=request(target,{method:'POST',headers},res=>{
      let text='';res.on('data',chunk=>{text+=chunk;});res.on('error',reject);
      res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(error){reject(error);}});
    });req.setTimeout(5000,()=>req.destroy(Error('fixture_callback_timeout')));req.on('error',reject);req.end(body);
  });
}
const sdk={
  issueTokens:async()=>({type:'shared',token:'synthetic-token',expiresIn:3600}),
  createClient(options) {
    const live=source();stream=live;
    const messages=new Proxy({
      subscribeEvents(args){notify('subscribed',{args,tls:options.tls,retry:options.retry});return live;},
      async sendText(...args){notify('send',args);if(sendMode==='block')return new Promise(()=>{});return {guid:'synthetic-sent-'+sequence++};},
    },{get(target,key){if(!Object.hasOwn(target,key)){notify('unexpectedSDK',String(key));throw Error('unexpected_sdk_method');}return target[key];}});
    return {messages,close(){live.close();}};
  },
};
async function close() {
  if(!closing)closing=(async()=>{stop.abort();await running?.close();process.disconnect?.();})();
  return closing;
}
for(const name of ['SIGTERM','SIGINT'])process.on(name,()=>{void close().catch(()=>{process.exitCode=1;});});
process.on('message',async message=>{
  if(message.kind==='googleResult'){
    const pending=googleCalls.get(message.id);googleCalls.delete(message.id);
    if(message.error)pending?.reject(Error(message.error));else pending?.resolve(message.value);return;
  }
  if(message.kind!=='command')return;
  const {id,op,args=[]}=message;
  try {
    let value;
    if(op==='emit'){
      for(const event of args){event.message.dateCreated=new Date(event.message.dateCreated);stream.push(event);}value=true;
    }else if(op==='disconnect'){stream.close();value=true;}
    else if(op==='sendMode'){sendMode=args[0];value=true;}
    else if(op==='transport')value=app.transportStatus();
    else if(op==='backup')value=app.messages.backup({...args[0],key:Buffer.from(args[0].key,'base64')});
    else if(['pause','resume','resolveRequest','completeRestore','inspect'].includes(op))value=await app.messages[op](...args);
    else throw Error('unknown_fixture_command');
    notify('result',{id,value});
  }catch(error){notify('result',{id,error:error.code??error.message});}
});

try {
  const config=loadProductionConfig(process.argv[2]);
  running=await startProductionServer(config,{signal:stop.signal,createHost:async c=>{
    app=await createPhotonMessageHost({...c,localOAuth:{...c.localOAuth,google:{...c.localOAuth.google,fetch:googleFetch}},
      postCallback:callback,photonLive:{sdkLoader:async()=>sdk,controller:{retryDelaysMs:[10,10],activityPollMs:5}}});
    return app;
  }});
  notify('ready',{port:running.address().port});
}catch{
  notify('failed','fixture_startup_failed');await close();process.exitCode=1;
}
