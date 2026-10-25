# Durable replay and reconnect design

Scope revision after implementation, October 25: the owner accepts missed inbound
messages during disconnects. Historical Photon catch-up is optional/deferred,
not a V1 launch blocker. This document preserves the implemented catch-up design;
its mandatory history/contiguous-sequence requirements do not describe the new
future-only reconnect requirement. See the [current coupling and scope](../../photon-recovery.md).
MCP replay and all durable claim/unknown-send safeguards remain in V1.


Authorized scope: continue the merged V1 roadmap on a separate local branch;
fixtures only, no runtime activation, publication or deployment. Base main is
`da058749aebc1bbb6d18c3759106d45488448d81` (PRs #1–#3 merged).

## Approach and boundaries

Implement MCP replay within the existing message SQLite transaction boundary.
Use a separate explicitly configured Photon lifecycle controller; it must refuse
unverified/unscoped replay adapters. Reusing raw SDK catch-up is ruled out because
the pinned `catchUp(since)` API has no chat filter. Replacing the parked runtime
or upgrading SDKs would exceed this step. These are implementation choices made
within the approved roadmap, not claims of live provider capability.

MCP cursors bind a durable random database epoch and event sequence with an HMAC.
Return only the contiguous acknowledged/cancelled prefix, never a position beyond
pending, stalled or in-flight delivery. A delivered event carries a conservative
cursor before itself; acknowledgment loss therefore causes safe redelivery.
Refresh validates the cursor before callback verification, then atomically saves
the verified subscription and requeues retained events after that cursor. Fence
late callback settlements with a durable replay generation. Claims/replies keep
their existing deduplication and unknown-outcome behavior. Null cursors continue
pending work without resetting completed history. Restore changes the epoch and
signals truncation; malformed/tampered/future cursors fail. No history pruning is
introduced. Operator-approved redispatch must get a new event sequence.

Photon recovery requires a trusted adapter whose owner scope, sequence coverage,
retention and auth lifecycle have been independently verified for its route.
Open live intake before catch-up, reconcile overlap, persist only a contiguous
processed checkpoint, and never advance from a catch-up head alone. Application
persistence precedes checkpoint commit, so a crash may redeliver but cannot skip
accepted work. Bounded buffers/retries/timeouts and generation fencing stop gaps,
expired activation, revoked scope, stale attempts and shutdown from progressing.
Tokens remain in memory and renew through the trusted adapter. Raw shared-line
catch-up remains unsupported; no code contacts real accounts in this stage.

## Acceptance

Fixtures prove cursor refresh/restart, pending holes, invalid/foreign cursors,
ack loss, callback refresh races, restore truncation, stable event IDs and no
second claim/send. Process tests interrupt durable ingestion/checkpoint boundaries.
Provider fixtures prove overlap, out-of-order sequences, gaps, renewal/reconnect,
shutdown cancellation and exact-route rejection. Existing owner, pause/restore and
one-hour activation controls remain intact. Full Node >=22.23.4 <23 suite, audits,
secret checks and independent security/replay/crash review gate local completion.
