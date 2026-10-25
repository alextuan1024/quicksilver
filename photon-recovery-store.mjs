import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,closeSync,chmodSync,constants} from 'node:fs';
import {dirname} from 'node:path';

const fail=code=>{throw Error(code);};
const valid=value=>typeof value==='string'&&value.length>0&&value.length<=512;
export function openPhotonRecoveryStore({path,identity,messageStoreId}) {
  const fields=['projectId','ownerAddress','dm','line','issuer','clientId','subject'];
  if(typeof path!=='string'||!path||path===':memory:')fail('recovery_durable_path_required');
  if(!identity||!fields.every(k=>valid(identity[k]))||!valid(messageStoreId))fail('recovery_invalid_identity');
  const pinned=Object.freeze(Object.fromEntries(fields.map(k=>[k,identity[k]])));
  const binding=JSON.stringify([...fields.map(k=>pinned[k]),messageStoreId]);
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  closeSync(fd);chmodSync(path,0o600);
  const db=new DatabaseSync(path);let closed=false;
  const get=(sql,...a)=>db.prepare(sql).get(...a),run=(sql,...a)=>db.prepare(sql).run(...a);
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}
  try{
    db.exec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if(![0,1].includes(get('PRAGMA user_version').user_version))fail('recovery_database_version');
    tx(()=>{
      db.exec('CREATE TABLE IF NOT EXISTS state (binding TEXT NOT NULL,sequence INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS receipts (sequence INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL); PRAGMA user_version=1;');
      const previous=get('SELECT * FROM state');
      if(previous&&previous.binding!==binding)fail('recovery_identity_mismatch');
      if(!previous)run('INSERT INTO state VALUES (?,0)',binding);
    });
  }catch(e){db.close();if(e.errcode===5)fail('recovery_database_in_use');throw e;}
  return {
    identity:pinned,messageStoreId,
    checkpoint:()=>get('SELECT sequence FROM state').sequence,
    receipt:sequence=>get('SELECT fingerprint FROM receipts WHERE sequence=?',sequence)?.fingerprint,
    commit(sequence,fingerprint){
      if(!Number.isSafeInteger(sequence)||sequence<1||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))fail('recovery_invalid_receipt');
      tx(()=>{
        if(sequence!==get('SELECT sequence FROM state').sequence+1)fail('recovery_sequence_gap');
        run('INSERT INTO receipts VALUES (?,?)',sequence,fingerprint);run('UPDATE state SET sequence=?',sequence);
      });
    },
    close(){if(!closed){closed=true;db.close();}},
  };
}
