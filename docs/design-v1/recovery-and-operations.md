# quicksilver V1: Recovery and operations

[Design overview](../design-v1.md) · Design checkpoint: October 23, 2026.

## Recovery and operations

Persist subscriptions across restarts; renew expiry and rotate signing secrets. Retry transient webhook failures with bounded backoff, the same event ID and fresh signatures. Support replay cursors without skipping pending events. [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

Reconnect Photon and recover missed events only after verifying owner-scoped replay for the actual shared line and pinned SDK. Current Photon documentation describes sequence-based catch-up, but compatibility, retention and filtering remain acceptance gates. Never broaden to unrelated chats for recovery. [Photon events](https://photon.codes/docs/advanced-kits/imessage/events)

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

Owner-scoped Photon replay, token renewal, hosting, real backup key provisioning,
retention duration/destination and live acceptance testing remain separate gates.
No replay cursor semantics or provider idempotency guarantee is inferred here.


The bounded local recovery/backup plan is complete; this whole design is not yet
launch-complete. MCP replay cursors remain unimplemented (the bridge rejects
non-null cursors); durable outbox retries do not supply cursor-based replay.
Photon reconnect/catch-up and token-renewal host integration also require future
implementation after their provider assumptions are verified. These are distinct
from external decisions and authorized live acceptance tests.
