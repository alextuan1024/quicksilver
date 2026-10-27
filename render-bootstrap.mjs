// Health-only staging entry point. Imports builtins only: no credentials,
// configuration, database, OAuth, Photon, or automatic live-mode transition.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

export async function main(args=process.argv.slice(2)) {
  let server,timer;
  const stop=()=>{server?.close();timer??=setTimeout(()=>server?.closeAllConnections(),1000);timer.unref();};
  try {
    const [major,minor,patch]=process.versions.node.split('.').map(Number);
    const value=process.env.PORT??'10000';
    if(major!==22||minor<23||(minor===23&&patch<4)||args.length!==1||args[0]!=='--disabled'||
      !/^[1-9]\d{0,4}$/.test(value)||Number(value)>65535||[18012,18013,19099].includes(Number(value)))throw Error();
    server=createServer((req,res)=>{
      res.writeHead(req.method==='GET'&&req.url==='/livez'?200:503,
        {'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"mode":"disabled"}');
    });
    server.headersTimeout=5000;server.requestTimeout=5000;server.timeout=5000;
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(value),'0.0.0.0',resolve);});
    console.log('quicksilver bootstrap disabled');
    await new Promise(resolve=>server.once('close',resolve));
  }catch{console.error('quicksilver disabled bootstrap failed');process.exitCode=1;}
  finally{clearTimeout(timer);server?.close();process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
