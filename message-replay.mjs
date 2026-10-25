import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';

// Accessors share the message database's synchronous transaction boundary.
export function createMessageReplay({get,run,tx,fail}) {
  const fresh=()=>({epoch:randomUUID(),key:randomBytes(32).toString('base64url'),generation:0});
  run("INSERT OR IGNORE INTO metadata VALUES ('replay',?)",JSON.stringify(fresh()));
  const state=()=>JSON.parse(get("SELECT value FROM metadata WHERE key='replay'").value);
  const save=value=>run("UPDATE metadata SET value=? WHERE key='replay'",JSON.stringify(value));
  const head=()=>get('SELECT coalesce(max(seq),0) AS n FROM event_outbox').n;
  const prefix=()=>{const first=get("SELECT min(seq) AS n FROM event_outbox WHERE state NOT IN ('acknowledged','cancelled')").n;
    return first===null?head():first-1;};
  const sign=(value,key)=>createHmac('sha256',Buffer.from(key,'base64url')).update(value).digest('base64url');
  function cursor(before=Infinity){const current=state(),value=`r1.${current.epoch}.${Math.min(prefix(),before)}`;
    return `${value}.${sign(value,current.key)}`;}
  function validate(value){
    if(value===null || value===undefined)return {sequence:null,truncated:false};
    if(typeof value!=='string' || value.length>200 || !/^r1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(0|[1-9]\d{0,15})\.[A-Za-z0-9_-]{43}$/.test(value))fail('invalid_cursor');
    const [,epoch,raw,mac]=value.split('.'),sequence=Number(raw),current=state();
    if(!Number.isSafeInteger(sequence))fail('invalid_cursor');
    const expected=sign(`r1.${epoch}.${raw}`,current.key);
    if(!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))fail('invalid_cursor');
    // Authenticate old-history cursors before reporting truncation. Restoration
    // preserves this integrity key, not the epoch or subscription credentials.
    if(epoch!==current.epoch)return {sequence:0,truncated:true};
    if(sequence>head())fail('invalid_cursor');
    return {sequence,truncated:false};
  }
  return {
    cursor,validate,epoch:()=>state().epoch,generation:()=>state().generation,
    // Called inside markRestored's transaction. A restore is a new replay history.
    reset(){save({...fresh(),key:state().key});},
    subscribe(target,value){return tx(()=>{
      const {sequence,truncated}=validate(value),current=state();
      if(current.generation>=Number.MAX_SAFE_INTEGER)fail('replay_generation_exhausted');
      save({...current,generation:current.generation+1});
      // Late callbacks from the replaced subscription cannot settle these rows.
      run("UPDATE event_outbox SET state='pending',next_attempt=0 WHERE state='in_flight'");
      if(sequence!==null){
        run(`UPDATE event_outbox SET state='pending',attempts=0,next_attempt=0
          WHERE seq>? AND state!='cancelled' AND request_id IN
          (SELECT id FROM requests WHERE restore_hold=0 AND execution!='abandoned')`,sequence);
        run("UPDATE requests SET reason=NULL WHERE reason='event_delivery_failed' AND restore_hold=0 AND id IN (SELECT request_id FROM event_outbox WHERE state='pending')");
      }
      run("INSERT INTO private_records VALUES('subscription','photon.message.received',?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",JSON.stringify(target));
      return {cursor:cursor(),truncated};
    });},
  };
}
