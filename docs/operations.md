# Local message operations

These controls belong to the optional durable message component. They do not
activate `runtime.mjs`, connect to Photon, deploy anything, or provide verified
provider replay. Use Node 22.23.4+ within Node 22. SQLite may print its experimental
feature warning on this version.

## Production readiness

These local controls were merged in PR #1; local OAuth and dependency fixes were
merged in PR #2. They are not wired into `server.mjs` / `runtime.mjs`. See the
[current roadmap](status.md) for production integration and acceptance gates.
Before operating a hosted channel, choose private persistent storage, backup
destination/retention and key escrow, provision persistent OAuth keys and Google
credentials, verify the proxy/TLS/rate-limit setup, and rehearse interruption,
duplicate delivery and fenced restoration. CI is recommended but not configured.
No live service settings or credentials were checked or changed by this docs update.

## Pause and inspect

For a running host, use its trusted local `service.pause()` and await the result.
Pause is persisted before waiting for current callbacks, sends and lookups to
settle. It blocks new ingestion, claims, reply admission, event delivery and
sending. A send or external Athena action already underway cannot be undone.
Read-only inspection and deliberate provider lookup remain available. Subscription
verification/renewal remains an explicit authenticated operation.

`service.inspect()` returns sanitized operations, request and reply states.
Authenticated `message_status` exposes the same inspection while paused, but no
operator mutations. Public health reports `paused` without messages or identifiers.
`service.resume({ ownerVerified: true })` explicitly re-enables processing after
operator review, subject to the restore barrier below. The flag records a real
owner decision; it is not a substitute for obtaining that decision.

When `receive` returns `reason: 'paused'`, do not advance a replay checkpoint or
assume delivery. Keep the host's intake paused as appropriate. Messages during a
pause/disconnect may be missed and need owner resubmission. Historical Photon
catch-up is deferred under the V1 scope decision; this never permits automatic
retries of uncertain sends or re-execution of already claimed work.

## Offline CLI

Stop the host and its Photon client first. The CLI takes the same exclusive
SQLite lock; it cannot operate on a database held by another process. Protect the
config file and database directory with owner-only access. The config contains
`databasePath` and `identity` with the exact stored `projectId`, `ownerAddress`,
`dm`, `line`, `issuer`, `clientId` and `subject`; copy them from trusted host
configuration. It contains no OAuth tokens or provider credentials. Do not commit
it (`operator-config.local.json` is ignored).

```sh
node message-admin.mjs operator-config.local.json status
node message-admin.mjs operator-config.local.json pause
node message-admin.mjs operator-config.local.json resume --owner-verified
```

Commands print JSON status or fixed error categories, never message text,
credentials or raw errors. `status` includes up to 100 recent request-resolution and restore decisions.
A restart keeps pause, restore holds and the restored intake boundary intact.

## Resolve stalled work

Pause first. Inspect the request and verify the external outcome with the owner
and the original Athena execution. Never infer failure from a timeout or a
missing lookup result. Leave uncertain work paused or abandon it; do not guess.

```sh
node message-admin.mjs operator-config.local.json resolve-reply REQUEST_ID RESPONSE_ID sent PROVIDER_ID --owner-verified
node message-admin.mjs operator-config.local.json resolve-reply REQUEST_ID RESPONSE_ID not_sent - --owner-verified
node message-admin.mjs operator-config.local.json resolve-request REQUEST_ID continuing --owner-verified
node message-admin.mjs operator-config.local.json resolve-request REQUEST_ID completed --owner-verified
node message-admin.mjs operator-config.local.json resolve-request REQUEST_ID abandoned --owner-verified
node message-admin.mjs operator-config.local.json resolve-request REQUEST_ID not_started --owner-verified
```

- `sent` marks acceptance without sending. `not_sent` requeues the same durable
  client message ID only after explicit verification; paused workers still wait.
- `continuing` confirms the original work is still running; it never makes a
  duplicate claim executable. `completed` closes admission without inventing a
  reply or repeating an external action. Resolve uncertain replies separately.
- `abandoned` closes the request and cancels pending delivery. Unknown sends
  remain visibly `cancelled_unknown`; abandonment does not claim they failed.
- `not_started` explicitly authorizes a new dispatch only after verifying no
  actions started and the old execution cannot resume. It is rejected for a
  closed request or one with any reply records. This is an intentional operator
  retry with a new event ID, never automatic crash recovery.

The equivalent local APIs are `service.resolveRequest(id, {outcome,
ownerVerified: true})` and `service.resolveReply(id, responseId, {outcome,
ownerVerified: true, provider_id})`. Request resolution requires pause and no
in-flight operations. The dedicated trusted provider lookup adapter and
`service.reconcile()` can establish acceptance while paused. A not-found result
never authorizes sending again.

## Encrypted backup

Pause/drain first, or stop the host and use the offline CLI. Supply an existing
operator-managed file containing exactly 32 raw key bytes, outside the checkout
and backup directory. Key provisioning, escrow and rotation are operator work;
these commands never generate or save a key. Losing the key makes the backup
unrecoverable.

```sh
node message-admin.mjs operator-config.local.json pause
node message-admin.mjs operator-config.local.json backup /private/backups/snapshot.qsb /private/keys/backup.key
```

The local running-host equivalent is `await service.pause()` followed by
`service.backup({path, key})`, where `key` is the supplied 32-byte Buffer. SQLite
`VACUUM INTO` captures committed WAL state consistently. The artifact uses
AES-256-GCM with a random nonce and authenticated format identifier. Existing
artifacts are never overwritten; output is mode 0600.

A private mode-0700 temporary directory briefly contains the plaintext SQLite
snapshot and is removed on normal completion or error. A process kill can leave
that scratch directory behind: after confirming no backup/restore is running,
inspect and remove only the abandoned `.quicksilver-backup-*` or
`.quicksilver-restore-*` directory belonging to that operation. Keep its parent on
a restricted local volume. SQLite itself is private plaintext, not encrypted at
rest by this component.

No retention duration or remote destination is chosen. Set those policies before
production, retain a recoverable key separately, and do not prune deduplication
state without reviewing replay consequences. Never copy a live SQLite file as a
substitute for the backup command.

## Restore and reconcile

1. Stop the old deployment and confirm its workers and Athena actions cannot
   resume unexpectedly. Restore to a **new database path** in a private directory;
   set that path in a separate operator config with the same pinned identity.
2. Run restore. The destination must not exist, including WAL/SHM sidecars.
   Wrong keys, tampering and identity mismatches are rejected before publication.

   ```sh
   node message-admin.mjs restore-config.local.json restore /private/backups/snapshot.qsb /private/keys/backup.key
   node message-admin.mjs restore-config.local.json status
   ```

3. The restored database is paused and restore-blocked. All unfinished requests
   are held for review. Every unresolved reply, including one merely queued at
   capture, becomes uncertain: it could have sent after the snapshot. Restored
   subscription secrets and local grants are cleared because they could have
   been rotated/revoked after capture. Restore never revives them automatically.
4. Verify external outcomes and use the resolution commands above for every held
   request. Resolve uncertain replies or explicitly abandon the request. Owner
   verification is required; the code cannot establish whether external actions
   happened after capture.
5. Complete reconciliation, then explicitly resume:

   ```sh
   node message-admin.mjs restore-config.local.json complete-restore VERIFIED_BOUNDARY_UTC --owner-verified
   node message-admin.mjs restore-config.local.json resume --owner-verified
   ```

`VERIFIED_BOUNDARY_UTC` must be an ISO timestamp (including `Z`) that the
operator has verified is at or after every native event the original deployment
could already have processed, accounting for its clock and shutdown time. Do not
substitute the restored host's current time without checking the old host's
clock. If this bound cannot be established, keep restore blocked; provider
sequence/lookup evidence is additional integration work, not something this
component guesses. The local API is `service.completeRestore({ownerVerified:
true, intakeAfter: verifiedEpochMilliseconds})`.

Completing reconciliation records a durable timestamp boundary at least as late
as that verified bound, local completion time and any prior restore boundary,
along with the snapshot recovery gap. Native events dated at or before that boundary are rejected with
`restore_gap`, including requests created after the snapshot and absent from the
database. This deliberately sacrifices historical catch-up to avoid repeating
possibly completed work. Review those messages externally; ask the owner for a
new message when needed. Only owner-reviewed queued work or events newer than
the boundary may proceed. A restored request keeps its recovery provenance even after its hold is lifted:
new response IDs on that request are admitted as `unknown_outcome`, since their
records could be missing from the snapshot. Each needs explicit send
reconciliation before any send, even when execution was reviewed as continuing
or not started. This restriction does not apply to genuinely new post-boundary
requests. Fresh callback verification is required before event
delivery; host connection/authentication setup remains separate.

The restore API is `restoreMessageBackup({path, databasePath, key, identity})` in
`message-backup.mjs`. Publication links a fully paused, validated database into a
new destination without replacement. If an operation reports an error after a
filesystem interruption, inspect the destination before retrying; an existing
destination is never overwritten. Restarts and process death do not clear the
restore barrier or intake boundary.

## Local OAuth and message recovery

The optional [local OAuth component](local-oauth.md) stores grants separately from
message state. After message restoration, fence the old host, start a fresh OAuth
database and require reconnection. Never restore an old OAuth snapshot: it could
revive revoked credentials. OAuth revocation blocks subsequent authenticated
requests; pause messaging separately to settle work already in flight.


## Replay, reconnect and optional transport checkpoints

[MCP replay](event-replay.md) remains required for persisted requests. V1 accepts
missed inbound messages while Photon is disconnected; historical catch-up and
history-scope verification are not launch blockers. Future-only live reconnect and
token renewal now have [fixture-tested SDK/host wiring](photon-live.md), awaiting
real-provider acceptance. Record outages truthfully without
claiming the offline interval was recovered. Existing claim, unknown-send, pause,
restore-hold and verified intake-boundary controls remain unchanged.

The [retained catch-up controller](photon-recovery.md) is optional deferred work.
If used in a future authorized phase, its checkpoint store must bind to
`service.recoveryIdentity()`. Never attach a stale checkpoint to a restored message
database, copy a live database or reset its sequence to an advertised head.
A restored generation needs a new checkpoint store and a verified scoped
history/baseline for that optional path. These additional catch-up requirements
are not prerequisites for a future-only V1 host. The current controller has no
future-only mode; see its documented design coupling before adapting it.


## Future-only live host lifecycle

The [live host factory](photon-live.md) requires explicit trusted construction and
`start()`; creating it does not connect. Close its HTTP listener, then await host
`close()` to fence/stop Photon before closing message/OAuth storage. A paused,
expired, stopped or permanently failed controller does not silently restart;
review the status and create a new host only under the approved activation policy.

Queued replies remain queued while the sender reports disconnected. A disconnect
or token retirement after reservation can make an in-flight reply uncertain; it
is not retried on the new session. Existing inspection/reconciliation procedures
apply. Native GUID deduplication and claims remain durable across reconnects and
process restarts. No history read or catch-up checkpoint is part of this live path.
