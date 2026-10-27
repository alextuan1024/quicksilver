import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {pathToFileURL} from 'node:url';
import {loadProductionConfig,readPrivateFile} from './production-config.mjs';

export function requireSupportedNode(version=process.versions.node) {
  const [major,minor,patch]=version.split('.').map(Number);
  if(major!==22||minor<23||(minor===23&&patch<4))throw new Error('unsupported_node_version');
}

// Calling this function is an explicit activation. Construction and listener
// failure must close storage without ever starting the Photon subscription.
export async function startProductionServer(config,{createHost,signal,shutdownGraceMs=10000}={}) {
  let host,server,closing,stopping=false,initialized=false;
  const sockets=new Set();
  async function close() {
    if(closing)return closing;
    stopping=true;
    closing=(async()=>{
      const drained=new Promise(resolve=>{
        if(!server){resolve();return;}
        server.close(()=>resolve());
      });
      const timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();},shutdownGraceMs);
      try {
        const results=await Promise.allSettled([drained,Promise.resolve().then(()=>host?.close())]);
        if(results.some(result=>result.status==='rejected'))throw new Error('production_shutdown_failed');
      }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
    })();
    return closing;
  }
  const onAbort=()=>{stopping=true;if(initialized)void close().catch(()=>{});};
  signal?.addEventListener('abort',onAbort,{once:true});
  try {
    if(signal?.aborted)throw new Error();
    const listener=config.listener;
    // Validate TLS before opening either database.
    const tls=listener.mode==='tls'?{cert:readPrivateFile(listener.certFile),key:readPrivateFile(listener.keyFile),minVersion:'TLSv1.2'}:null;
    const handle=async(req,res)=>{
      try {
        if(stopping){res.writeHead(503,{'Connection':'close'}).end();return;}
        await host.handle(req,res);
      }catch{
        if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"error":"request_failed"}');
        else res.destroy();
      }
    };
    server=tls?httpsServer(tls,handle):httpServer(handle);
    server.requestTimeout=10000;server.headersTimeout=10000;server.timeout=10000;server.keepAliveTimeout=5000;
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    const factory=createHost??(await import('./photon-message-host.mjs')).createPhotonMessageHost;
    host=await factory(config);
    if(stopping||signal?.aborted)throw new Error();
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(listener.port,listener.host,()=>{server.removeListener('error',reject);resolve();});
    });
    if(stopping||signal?.aborted)throw new Error();
    host.start();
    if(stopping||signal?.aborted)throw new Error();
    // After startup, signals immediately fence the host and drain the listener.
    initialized=true;
    return {address:()=>server.address(),close,transportStatus:()=>host.transportStatus()};
  }catch{
    await close().catch(()=>{});
    throw new Error('production_startup_failed');
  }
}

export async function main(args=process.argv.slice(2)) {
  // Do not print argv, config, paths, native exceptions or provider diagnostics.
  let running;const stop=new AbortController();
  const onSignal=()=>stop.abort();
  try {
    requireSupportedNode();
    if(args.length!==3||args[0]!=='--config'||args[2]!=='--activate')throw new Error();
    const config=loadProductionConfig(args[1]);
    process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
    running=await startProductionServer(config,{signal:stop.signal});
    console.log(`quicksilver production port=${running.address().port}; bounded activation`);
    await new Promise(resolve=>{if(stop.signal.aborted)resolve();else stop.signal.addEventListener('abort',resolve,{once:true});});
    await running.close();
  }catch{
    console.error('quicksilver production failed; verify Node >=22.23.4 <23, --config <private-file> --activate, configuration and listener');
    process.exitCode=1;
  }finally{
    await running?.close().catch(()=>{process.exitCode=1;});
    process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
