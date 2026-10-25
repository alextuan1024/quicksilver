import {createLocalMessageService} from './local-service.mjs';
import {createPhotonLiveAdapter} from './photon-live-adapter.mjs';
import {createPhotonLiveController} from './photon-live-controller.mjs';

// Explicit trusted host wiring. Construction never connects and no environment,
// HTTP argument or MCP tool selects this host or its SDK injection seam.
export async function createPhotonMessageHost(config) {
  const now=config.now??Date.now,options=config.photonLive??{};
  let app,closed=false,closing;
  const adapter=createPhotonLiveAdapter({route:config.photon,projectSecret:config.photonProjectSecret,
    now,sdkLoader:options.sdkLoader,operationTimeoutMs:options.operationTimeoutMs});
  const live=createPhotonLiveController({...options.controller,route:config.photon,adapter,now,
    expiresAt:Date.parse(config.expiresAt),isActive:()=>!closed&&app?.messages.recoveryActive()===true,
    receive:event=>app.messages.receive(event)});
  app=await createLocalMessageService({...config,messageHandling:{...config.messageHandling,provider:live.provider}});
  return {messages:app.messages,gate:app.gate,handle:app.handle,revokeGrant:app.revokeGrant,
    start(){if(closed)throw Error('photon_host_closed');return live.start();},
    transportStatus:()=>live.status(),
    close(){if(!closing){closed=true;closing=(async()=>{await live.stop();await app.close();})();}return closing;},
  };
}
