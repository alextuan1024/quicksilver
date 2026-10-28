import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHmac,randomBytes} from 'node:crypto';
import {fork} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {oauthFixture} from './oauth-fixture.mjs';
import {PROJECT_ID} from '../photon.mjs';

export const owner='+15550000001',dm=`any;-;${owner}`;
export const native=(guid,{date=Date.now(),...changes}={})=>({type:'message.received',sequence:1,isFromMe:false,chatGuid:dm,
  message:{guid,isFromMe:false,chatGuids:[dm],sender:{address:owner,service:'iMessage'},itemType:'normal',
    dateCreated:new Date(date),content:{text:'Synthetic request '+guid,attachments:[]}},...changes});
export async function until(check,label='condition') {
  const deadline=Date.now()+10000;
  do{const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
  assert.fail(`Timed out waiting for ${label}`);
}

export async function productionDrill(t,{listener={mode:'proxy',host:'127.0.0.1',port:0},requestHeaders,localAddress}={}) {
  const secret='whsec_'+randomBytes(32).toString('base64');
  const callbacks=[],sends=[],subscriptions=[],unexpected=[];let holdCallbacks=false,callbackError,messagePath;
  const receiver=createServer(async(req,res)=>{
    try {
      assert.equal(req.method,'POST');assert.equal(req.url,'/events');
      let body='';for await(const chunk of req)body+=chunk;
      const expected=createHmac('sha256',Buffer.from(secret.slice(6),'base64'))
        .update(`${req.headers['webhook-id']}.${req.headers['webhook-timestamp']}.${body}`).digest('base64');
      assert.equal(req.headers['webhook-signature'],`v1,${expected}`);
      assert.ok(req.headers['x-mcp-subscription-id']);
      const event=JSON.parse(body);
      if(event.type==='verification'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({challenge:event.challenge}));return;}
      assert.equal(event.eventId,req.headers['webhook-id']);assert.equal(event.name,'photon.message.received');
      assert.deepEqual(Object.keys(event.data),['request_id']);callbacks.push(event);
      if(!holdCallbacks)res.writeHead(200,{'Content-Type':'application/json'}).end('{}');
    }catch(error){callbackError=error;res.writeHead(500).end('{}');}
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{receiver.closeAllConnections();receiver.close(resolve);}));
  const callbackAddress=`http://127.0.0.1:${receiver.address().port}/events`;

  const f=await oauthFixture(t,async local=>{
    messagePath??=join(dirname(local.databasePath),'messages.sqlite');
    const {expiresAt,trustProxy,google,...auth}=local;
    const config={listener,expiresAt,
      localOAuth:{...auth,google:{clientId:google.clientId,clientSecret:google.clientSecret}},
      photon:{projectId:PROJECT_ID,ownerAddress:owner,line:'shared',dm},photonProjectSecret:'synthetic-project-secret',
      messageHandling:{databasePath:messagePath,workerIntervalMs:10,sendTimeoutMs:5000}};
    const configPath=join(dirname(local.databasePath),'production-config.local.json');
    writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
    const child=fork(fileURLToPath(new URL('./production-drill-child.mjs',import.meta.url)),[configPath,callbackAddress],
      {execArgv:[],env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});
    let nextId=0,output='',exitResult;const pending=new Map();
    child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
    const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{
      exitResult={code,signal};for(const request of pending.values())request.reject(Error('fixture_process_exited'));pending.clear();resolve(exitResult);
    }));
    const ready=new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',()=>reject(Error('fixture_exited_before_ready')));
      child.on('message',async message=>{
        const {kind,value}=message;
        if(kind==='ready')resolve(value);
        else if(kind==='failed')reject(Error(value));
        else if(kind==='result'){
          const request=pending.get(value.id);pending.delete(value.id);
          if(value.error)request?.reject(Error(value.error));else request?.resolve(value.value);
        }else if(kind==='send')sends.push(value);
        else if(kind==='subscribed')subscriptions.push(value);
        else if(kind==='unexpectedSDK')unexpected.push(value);
        else if(kind==='google'){
          try {
            const response=await google.fetch(value.url,{body:value.body,headers:value.headers});
            if(child.connected)child.send({kind:'googleResult',id:value.id,value:{status:response.status,body:await response.json()}});
          }catch(error){if(child.connected)child.send({kind:'googleResult',id:value.id,error:'synthetic_google_failed'});}
        }
      });
    });
    let timer;
    try {
      const {port}=await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture_startup_timeout')),10000);})]);
      return {address:`http://127.0.0.1:${port}`,pid:child.pid,
        command(op,...args){return new Promise((resolve,reject)=>{
          if(exitResult){reject(Error('fixture_process_exited'));return;}
          const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('fixture_command_timeout'));},10000);
          pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
          child.send({kind:'command',id,op,args});
        });},
        async kill(){if(!exitResult)child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');},
        async close(){if(exitResult)return;child.kill('SIGTERM');let timer;
          try{const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture_shutdown_timeout')),10000);})]);
            assert.deepEqual(result,{code:0,signal:null},output);
          }finally{clearTimeout(timer);if(!exitResult){child.kill('SIGKILL');await exited;}}
        },
      };
    }catch(error){child.kill('SIGKILL');await exited;throw error;}
    finally{clearTimeout(timer);}
  },{addressOf:child=>child.address,requestHeaders,localAddress});

  const rpc=(token,method,params={})=>f.request('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`},json:{jsonrpc:'2.0',id:1,method,params}});
  const tool=async(token,name,args={})=>{
    const response=await rpc(token,'tools/call',{name,arguments:args});assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(response.body.error,undefined,JSON.stringify(response.body));return response.body.result.structuredContent;
  };
  return {f,callbacks,sends,subscriptions,unexpected,rpc,tool,
    holdCallbacks(value){holdCallbacks=value;},
    check(){if(callbackError)throw callbackError;assert.deepEqual(unexpected,[]);},
    useMessagePath(path){messagePath=path;},
    async token(){const {code}=await f.login();assert.ok(code);const response=await f.exchange(code);assert.equal(response.status,200);return response.body;},
    async subscribe(token,cursor=null){const response=await rpc(token,'events/subscribe',{
      name:'photon.message.received',arguments:{session:'quicksilver'},delivery:{mode:'webhook',url:'https://callback.example/events',secret},cursor});
      assert.equal(response.status,200);assert.equal(response.body.error,undefined,JSON.stringify(response.body));return response.body.result;
    },
    async connected(){await until(async()=>['subscribing','listening'].includes((await f.auth.command('transport')).state),'Photon subscription');},
  };
}
