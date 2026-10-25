# quicksilver V1: Message handling and state

[Design overview](../design-v1.md) · Design checkpoint: October 23, 2026.

## Message handling

1. Accept only plain text from the verified owner’s exact Photon DM. Reject groups, echoes, media and unsupported events.

2. Atomically deduplicate and persist the inbound request, provider checkpoint and event-outbox entry.

3. Deliver a signed MCP event with a stable request ID. Athena claims the request through an authenticated tool and reads its text. Duplicate claims must not restart already-claimed work.

4. Athena uses its existing context and tools. Gmail, calendar and feeding-log examples remain Athena tasks, not backend modules.

5. Store each progress or final response in the reply outbox. The reply tool takes request ID, response ID, text and final status, never an arbitrary recipient. A final response closes the request.

Persistent records cover OAuth grants, subscriptions/signing material, requests/checkpoints, event outbox and reply outbox. Serialize initial request handling; delayed results stay tied to their originating request.

## State and failure rules

Request execution: persisted/pending → claimed → completed. Event delivery is independent: pending → in flight → acknowledged, with bounded retries or a visible stall. A claim can arrive before the webhook acknowledgment; a late acknowledgment never moves execution backward. A webhook acknowledgment means receipt, not Athena completion.

A final reply closes response admission atomically when queued. Previously queued progress replies remain ahead of it. Execution completion and reply delivery are separate: a completed request can still have queued or uncertain replies. A failed or uncertain operation carries a visible stall reason without reopening the request or repeating Athena actions.

Reply: queued → send attempted → provider accepted, or unknown outcome. Persist the attempt before the provider call. Repeated response IDs return the existing outcome. Provider acceptance is not proof of recipient delivery.

After a timeout or crash around sending, reconcile using a stable provider identifier and verified lookup/idempotency semantics. If the outcome cannot be established, require owner verification before another send. Never blindly resend or automatically rerun uncertain Athena actions. No exactly-once guarantee is claimed.


## Implemented message component

The optional `createService({ ...config, messageHandling })` path implements this design using `message-store.mjs`, `messages.mjs` and `message-service.mjs`. It is not selected by the deployed `runtime.mjs`; implementing this component does not activate the Photon line. See the [integration contract](../../README.md#durable-message-component) for composition.

- SQLite transactions serialize inbound admission and claims. The provider message ID deduplicates inbound work; each accepted request retains its opaque provider checkpoint. These records are not a verified replay watermark, and out-of-order arrivals never advance a guessed high-water cursor.
- An exclusive SQLite lock enforces one owning process and releases on process death. The database identity pins the project, line, DM, owner, OAuth issuer, subject and client. Files are created with owner-only permissions; deployments must use a private persistent directory.
- `claim_message(request_id)` returns text only on the first successful claim, with `acquired: true`. Duplicate claims return `acquired: false` without text. Athena must never restart work on a duplicate. After restart, unfinished claims are marked `processing_interrupted`; a late result from that original work can still be queued.
- `reply_message(request_id, response_id, text, final)` admits only claimed requests. Reusing an ID with identical content returns the existing outcome; different content or final status is a conflict. New replies after final closure are rejected. IDs are scoped to the originating request.
- Reply attempts commit before calling Photon. Each reply has a durable client message ID, and only the earliest unresolved reply per request can send. An unknown progress send blocks that request's final reply while other requests can proceed.
- Callback attempts use one stable event ID and original event timestamp with fresh webhook signatures. Failures retry at 1, 2, 4 and 8 seconds, then stall after five attempts. No active subscription leaves the event pending without spending an attempt. Subscription expiry and signing material survive restart; renewal still requires callback verification.
- An unknown send remains unknown after restart, lookup failure or a not-found result. A trusted lookup adapter may mark acceptance only when it has verified semantics and returns the matching client message ID. The local operator API requires explicit owner verification to mark a reply sent or permit another attempt; Athena has no reconciliation or resend tool.
- `message_status` returns request IDs and sanitized execution, event and reply states, without text or credentials. Input and reply text are limited to 8,192 UTF-8 bytes. No second AI or task-specific Gmail/calendar code is introduced.

## Integration boundaries

The Auth0 composition remains available with a separate `quicksilver:messages`
scope; `quicksilver:probe` cannot claim or reply to general messages. The merged
[local OAuth composition](../local-oauth.md) now supplies an alternative resource
gate with grants in a separate private SQLite database. Both retain the one-hour
activation ceiling. `runtime.mjs` still selects the original Auth0 proof path;
production wiring and any Auth0-to-Google stored-identity migration remain work.

The host must supply a trusted Photon SDK client for the pinned line, configured with automatic retries disabled, and forward native events from the exact owner-scoped subscription. This component neither connects nor broadens subscriptions. It provides no replay, token renewal or inferred send-idempotency guarantees. Persistent pause and safe backup/restore are implemented in the [operations component](../operations.md). Verified replay, retention, key provisioning and live launch decisions remain gates. A restored database stays paused until explicit external reconciliation is recorded; its intake boundary prevents automatic replay of the uncertain interval.
