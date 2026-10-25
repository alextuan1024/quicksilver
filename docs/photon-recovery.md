# Scoped recovery controller and Photon adapter gap

## V1 scope decision — October 25, 2026

Historical Photon catch-up is deferred. The owner accepts that inbound messages
sent during disconnects may be missed. Verifying historical access scope or
retention is no longer a V1 launch blocker. Basic **future-only** live reconnection
and session/token renewal remain in V1 so new messages resume afterward; actual
[SDK/host wiring](photon-live.md) is now implemented in a separate live path and
fixture-tested; real-provider acceptance and deployment remain outstanding.

The existing controller, checkpoint store and catch-up fixtures are retained as
optional deferred work. Their tests prove the stricter historical-recovery
contract described below, not a completed future-only adapter. Durable handling
and MCP replay for requests already persisted remain required. Accepting missed
inbound messages never permits repeating Athena actions or retrying uncertain
outbound sends. No provider history was read or token issued; the default runtime
and original proof transport remain unchanged.

## Future-only reconnect design coupling

The current `photon-recovery.mjs` cannot be used unchanged for this reduced scope:

- Construction requires the `contiguous-owner-text` contract and checkpoint store.
  Intake accepts only checkpoint + 1 and stalls on missing sequences. A live
  stream starting after downtime may legitimately have gaps under the new policy.
- Every `adapter.open` is followed by mandatory `session.catchUp`, including after
  reconnect or token rotation. Listening requires a history completion marker.
  No future-only switch exists; the retained composition example below is for the
  optional catch-up path only.
- A future implementation must separate the live connection/renewal lifecycle
  from history traversal, checkpoint completeness and gap deadlines. It should
  use the exact owner-DM live subscription, persist admitted messages through the
  existing service, and retain message-ID deduplication, pause/expiry checks,
  generation fencing, bounded retries and shutdown cancellation.
- Missing offline messages must be an explicit accepted limitation, never hidden
  with invented sequence numbers, fabricated empty catch-up completion, or an
  advanced checkpoint. Keep uncertain outbound replies and existing Athena claims
  under their current recovery rules. No catch-up checkpoint is needed to promise
  future-only intake; message restore holds and verified intake boundaries still apply.

This catch-up controller remains unchanged. The subsequent [live implementation](photon-live.md)
uses a separate controller with no history/contiguous-checkpoint requirement, plus
SDK token mint/rebind and host composition. Fixtures cover new messages after an
interruption; real-provider acceptance remains outstanding.

## Deferred catch-up evidence — October 25, 2026

Inspected installed `@photon-ai/advanced-imessage` 2.2.0 and
`@spectrum-ts/core` / `@spectrum-ts/imessage` 12.10.1, plus current official docs:

- [`Events`](https://photon.codes/docs/advanced-kits/imessage/events): durable events
  have increasing sequences. Open live streams concurrently with catch-up,
  deduplicate overlap, and advance only after every earlier sequence has completed.
  `catchup.complete.headSequence` is not permission to advance the checkpoint.
- Pinned `dist/grpc.d.ts` exposes `messages.subscribeEvents({chat})`, but
  `events.catchUp(since?: number)` has **no chat filter**. In
  `dist/client-UZMHAKPA.js`, `EventsResource.catchUp` sends only `{afterSequence}`.
  The generated `CatchUpEventsRequest` in `dist/chunk-5WYZRCOS.js` also contains
  only `afterSequence`; there is no hidden server-side chat field in this contract.
- Pinned event types describe `sequence` as per-line. Filtering a shared-line
  stream does not turn that sequence into a contiguous owner-only checkpoint.
  The inspected contract does not establish whether shared-token authorization
  already restricts catch-up to an account/project, line, or owner. Cross-user
  visibility is therefore **unresolved, not demonstrated**. Reading potentially
  broader history and discarding other chats afterward is not an authorized
  method for resolving that uncertainty.
- [`Chat scope`](https://photon.codes/docs/advanced-kits/imessage/chats#scope)
  documents a live chat filter, not filtered history. The inspected official
  events, chats and connection/routing pages establish no isolated owner-only
  replay/token option. This is a bounded evidence gap, not proof that the provider
  could never offer such a capability.
- The pinned `grpc.d.ts` comment says to catch up before reopening live streams;
  current events docs explicitly require concurrent streams to avoid a handover
  gap. The controller follows the current guidance. Spectrum's installed wrapper
  also calls raw catch-up and maps completion head into a cursor; it is not used.
- [`Connection and routing`](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)
  documents automatic cloud-token renewal at 80% TTL and application ownership of
  explicit-client token renewal. The pinned core `cloud.issueImessageTokens`
  issues credentials with `expiresIn`; advanced client `token` accepts a string
  or async per-RPC supplier. Streaming calls are not automatically retried
  ([error handling](https://photon.codes/docs/advanced-kits/imessage/error-handling)).
  Renewing an RPC token alone does not establish safe shared-line replay.

If historical catch-up is resumed later, closing its production adapter gap
requires an official server-side owner/conversation replay capability, or a separately verified isolated owner-only transport with
precise sequence/retention semantics. Then implement and review its adapter,
including actual token mint/rebinding, cancellation, stream heartbeats, expiry,
truncation and live/history overlap. A dedicated line alone is not evidence of
owner-only history. Provisioning and live verification require separate approval.

## Retained optional catch-up contract

`openPhotonRecoveryStore({path, identity, messageStoreId})` stores a contiguous
checkpoint and SHA-256 receipt fingerprints in a private SQLite file, using
FULL synchronous WAL transactions and an exclusive process lock. `identity`
contains project, line, owner address, exact DM, OAuth issuer, client and subject.
`messageStoreId` is the message database's durable recovery epoch; it changes on
restoration. Reopening a checkpoint with another identity/epoch fails.

`createPhotonRecovery({route, store, adapter, receive, isActive, expiresAt})`
returns `start()`, `status()` and asynchronous `stop()`. Construction never opens
an adapter. `start()` launches the bounded background loop; it is one-shot.
Status contains only fixed state/reason and a numeric checkpoint, no message text,
provider error, address or token. After pause, expiry or a permanent stall, review
and stop the old controller before explicitly constructing another.

The **trusted, separately verified adapter** must declare:

```js
const contract = {
  version: 1,
  verified: true,
  scope: 'owner-text-dm',
  sequence: 'contiguous-owner-text',
  route: {projectId, ownerAddress, line, dm},
};
```

These fields are a host contract, not provider evidence or a remotely selectable
switch. They must never be supplied from HTTP/MCP input. Raw SDK clients are
rejected before any connection. The sequence is a durable, contiguous ledger of
eligible owner text starting at 1, stable across live/catch-up and renewal. It is
**not** the raw SDK's per-line sequence. Do not relabel or renumber a filtered
broad history to manufacture this contract.

`adapter.open({route, after, signal})` must acquire a fresh bounded credential
session and start its exact owner-scoped live stream before resolving:

```js
{
  expiresAt, // absolute epoch milliseconds for this credential session
  live,      // one async iterable of native owner message events plus sequence
  catchUp({after, signal}) { return history; },
  close() { /* cancel and close both streams/client; idempotent */ },
}
```

History returns the same native events as live, then an explicit
`{type: 'catchup.complete', headSequence, truncated: false}`. Missing history,
truncation, conflicting duplicate sequences, unsafe frames, or uncommitted
prefixes stop processing. Optional `{type:'heartbeat'}` frames keep a quiet live
stream responsive without changing its checkpoint. An adapter must honor aborts
and bound any internal buffering before the controller consumes the streams.

The controller buffers at most 128 out-of-order events by default (trusted
`maxBuffered` may be 1–1024), processes only checkpoint + 1, and fingerprints
committed receipts to detect conflicts. A missing-sequence deadline (default
`operationTimeoutMs`, 10 seconds; trusted `gapTimeoutMs` may be 1–60000 ms) runs
independently of heartbeats and later events; expiration stalls without skipping
the gap. Completion heads never set checkpoints.
`receive(event, String(sequence))` must synchronously commit the existing message
store and return `{accepted:true}`; rejection, exceptions or a Promise stall the
controller without advancing. The ordinary owner/text filter runs again before
intake. This component has no send/retry API and cannot authorize a reply.

A crash after message commit but before checkpoint commit deliberately replays
that event. Message-ID deduplication and existing claim semantics prevent a
second external action; uncertain sends remain uncertain. The two databases are
not claimed to be one transaction. Receipt retention is currently unbounded;
choose a reviewed retention protocol before deleting checkpoint/deduplication data.

Each acquisition/stream read/close has a default 10-second deadline. Idle live
streams therefore need adapter heartbeats. Session rotation starts at 80% of its
remaining lifetime by closing the prior generation and calling `open` again from
the committed checkpoint. Four retries use 1/2/4/8-second delays; exhaustion
stalls. The adapter performs the actual token acquisition; only this lifecycle
is implemented locally. Every event also checks session expiry, activation and
generation, so a delayed timer cannot admit data after token expiry. Stale or
late authentication results are closed and cannot reopen intake. Abort signals
and deadlines bound local waiting even if an adapter fails to settle.

`expiresAt` is a positive absolute activation deadline no more than one hour
away. `isActive` must include message-service pause/stop/expiry. A 100 ms activity
poll retires an active session after pause; each event checks synchronously too.
Neither renewal nor reconnect extends activation or resumes a paused service.
The controller does not own or close the caller's message/checkpoint stores.

## Optional catch-up composition and restore

For an already-created durable message service, use its live identity and gate:

```js
const {identity, messageStoreId} = service.recoveryIdentity();
const checkpoint = openPhotonRecoveryStore({
  path: '/private/persistent/quicksilver/photon-checkpoint.sqlite',
  identity, messageStoreId,
});
const recovery = createPhotonRecovery({
  route: verifiedOwnerRoute,
  store: checkpoint,
  adapter: verifiedScopedAdapter, // not supplied by this repository
  receive: (event, cursor) => service.receive(event, cursor),
  isActive: () => service.recoveryActive(),
  expiresAt: approvedActivationDeadlineMs,
});
// Explicit trusted start only after the adapter's actual guarantees are verified.
// recovery.start();
// Shutdown: await recovery.stop(); checkpoint.close(); await service.stop();
```

These checkpoint requirements apply to the retained optional catch-up path, not
a future-only V1 history requirement. Never restore a checkpoint snapshot or bypass
an epoch mismatch. A restored message store has a new epoch and remains held behind its existing recovery
boundary. A fresh checkpoint starts at zero; if retained history includes old
uncertain events, ingestion rejects them and recovery stalls. Establishing a
reviewed new scoped ledger/boundary after restoration is still adapter/operator
work; do not bootstrap to a high sequence, infer a watermark from event time, or
skip history to make the channel run. OAuth recovery still requires a fresh
OAuth database and owner reconnection as described in [operations](operations.md).

## Verification limits

Local tests cover ordered overlap, duplicate/conflicting receipts, missing and
truncated history, owner rejection, bounded buffering, store identity/exclusivity,
receive/checkpoint failures, finite reconnect retries, renewal, pause/expiry and
late-result fencing. A child process is killed after committing a message,
claim and send reservation but before checkpoint commit: restart replays without
repeating the claim or resending the unknown reply. No live credentials,
provider reads or messages are used. These results validate the controller's
contract; they do not complete the missing production Photon catch-up adapter or prove
Google, Photon or ChatGPT live acceptance.
