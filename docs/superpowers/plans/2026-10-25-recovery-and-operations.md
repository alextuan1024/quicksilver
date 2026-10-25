# Recovery and Operations Implementation Plan

> Use the existing native, test-first workflow; obtain an independent final review.

**Goal:** Add persistent pause/inspection, explicit stalled-work resolution and encrypted backups with fail-closed restoration to the existing message component.

**Spec:** ../../design-v1/recovery-and-operations.md

**Constraints:** Preserve the current runtime. No deployment, live messaging, credentials, purchases or permission changes. No automatic Photon replay without verified semantics. Backup keys are supplied by the operator, never generated or persisted by this change.

## Tasks

- [x] Extend SQLite with persisted operational controls, per-request restore holds and an operator audit. Test pause across restart, explicit reconciliation and v1 migration.
- [x] Add authenticated inspection and trusted local pause/resume/reconciliation to the service. Test pause while sending and rejection of mutation while paused.
- [x] Add AES-256-GCM backup and non-overwriting restore APIs plus an offline admin CLI. Test tampering, wrong keys/identity, active destination, restore holds, process death and missing post-snapshot requests.
- [x] Document operator procedures and remaining gates; run Node 22.13 full tests, secret scan, diff checks and independent review; fix findings with regression tests.

## Decisions

- Pause blocks ingestion, claims, new replies, event delivery and sending. In-flight operations settle; pause cannot cancel external actions already underway. Inspection and explicit operator reconciliation remain available.
- Restore starts paused, clears restored subscription/grant records, quarantines unfinished work and treats every unresolved reply as uncertain, including previously queued replies.
- Resume is blocked until each quarantined request is reviewed. Owner-confirmed not-started work can be dispatched explicitly; abandoned work cannot send later. Send reconciliation never implicitly restarts Athena work.
- Completing restore reconciliation requires an operator-verified intake time bound (including the old host clock) and establishes a durable inbound timestamp floor. Events at or before that boundary are rejected, including requests absent from the snapshot. The gap is reported; automatic historical catch-up is not claimed.
- Restored-request provenance survives releasing execution holds: missing reply IDs stay uncertain until individually reconciled.
- Backup uses SQLite VACUUM INTO in a private temporary directory after pause/drain; only the encrypted artifact remains. Restore validates identity and integrity and publishes a fully paused database at a new path without overwriting anything.
- The offline CLI uses filesystem authorization and explicit owner-verification flags. It cannot operate on a database held by a running service. Live operator integration is through the trusted local service API; no admin tool is exposed to Athena.
- Retention duration/destination and real backup key provisioning remain operator decisions; no automatic deletion or external configuration is introduced.


## Completion evidence

- Persistent pause/inspection, explicit request resolution, v1 migration and restore controls implemented in `message-operations.mjs` and integrated into the store/service.
- Encrypted snapshots, non-overwriting quarantined restoration and offline CLI implemented in `message-backup.mjs` and `message-admin.mjs`; operator procedures are in `docs/operations.md`.
- Test-first regressions covered pause/restart, in-flight sends, wrong keys, tampering, identity mismatch, active/existing destinations, process death, missing database paths and absent post-snapshot work.
- Independent review found one high-priority issue: missing post-snapshot reply IDs could resend after execution review. A failing regression reproduced it; durable restored-request provenance now holds those replies uncertain. An actual snapshot/send/restore regression also passes.
- Review identified the host-clock assumption. Restore completion now requires an explicit operator-verified UTC intake bound, including old-host clock/shutdown evidence; the code never infers it solely from the restored host clock.
- Final supported checks: `npm exec --yes --package=node@22.13.0 -- npm test` — 117/117 passed; Node 22.13 secret-pattern scan — passed for 37 source files; `git diff --check` — passed. Node's SQLite experimental warning is expected.
- Original runtime, server and Photon transport source remain identical to HEAD. No deployment, live-provider calls, new credentials, purchases or permission changes occurred.
- Before the authorized local wrap-up, work remained uncommitted on branch `work`, based on `6084be4`; this includes the earlier design split and completed message-handling work.
- Remaining integration gates: verified Photon replay/token renewal, OAuth replacement, host activation, real key provisioning, retention/destination, live-provider acceptance, and verified old-host recovery boundary. No external configuration was inferred or performed.


## Bounded completion audit

- The initial independent review had not rechecked the final restoration fix. On explicit follow-up, the same independent reviewer re-read the final implementation and approved this local phase with no remaining blocking findings or local plan omissions.
- Reviewer independently ran `npm exec --yes --package=node@22.13.0 -- node --test message-operations.test.mjs message-backup.test.mjs message-service.test.mjs`: 22/22 passed, including the actual post-snapshot-send restoration regression. Reviewer also confirmed `git diff --check` and unchanged runtime/transport files.
- Parent audit repeated the same affected command (22/22), `npm exec --yes --package=node@22.13.0 -- npm test` (117/117), `npm exec --yes --package=node@22.13.0 -- node scan.mjs` (37 files, passed), and `git diff --check` (passed). No production-code edits were needed after the final recheck.
- All four local plan tasks are complete. This does not claim completion of every item in the broader recovery design: MCP replay cursors are still unimplemented (`bridge.mjs` rejects non-null cursors), as are Photon reconnect/catch-up and token-renewal host integration. Persisted outbox retries are not cursor-based replay. Those need separately scoped implementation, with provider semantics verified before enabling replay. Authentication remains a separate phase and was not implemented in this audit.
- External decisions and authorized live work remain distinct: hosting/activation, real backup key provisioning/escrow, retention/destination, provider compatibility and live acceptance tests, and operator evidence establishing an old-host recovery boundary. No such actions occurred in this audit.
- Working-tree audit before the authorized local wrap-up: branch `work`, HEAD `6084be4dcbd168f93f41184f9fa53bbe493f3e55`; all prior changes preserved and still uncommitted. No commits, staging, resets or deployments were performed.
