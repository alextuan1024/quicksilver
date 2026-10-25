# quicksilver V1: Recovery and operations

[Design overview](../design-v1.md) · Design checkpoint: October 23, 2026.

## Recovery and operations

Persist subscriptions across restarts; renew expiry and rotate signing secrets. Retry transient webhook failures with bounded backoff, the same event ID and fresh signatures. Support replay cursors without skipping pending events. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

V1 now requires future-only Photon live reconnection and token renewal. The
October 25 owner decision accepts missed inbound messages during disconnects;
historical catch-up and history-scope verification are deferred, not launch gates.
Requests already persisted retain durable recovery and MCP replay. Never broaden
access to unrelated chats, repeat Athena actions or retry uncertain sends to
compensate for missed inbound messages. [Photon events](https://photon.codes/docs/advanced-kits/imessage/events)

Provide health status, a pause switch, encrypted backups and restore testing. Log operational status and sanitized error categories only, never inbound payloads, reply text, tokens or raw provider errors. SQLite and backups contain private content and require restricted access and a retention policy.


## Local implementation

Persistent pause, sanitized inspection, owner-verified stalled-request resolution,
AES-256-GCM snapshots and non-overwriting restoration are implemented. See the
[operator procedures](../operations.md) for the local service API, offline CLI,
key requirements, restore reconciliation and recovery-gap behavior.

A restore clears stale subscription/grant records and quarantines unfinished
requests and unresolved replies. Resume requires explicit owner review. The
operator-verified reconciliation boundary rejects older native events, including work
absent from the snapshot, rather than guessing which external actions happened.
New response IDs on restored requests remain uncertain until individually reconciled. The pause and boundary survive process death. The existing runtime is unchanged.

Future-only live reconnect/token renewal, hosting, real backup key provisioning,
retention duration/destination and live acceptance testing remain separate gates.
Historical Photon catch-up is optional deferred work.
No replay cursor semantics or provider idempotency guarantee is inferred here.


The bounded local recovery/backup and MCP replay components are implemented.
[MCP replay](../event-replay.md) now uses authenticated durable cursors, conservative
acknowledgment positions, atomic subscription refresh and restored-history
truncation. This does not recover events absent from the message database.

The separate [catch-up controller](../photon-recovery.md) and its fixtures remain
available as optional deferred work. It currently requires scoped history and
contiguous checkpoints; it is not a future-only reconnect implementation. V1 needs
a separate live lifecycle path or an explicit mode that removes mandatory history
and sequence-gap recovery while retaining owner filtering, message-ID deduplication,
bounded renewal/retry, pause and shutdown controls. That production SDK wiring is
still unimplemented. No default runtime or live setting changes accompany this
scope decision. Historical API evidence remains documented for any future catch-up
work, without making its unresolved scope a V1 blocker.
