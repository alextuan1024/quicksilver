# Durable MCP event replay

The optional durable message component supports `events/subscribe` cursors for
`photon.message.received`. The parked proof runtime is unchanged and continues to
return null cursors. This local implementation does not establish ChatGPT live
acceptance or recover events that Photon has not delivered to the message store.

## Cursor contract

Subscription responses and event payloads carry opaque `r1` cursors. Preserve them
verbatim; their format is an internal implementation detail. They bind the message
database generation and event sequence with an HMAC. Malformed, tampered or future
positions in the current generation are rejected before callback verification.
An authenticated cursor from an older restored generation returns `truncated: true` and restarts from the
available retained history rather than trusting the supplied position. Foreign
databases and modified epochs fail integrity validation. Restore preserves the
cursor integrity key so old-history cursors can be identified, but changes the
epoch and clears subscription credentials; cursors are not authorization tokens.

A cursor never advances past pending, in-flight or stalled event delivery. Even
a successful later callback cannot move past an earlier gap. The event being sent
carries a conservative cursor before itself: replay can repeat that last event.
Event IDs and original event timestamps stay stable; webhook signature timestamps
are fresh on each attempt. The receiver must deduplicate IDs, and Athena must
execute only when `claim_message` returns `acquired: true`. A replay is not an
instruction to restart an interrupted claim or resend an uncertain reply.

An authenticated refresh with a valid non-null cursor verifies the callback, then
atomically stores its subscription and requeues retained events after that cursor.
Replay resets the bounded callback-attempt budget for those events. A refresh with
a null/omitted cursor continues existing pending work without replaying acknowledged
history. A durable generation counter prevents a completion from the old callback
from erasing newly queued replay. Failed callback verification changes neither
subscription nor replay state. Replay remains subject to pause and activation.

## Retention, operator recovery and restoration

There is no event-history pruning in this stage. `truncated: true` currently means
a prior restored database generation; it is not an assertion that Photon
history is complete. Ordinary restarts preserve cursors. Explicit operator
`not_started` resolution creates a new event ID and appends a new sequence so
redispatched work cannot hide behind an older cursor. Other operator cancellations
remain cancelled and cannot be reactivated by a replay request.

Message restoration rotates the cursor generation within the quarantine
transaction. Old cursors cannot skip work based on pre-restore state. Restore
holds, the verified intake boundary and owner reconciliation still apply; replay
does not remove them. Newly restored subscriptions require fresh verification.
The separate Photon checkpoint must also be bound to the new message generation;
see [Photon recovery](photon-recovery.md).

Storage retention/deletion policy, live ChatGPT cursor acceptance and full
production host integration remain gates. The existing finite subscription
lifetime and signing-secret behavior are unchanged. Subscription secret overlap
rotation and background grant-revocation monitoring need separate production
integration review; these cursor tests do not establish those behaviors.

## Verification and source

Local SQLite/service tests cover pending holes, stable IDs, refresh races,
malformed cursors, restart, restoration and repeated claims/replies. A process
test kills the store after claim/callback reservation and confirms replay does
not reacquire the request. No real callback, provider or account is used.

The [official MCP Events contract](https://developers.openai.com/plugins/build/mcp-events)
requires replay cursors that do not skip awaiting delivery, explicit truncation,
stable event IDs and fresh signatures on bounded retries. These requirements were
checked against current documentation on October 25, 2026.
