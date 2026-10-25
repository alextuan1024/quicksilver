import {randomUUID} from 'node:crypto';

// Operator mutations are local, filesystem-authorized calls, not Athena tools.
export function createOperations({db,get,all,run,tx,now,fail,request}) {
  const control=()=>JSON.parse(get("SELECT value FROM metadata WHERE key='operations'").value);
  const save=value=>run("UPDATE metadata SET value=? WHERE key='operations'",JSON.stringify(value));
  const verified=options=>{if(options?.ownerVerified!==true)fail('owner_verification_required');};
  const paused=()=>{if(!control().paused)fail('pause_required');};
  const idle=()=>{
    if(get("SELECT 1 FROM event_outbox WHERE state='in_flight'") || get("SELECT 1 FROM reply_outbox WHERE state='send_attempted'"))fail('operations_in_flight');
  };
  const audit=(id,action)=>run('INSERT INTO operator_audit(request_id,action,created_at) VALUES(?,?,?)',id,action,now());
  return {
    isPaused:()=>control().paused,
    ingestionFloor:()=>control().ingest_after,
    operations(){return {...control(),held_requests:get('SELECT count(*) AS n FROM requests WHERE restore_hold=1').n,
      audit:all('SELECT request_id,action,created_at FROM operator_audit ORDER BY seq DESC LIMIT 100').map(row=>({...row}))};},
    pause(){tx(()=>save({...control(),paused:true}));},
    resume(options){verified(options);tx(()=>{
      const state=control();if(state.restore_required)fail('restore_reconciliation_required');
      save({...state,paused:false});
    });},
    resolveRequest(id,options={}) {
      verified(options);paused();idle();
      if(!['not_started','continuing','completed','abandoned'].includes(options.outcome))fail('invalid_resolution');
      tx(()=>{
        const current=request(id),outcome=options.outcome;
        if(outcome==='not_started'){
          if(current.closed || get('SELECT 1 FROM reply_outbox WHERE request_id=?',id))fail('request_cannot_restart');
          run("UPDATE requests SET execution='pending',interrupted=0,reason=NULL,restore_hold=0 WHERE id=?",id);
          // A new event is only created after explicit verification that work did not start.
          run("UPDATE event_outbox SET id=?,state='pending',attempts=0,next_attempt=0,created_at=? WHERE request_id=?",randomUUID(),now(),id);
        } else if(outcome==='abandoned') {
          run("UPDATE requests SET execution='abandoned',closed=1,interrupted=0,reason=NULL,restore_hold=0 WHERE id=?",id);
          run("UPDATE event_outbox SET state='cancelled' WHERE request_id=? AND state!='acknowledged'",id);
          run("UPDATE reply_outbox SET state=CASE WHEN state='unknown_outcome' THEN 'cancelled_unknown' ELSE 'cancelled' END WHERE request_id=? AND state IN ('queued','unknown_outcome')",id);
        } else {
          if(get("SELECT 1 FROM reply_outbox WHERE request_id=? AND state='unknown_outcome'",id))fail('unresolved_replies');
          if(outcome==='continuing' && (current.closed || current.execution==='abandoned'))fail('request_closed');
          run('UPDATE requests SET execution=?,closed=?,interrupted=0,reason=NULL,restore_hold=0 WHERE id=?',
            outcome==='continuing'?'claimed':'completed',outcome==='completed'?1:0,id);
          run("UPDATE event_outbox SET state='cancelled' WHERE request_id=? AND state!='acknowledged'",id);
        }
        audit(id,outcome);
      });
    },
    markRestored({backup_id,captured_at}) {
      if(typeof backup_id!=='string' || !backup_id || !Number.isSafeInteger(captured_at) || captured_at<0 || captured_at>now())fail('invalid_backup_metadata');
      tx(()=>{
        save({...control(),paused:true,restore_required:true,restore:{backup_id,captured_at,restored_at:now(),reconciled_at:null}});
        run('INSERT OR IGNORE INTO restored_requests SELECT id FROM requests');
        run(`UPDATE requests SET restore_hold=1 WHERE execution IN ('pending','claimed')
          OR id IN (SELECT request_id FROM reply_outbox WHERE state IN ('queued','send_attempted','unknown_outcome'))
          OR id IN (SELECT request_id FROM event_outbox WHERE state IN ('pending','in_flight','stalled'))`);
        run("UPDATE requests SET interrupted=1 WHERE execution='claimed'");
        run("UPDATE event_outbox SET state='stalled' WHERE state IN ('pending','in_flight')");
        // A queued snapshot entry may have been sent after the snapshot was captured.
        run("UPDATE reply_outbox SET state='unknown_outcome' WHERE state IN ('queued','send_attempted')");
        run("UPDATE reply_attempts SET state='unknown_outcome' WHERE state='send_attempted'");
        // A restored secret/grant could have been rotated or revoked after capture.
        run('DELETE FROM private_records');
        audit(null,'restore_quarantined');
      });
    },
    completeRestore(options) {
      verified(options);paused();idle();
      tx(()=>{
        const state=control();if(!state.restore_required)fail('restore_not_pending');
        if(get('SELECT 1 FROM requests WHERE restore_hold=1'))fail('unreviewed_requests');
        if(get("SELECT 1 FROM reply_outbox WHERE state='unknown_outcome'"))fail('unresolved_replies');
        if(!Number.isSafeInteger(options.intakeAfter) || options.intakeAfter<state.restore.captured_at)fail('verified_boundary_required');
        const reconciled=now();
        if(reconciled<state.restore.restored_at)fail('clock_moved_backwards');
        const boundary=Math.max(reconciled,options.intakeAfter,state.ingest_after??0);
        save({...state,restore_required:false,ingest_after:boundary,
          restore:{...state.restore,reconciled_at:reconciled,verified_intake_after:options.intakeAfter}});
        audit(null,'restore_reconciled');
      });
    },
    snapshot(path) {
      paused();idle();
      // VACUUM INTO captures committed SQLite state including WAL contents.
      db.prepare('VACUUM INTO ?').run(path);
    },
  };
}
