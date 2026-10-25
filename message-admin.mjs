import {readFileSync,lstatSync} from 'node:fs';
import {openMessageStore,MessageError} from './message-store.mjs';
import {createMessageBackup,restoreMessageBackup} from './message-backup.mjs';

// Offline only: the same exclusive SQLite lock rejects an active service.
// Config holds databasePath and the pinned identity, never live credentials.
const [configPath,command,...args]=process.argv.slice(2);
let store;
try {
  if(!configPath || !command)throw new MessageError('usage_config_command_required');
  const config=JSON.parse(readFileSync(configPath,'utf8'));
  const verified=args.at(-1)==='--owner-verified';
  const values=verified?args.slice(0,-1):args;
  const lengths={status:0,pause:0,resume:0,'resolve-request':2,'resolve-reply':4,backup:2,restore:2,'complete-restore':1};
  if(!Object.hasOwn(lengths,command)||values.length!==lengths[command])throw new MessageError('invalid_command_arguments');
  let result;
  if(command==='restore')result=restoreMessageBackup({path:values[0],key:readFileSync(values[1]),databasePath:config.databasePath,identity:config.identity});
  else {
    try {if(!lstatSync(config.databasePath).isFile())throw new MessageError('database_missing');}
    catch(error){if(error.code==='ENOENT')throw new MessageError('database_missing');throw error;}
    store=openMessageStore({path:config.databasePath,identity:config.identity});store.recover();
    if(command==='pause')store.pause();
    if(command==='resume')store.resume({ownerVerified:verified});
    if(command==='resolve-request')store.resolveRequest(values[0],{outcome:values[1],ownerVerified:verified});
    if(command==='resolve-reply')store.resolveReply(values[0],values[1],{outcome:values[2],provider_id:values[3]==='-'?null:values[3],ownerVerified:verified});
    if(command==='complete-restore')store.completeRestore({ownerVerified:verified,intakeAfter:values[0].endsWith('Z')?Date.parse(values[0]):NaN});
    if(command==='backup')result=createMessageBackup(store,{path:values[0],key:readFileSync(values[1])});
    result??={operations:store.operations(),requests:store.listRequests()};
  }
  process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) {
  // Never print raw file, SQLite, credential or crypto errors.
  process.stderr.write(JSON.stringify({error:error instanceof MessageError?error.code:'operator_command_failed'})+'\n');
  process.exitCode=1;
} finally {store?.close();}
