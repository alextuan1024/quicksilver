import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync, openSync, closeSync, chmodSync, constants} from 'node:fs';
import {dirname} from 'node:path';
import {createOperations} from './message-operations.mjs';

export class MessageError extends Error {
  constructor(code) { super(code); this.code=code; }
}
export const validId = value => typeof value==='string' && value.length>0 && value.length<=256;
export const validText = value => typeof value==='string' && value.trim().length>0 && Buffer.byteLength(value)<=8192;
const fail = code => {throw new MessageError(code);};

// One deployment/process owns this database. All state changes are synchronous
// transactions; no network await can occur inside a transaction.
export function openMessageStore({path,identity,now=Date.now}) {
  if(typeof path!=='string' || !path || path===':memory:')fail('durable_path_required');
  const keys=['projectId','ownerAddress','dm','line','issuer','clientId','subject'];
  if(!identity || !keys.every(key=>validId(identity[key])))fail('invalid_identity');
  const binding=JSON.stringify(keys.map(key=>identity[key]));
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  closeSync(fd);chmodSync(path,0o600);
  const db=new DatabaseSync(path);
  let closed=false;
  const get=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {const value=fn();db.exec('COMMIT');return value;}
    catch(error){db.exec('ROLLBACK');throw error;}
  }
  try {
    // SQLite's OS lock is released even on SIGKILL. A second process must not
    // run startup recovery while this process may still be sending a reply.
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version=get('PRAGMA user_version').user_version;
    if(![0,1,2].includes(version))fail('unsupported_database_version');
    tx(()=>{
      if(version===1)db.exec('ALTER TABLE requests ADD COLUMN restore_hold INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          provider_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, checkpoint TEXT,
          created_at INTEGER NOT NULL, execution TEXT NOT NULL DEFAULT 'pending',
          closed INTEGER NOT NULL DEFAULT 0, interrupted INTEGER NOT NULL DEFAULT 0, restore_hold INTEGER NOT NULL DEFAULT 0, reason TEXT
        );
        CREATE TABLE IF NOT EXISTS event_outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
          created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reply_outbox (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id),
          response_id TEXT NOT NULL, text TEXT NOT NULL, final INTEGER NOT NULL,
          client_message_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0, provider_id TEXT,
          UNIQUE(request_id,response_id)
        );
        CREATE TABLE IF NOT EXISTS reply_attempts (
          request_id TEXT NOT NULL, response_id TEXT NOT NULL, attempt INTEGER NOT NULL,
          started_at INTEGER NOT NULL, state TEXT NOT NULL, provider_id TEXT,
          PRIMARY KEY(request_id,response_id,attempt),
          FOREIGN KEY(request_id,response_id) REFERENCES reply_outbox(request_id,response_id)
        );
        CREATE TABLE IF NOT EXISTS private_records (
          kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id)
        );
        CREATE TABLE IF NOT EXISTS operator_audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS restored_requests (
          request_id TEXT PRIMARY KEY REFERENCES requests(id)
        );
        PRAGMA user_version=2;
      `);
      const existing=get("SELECT value FROM metadata WHERE key='identity'");
      if(existing && existing.value!==binding)fail('database_identity_mismatch');
      run("INSERT OR IGNORE INTO metadata VALUES ('identity',?)",binding);
      run("INSERT OR IGNORE INTO metadata VALUES ('operations',?)",JSON.stringify({paused:false,restore_required:false,ingest_after:null,restore:null}));
    });
  } catch(error) {
    db.close();
    if(error.errcode===5)throw new MessageError('database_in_use');
    throw error;
  }
  const request=id=>get('SELECT * FROM requests WHERE id=?',id) ?? fail('unknown_request');
  const reply=(id,response)=>get('SELECT * FROM reply_outbox WHERE request_id=? AND response_id=?',id,response) ?? fail('unknown_response');
  const replyResult=row=>({request_id:row.request_id,response_id:row.response_id,state:row.state,
    client_message_id:row.client_message_id,provider_id:row.provider_id});
  function clearSendStall(id) {
    if(!get("SELECT 1 FROM reply_outbox WHERE request_id=? AND state='unknown_outcome'",id))
      run("UPDATE requests SET reason=CASE WHEN interrupted=1 THEN 'processing_interrupted' ELSE NULL END WHERE id=? AND reason='send_unknown'",id);
  }
  const operations=createOperations({db,get,all,run,tx,now,fail,request});
  const mutable=id=>{
    if(operations.isPaused())fail('paused');
    if(id && request(id).restore_hold)fail('restore_review_required');
  };
  return {
    ...operations,
    close(){if(!closed){closed=true;db.close();}},
    accept({provider_id,text,checkpoint=null}) {
      mutable();
      if(!validId(provider_id)||!validText(text)||(checkpoint!==null && (!validId(checkpoint))))fail('invalid_message');
      return tx(()=>{
        const previous=get('SELECT id FROM requests WHERE provider_id=?',provider_id);
        if(previous)return {request_id:previous.id,duplicate:true};
        const request_id=randomUUID(),created=now();
        run('INSERT INTO requests(id,provider_id,text,checkpoint,created_at) VALUES(?,?,?,?,?)',request_id,provider_id,text,checkpoint,created);
        run('INSERT INTO event_outbox(id,request_id,created_at) VALUES(?,?,?)',randomUUID(),request_id,created);
        return {request_id,duplicate:false};
      });
    },
    checkpoint(id){return request(id).checkpoint;},
    claim(id) {
      mutable(id);
      return tx(()=>{
        const current=request(id);
        if(current.execution!=='pending')return {request_id:id,state:current.execution,acquired:false};
        run("UPDATE requests SET execution='claimed',reason=NULL WHERE id=?",id);
        return {request_id:id,state:'claimed',acquired:true,text:current.text};
      });
    },
    enqueueReply({request_id,response_id,text,final}) {
      mutable(request_id);
      if(!validId(request_id)||!validId(response_id)||!validText(text)||typeof final!=='boolean')fail('invalid_reply');
      return tx(()=>{
        const current=request(request_id);
        const previous=get('SELECT * FROM reply_outbox WHERE request_id=? AND response_id=?',request_id,response_id);
        if(previous){
          if(previous.text!==text || previous.final!==Number(final))fail('response_conflict');
          return replyResult(previous);
        }
        if(current.closed)fail('request_closed');
        if(current.execution!=='claimed')fail('request_not_claimed');
        run('INSERT INTO reply_outbox(request_id,response_id,text,final,client_message_id) VALUES(?,?,?,?,?)',
          request_id,response_id,text,Number(final),randomUUID());
        run("UPDATE requests SET interrupted=0,reason=CASE WHEN reason='processing_interrupted' THEN NULL ELSE reason END WHERE id=?",request_id);
        // This ID could have been sent after the snapshot and be absent from it.
        // Execution review cannot establish the outcome of each missing reply.
        if(get('SELECT 1 FROM restored_requests WHERE request_id=?',request_id)) {
          run("UPDATE reply_outbox SET state='unknown_outcome' WHERE request_id=? AND response_id=?",request_id,response_id);
          run("UPDATE requests SET reason='send_unknown' WHERE id=?",request_id);
        }
        if(final)run("UPDATE requests SET closed=1,execution='completed' WHERE id=?",request_id);
        return replyResult(reply(request_id,response_id));
      });
    },
    reserveEvent() {
      if(operations.isPaused())return undefined;
      return tx(()=>{
        const event=get("SELECT * FROM event_outbox WHERE state='pending' AND request_id IN (SELECT id FROM requests WHERE restore_hold=0) AND next_attempt<=? ORDER BY seq LIMIT 1",now());
        if(!event)return undefined;
        run("UPDATE event_outbox SET state='in_flight',attempts=attempts+1 WHERE id=?",event.id);
        return {...event,state:'in_flight',attempts:event.attempts+1};
      });
    },
    settleEvent(id,accepted) {
      tx(()=>{
        const event=get("SELECT * FROM event_outbox WHERE id=? AND state='in_flight'",id);
        if(!event)return;
        const state=accepted?'acknowledged':event.attempts>=5?'stalled':'pending';
        run('UPDATE event_outbox SET state=?,next_attempt=? WHERE id=?',state,now()+Math.min(60000,1000*2**(event.attempts-1)),id);
        if(state==='stalled')run("UPDATE requests SET reason='event_delivery_failed' WHERE id=? AND execution='pending'",event.request_id);
      });
    },
    reserveReply() {
      if(operations.isPaused())return undefined;
      return tx(()=>{
        const next=get(`SELECT r.*,q.provider_id AS incoming_id FROM reply_outbox r
          JOIN requests q ON q.id=r.request_id WHERE r.state='queued' AND q.restore_hold=0 AND q.execution!='abandoned'
          AND NOT EXISTS (SELECT 1 FROM reply_outbox earlier WHERE earlier.request_id=r.request_id
            AND earlier.seq<r.seq AND earlier.state!='provider_accepted') ORDER BY r.seq LIMIT 1`);
        if(!next)return undefined;
        const attempts=next.attempts+1;
        run("UPDATE reply_outbox SET state='send_attempted',attempts=? WHERE seq=?",attempts,next.seq);
        run("INSERT INTO reply_attempts(request_id,response_id,attempt,started_at,state) VALUES(?,?,?,?,'send_attempted')",
          next.request_id,next.response_id,attempts,now());
        return {...next,state:'send_attempted',attempts};
      });
    },
    settleReply(id,response,{provider_id=null}={}) {
      tx(()=>{
        const current=reply(id,response);
        // A late result after recovery must not silently resolve uncertainty.
        if(current.state!=='send_attempted')return;
        const accepted=validId(provider_id),state=accepted?'provider_accepted':'unknown_outcome';
        run('UPDATE reply_outbox SET state=?,provider_id=? WHERE request_id=? AND response_id=?',state,accepted?provider_id:null,id,response);
        run('UPDATE reply_attempts SET state=?,provider_id=? WHERE request_id=? AND response_id=? AND attempt=?',state,accepted?provider_id:null,id,response,current.attempts);
        if(!accepted)run("UPDATE requests SET reason='send_unknown' WHERE id=?",id);
      });
    },
    recover() {
      tx(()=>{
        run("UPDATE event_outbox SET state=CASE WHEN attempts>=5 THEN 'stalled' ELSE 'pending' END,next_attempt=? WHERE state='in_flight'",now());
        run("UPDATE requests SET reason='event_delivery_failed' WHERE execution='pending' AND id IN (SELECT request_id FROM event_outbox WHERE state='stalled')");
        run("UPDATE requests SET interrupted=1,reason=CASE WHEN reason IS NULL THEN 'processing_interrupted' ELSE reason END WHERE execution='claimed'");
        run("UPDATE reply_outbox SET state='unknown_outcome' WHERE state='send_attempted'");
        run("UPDATE reply_attempts SET state='unknown_outcome' WHERE state='send_attempted'");
        run("UPDATE requests SET reason='send_unknown' WHERE id IN (SELECT request_id FROM reply_outbox WHERE state='unknown_outcome')");
      });
    },
    unknownReplies(){return all("SELECT request_id,response_id,client_message_id FROM reply_outbox WHERE state='unknown_outcome'").map(row=>({...row}));},
    reconcileReply(id,response,{client_message_id,provider_id}) {
      return tx(()=>{
        const current=reply(id,response);
        if(current.state!=='unknown_outcome' || current.client_message_id!==client_message_id || !validId(provider_id))return false;
        run("UPDATE reply_outbox SET state='provider_accepted',provider_id=? WHERE request_id=? AND response_id=?",provider_id,id,response);
        run("UPDATE reply_attempts SET state='provider_accepted',provider_id=? WHERE request_id=? AND response_id=? AND attempt=?",provider_id,id,response,current.attempts);
        clearSendStall(id);return true;
      });
    },
    // Trusted local operator operation, deliberately not exposed to Athena tools.
    resolveReply(id,response,{outcome,ownerVerified,provider_id=null}={}) {
      if(ownerVerified!==true)fail('owner_verification_required');
      if(!['sent','not_sent'].includes(outcome))fail('invalid_resolution');
      return tx(()=>{
        const current=reply(id,response);
        if(current.state!=='unknown_outcome')fail('response_not_uncertain');
        if(outcome==='sent' && !validId(provider_id))fail('provider_id_required');
        run('UPDATE reply_outbox SET state=?,provider_id=? WHERE request_id=? AND response_id=?',
          outcome==='sent'?'provider_accepted':'queued',outcome==='sent'?provider_id:null,id,response);
        run('UPDATE reply_attempts SET state=?,provider_id=? WHERE request_id=? AND response_id=? AND attempt=?',
          outcome==='sent'?'owner_confirmed_sent':'owner_confirmed_not_sent',provider_id,id,response,current.attempts);
        clearSendStall(id);return replyResult(reply(id,response));
      });
    },
    status(id) {
      const current=request(id);
      return {request_id:id,state:current.restore_hold?'stalled':current.reason?'stalled':current.execution,execution:current.execution,
        closed:Boolean(current.closed),restored_origin:Boolean(get('SELECT 1 FROM restored_requests WHERE request_id=?',id)),
        restore_hold:Boolean(current.restore_hold),reason:current.restore_hold?'restore_review_required':current.reason,
        event:get('SELECT state FROM event_outbox WHERE request_id=?',id).state,
        replies:all('SELECT response_id,state,attempts FROM reply_outbox WHERE request_id=? ORDER BY seq',id).map(row=>({...row}))};
    },
    listRequests(){return all('SELECT id FROM requests ORDER BY seq').map(row=>this.status(row.id));},
    putPrivate(kind,id,value){
      if(!['subscription','oauth_grant'].includes(kind) || !validId(id))fail('invalid_private_record');
      run('INSERT INTO private_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',kind,id,JSON.stringify(value));
    },
    getPrivate(kind,id){const row=get('SELECT value FROM private_records WHERE kind=? AND id=?',kind,id);return row?JSON.parse(row.value):null;},
    deletePrivate(kind,id){run('DELETE FROM private_records WHERE kind=? AND id=?',kind,id);},
  };
}
