import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,closeSync,chmodSync,constants} from 'node:fs';
import {dirname} from 'node:path';

const fail=code=>{throw new Error(code);};
export function openOAuthStore({path,identity,now=Date.now}) {
  if(typeof path!=='string'||!path||path===':memory:')fail('oauth_durable_path_required');
  const fields=['issuer','resource','clientId','ownerSubject'];
  if(!identity||!fields.every(k=>typeof identity[k]==='string'&&identity[k].length))fail('oauth_invalid_identity');
  const binding=JSON.stringify(fields.map(k=>identity[k]));
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  closeSync(fd);chmodSync(path,0o600);
  const db=new DatabaseSync(path);let closed=false;
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try{const value=fn();db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  try {
    db.exec('PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if(![0,1].includes(get('PRAGMA user_version').user_version))fail('oauth_database_version');
    transaction(()=>{
      db.exec(`CREATE TABLE IF NOT EXISTS identity (binding TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (model TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,
          expires INTEGER,grant_id TEXT,uid TEXT,user_code TEXT,PRIMARY KEY(model,id));
        CREATE INDEX IF NOT EXISTS grant_records ON records(grant_id);
        CREATE INDEX IF NOT EXISTS uid_records ON records(model,uid);
        CREATE INDEX IF NOT EXISTS user_code_records ON records(model,user_code);
        CREATE TABLE IF NOT EXISTS revoked_grants (id TEXT PRIMARY KEY);
        PRAGMA user_version=1;`);
      const previous=get('SELECT binding FROM identity');
      if(previous&&previous.binding!==binding)fail('oauth_identity_mismatch');
      if(!previous)run('INSERT INTO identity VALUES (?)',binding);
    });
  } catch(error){db.close();if(error.errcode===5)fail('oauth_database_in_use');throw error;}
  const read=(sql,...args)=>{
    const row=get(sql,...args,now());return row?JSON.parse(row.payload):undefined;
  };
  const live='(expires IS NULL OR expires>?)';
  function revokeGrant(id) {
    transaction(()=>{
      run('INSERT OR IGNORE INTO revoked_grants VALUES (?)',id);
      run("DELETE FROM records WHERE grant_id=? OR (model='Grant' AND id=?)",id,id);
    });
  }
  class Adapter {
    constructor(model){this.model=model;}
    async upsert(id,payload,expiresIn) {
      if((payload.grantId&&get('SELECT 1 FROM revoked_grants WHERE id=?',payload.grantId))||
        (this.model==='Grant'&&get('SELECT 1 FROM revoked_grants WHERE id=?',id)))fail('oauth_grant_revoked');
      if(expiresIn!==undefined&&(!Number.isFinite(expiresIn)||expiresIn<0))fail('oauth_invalid_expiry');
      run('DELETE FROM records WHERE expires<=?',now());
      run('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?)',this.model,id,JSON.stringify(payload),
        expiresIn===undefined?null:now()+expiresIn*1000,payload.grantId??null,payload.uid??null,payload.userCode??null);
    }
    async find(id){return read(`SELECT payload FROM records WHERE model=? AND id=? AND ${live}`,this.model,id);}
    async findByUid(uid){return read(`SELECT payload FROM records WHERE model=? AND uid=? AND ${live}`,this.model,uid);}
    async findByUserCode(code){return read(`SELECT payload FROM records WHERE model=? AND user_code=? AND ${live}`,this.model,code);}
    async destroy(id){run('DELETE FROM records WHERE model=? AND id=?',this.model,id);}
    async consume(id) {
      transaction(()=>{
        const payload=read(`SELECT payload FROM records WHERE model=? AND id=? AND ${live}`,this.model,id);
        if(!payload||payload.consumed)fail('oauth_record_consumed');
        payload.consumed=Math.floor(now()/1000);
        run('UPDATE records SET payload=? WHERE model=? AND id=?',JSON.stringify(payload),this.model,id);
      });
    }
    async revokeByGrantId(id){revokeGrant(id);}
  }
  return {Adapter,revokeGrant,
    saveLogin(state,payload,seconds) {
      if(!Number.isInteger(seconds)||seconds<1||seconds>600)fail('oauth_invalid_expiry');
      run('DELETE FROM records WHERE expires<=?',now());
      run("INSERT INTO records(model,id,payload,expires) VALUES ('GoogleLogin',?,?,?)",state,JSON.stringify(payload),now()+seconds*1000);
    },
    takeLogin(state,browser) {
      return transaction(()=>{
        const payload=read(`SELECT payload FROM records WHERE model='GoogleLogin' AND id=? AND ${live}`,state);
        if(!payload||payload.browser!==browser)return undefined;
        run("DELETE FROM records WHERE model='GoogleLogin' AND id=?",state);return payload;
      });
    },
    close(){if(!closed){closed=true;db.close();}},
  };
}
