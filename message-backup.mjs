import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,rmSync,linkSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openMessageStore,MessageError} from './message-store.mjs';

const FORMAT='quicksilver-backup-v1',aad=Buffer.from(FORMAT);
function requireKey(key){if(!Buffer.isBuffer(key)||key.length!==32)throw new MessageError('invalid_backup_key');}
function present(path){try{lstatSync(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function vacant(path){if([path,path+'-wal',path+'-shm'].some(present))throw new MessageError('destination_exists');}
function sync(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writePrivate(path,data){
  let fd;
  try {fd=openSync(path,'wx',0o600);writeFileSync(fd,data);fsyncSync(fd);}
  catch(error){if(fd!==undefined)rmSync(path,{force:true});if(error.code==='EEXIST')throw new MessageError('destination_exists');throw error;}
  finally {if(fd!==undefined)closeSync(fd);}
}

export function createMessageBackup(store,{path,key,now=Date.now}) {
  requireKey(key);vacant(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const scratch=mkdtempSync(join(dirname(path),'.quicksilver-backup-'));
  try {
    const snapshot=join(scratch,'snapshot.sqlite');store.snapshot(snapshot);
    const backup_id=randomUUID(),captured_at=now();
    const plaintext=Buffer.from(JSON.stringify({backup_id,captured_at,database:readFileSync(snapshot).toString('base64')}));
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad);
    let ciphertext;
    try {ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);}finally{plaintext.fill(0);}
    writePrivate(path,JSON.stringify({format:FORMAT,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')})+'\n');
    sync(dirname(path));return {backup_id,captured_at};
  } finally {rmSync(scratch,{recursive:true,force:true});}
}

export function restoreMessageBackup({path,databasePath,key,identity,now=Date.now}) {
  requireKey(key);vacant(databasePath);
  let payload,database;
  try {
    const envelope=JSON.parse(readFileSync(path,'utf8'));
    if(envelope.format!==FORMAT)throw Error();
    const nonce=Buffer.from(envelope.nonce,'base64'),tag=Buffer.from(envelope.tag,'base64');
    if(nonce.length!==12 || tag.length!==16)throw Error();
    const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad);decipher.setAuthTag(tag);
    const plaintext=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
    try {payload=JSON.parse(plaintext.toString('utf8'));}finally{plaintext.fill(0);}
    database=Buffer.from(payload.database,'base64');
    if(database.subarray(0,16).toString()!=='SQLite format 3\0')throw Error();
  } catch {throw new MessageError('invalid_backup');}
  mkdirSync(dirname(databasePath),{recursive:true,mode:0o700});
  const scratch=mkdtempSync(join(dirname(databasePath),'.quicksilver-restore-'));
  let store;
  try {
    const candidate=join(scratch,'candidate.sqlite');writePrivate(candidate,database);database.fill(0);
    const validation=new DatabaseSync(candidate,{readOnly:true});
    try {
      if(validation.prepare('PRAGMA integrity_check').get().integrity_check!=='ok' ||
        ![1,2].includes(validation.prepare('PRAGMA user_version').get().user_version))throw new MessageError('invalid_backup');
    } finally {validation.close();}
    store=openMessageStore({path:candidate,identity,now});
    store.markRestored({backup_id:payload.backup_id,captured_at:payload.captured_at});
    store.close();store=null; // Checkpoint the paused/quarantined state before publication.
    sync(candidate);vacant(databasePath);
    try {linkSync(candidate,databasePath);}catch(e){if(e.code==='EEXIST')throw new MessageError('destination_exists');throw e;}
    sync(dirname(databasePath));
    return {state:'paused',restore_required:true,backup_id:payload.backup_id,captured_at:payload.captured_at};
  } finally {store?.close();database?.fill(0);rmSync(scratch,{recursive:true,force:true});}
}
