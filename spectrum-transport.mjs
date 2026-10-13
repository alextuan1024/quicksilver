import {PROJECT_ID} from './photon.mjs';

// Deliberately not configurable by env, HTTP, or MCP. Review the pinned SDK's
// internal retries/contact sharing before removing this compile-time live lock.
export const SPECTRUM_LIVE_TRANSPORT_ALLOWED=false;
const loadSdk=async()=>{
 const [{Spectrum},{imessage}]=await Promise.all([import('@spectrum-ts/core'),import('@spectrum-ts/imessage')]);
 return {Spectrum,imessage};
};

// A transport contract adapter. Production start is locked; injected SDKs are
// local fixtures only and are never selected using an HTTP/tool/env value.
export function createSpectrumTransport({projectId,projectSecret,sdkLoader=loadSdk}={}) {
 let app,stopped=false,started=false,loop;
 async function stop(){stopped=true;await app?.stop();}
 return {stop,async start(receive,isActive=()=>true) {
  if(started || projectId!==PROJECT_ID || !projectSecret || !isActive())throw Error('transport_unavailable');
  if(sdkLoader===loadSdk && !SPECTRUM_LIVE_TRANSPORT_ALLOWED)throw Error('sdk_review_required');
  started=true;
  const {Spectrum,imessage}=await sdkLoader();
  if(stopped || !isActive())throw Error('transport_unavailable');
  app=await Spectrum({projectId,projectSecret,providers:[imessage.config()],telemetry:false,
   options:{flattenGroups:false,logLevel:'silent'}});
  if(stopped || !isActive()){await stop();return;}
  loop=(async()=>{
   try {
    for await(const [space,message] of app.messages) {
     if(stopped || !isActive())break;
     await receive(space,message);
    }
   }catch{/* Drop provider errors, credentials and message contents. Never restart. */}
   finally{await stop();}
  })();
  // Mark rejection handled without awaiting the long-lived receive stream.
  void loop.catch(()=>{});
 }};
}
