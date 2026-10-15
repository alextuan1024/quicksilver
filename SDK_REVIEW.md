# Photon direct-client review — updated 2026-10-15

The independently reviewed official lower-level gRPC adapter completed one live
fixed-text round trip on October 15, including owner-confirmed receipt. See
[PHOTON_TEST.md](PHOTON_TEST.md) for the evidence and limits. Any further test
requires fresh authorization and a bounded window. No vendor patch or account
setting change was needed for this path.

## Exact retry evidence

Installed `@photon-ai/advanced-imessage` 2.2.0, `nice-grpc` 2.1.17,
`nice-grpc-common` 2.0.4 and `@grpc/grpc-js` 1.14.6 (all lockfile-pinned):
`dist/client-UZMHAKPA.js` `retryMiddleware` (around line 1523) skips request/response
streams. For unary calls it catches errors and retries only when error metadata
contains `x-retryable` exactly `true`, attempts remain, and cancellation has not
stopped it. Defaults in `dist/chunk-5WYZRCOS.js` are four total attempts, 200 ms
initial/full-jitter exponential delay, maximum 5000 ms. It does NOT classify a
bare timeout/UNAVAILABLE as safely pre-send. It does not inspect execution phase.
Server-marked transient/pre-send rejections can be legitimate safe retries; do
not equate them with duplicate messages. Server-side execution semantics and
idempotency retention are not proved by the client source.

The official README says automatic idempotency keys are reused across attempts.
We found a relevant implementation discrepancy in the pinned dependency graph:
`nice-grpc` applies the most recently added middleware outermost. In this SDK,
trailer capture is registered after retry, so the nice-grpc ClientError receives
trailer metadata only after the inner retry layer has already rejected it.

`photon-retry.test.mjs` calls the REAL installed public `createGrpcClient` against
an ephemeral loopback gRPC server. Results (no Photon traffic):

| Scenario | Observed server requests | Surfaced retryable |
| --- | ---: | --- |
| Retry configured for 4, server returns UNAVAILABLE + x-retryable:true trailer | 1 | true |
| retry:true, unmarked UNAVAILABLE after fake handler entry | 1 | false |
| retry:false, marked retryable trailer | 1 | true |

These observations are deliberately version-specific, not a promise that all
error paths never retry. The one-attempt sample cannot verify key reuse across
multiple attempts. Do not silently 'fix' middleware ordering: that could alter
retry/idempotency behavior. The replacement sets `retry:false` and
`grpc.enable_retries:0` explicitly, rather than relying on this apparent ordering
bug. The latter also disables gRPC's transport retry mechanism. Transparent
retries which are provably before server processing are not evidence of duplicate
execution; disabling them is a conservative strict-attempt test choice.

The fake handler can be entered before an unmarked failure, representing an
ambiguous outcome; our wrapper consumes its outbound slot before await and never
tries again even when a provider result is unknown. Stable `clientMessageId` and
auto-idempotency are additional safeguards, not evidence of exactly-once delivery.

## Automatic contact-sharing trigger

Spectrum provider 12.10.1 `dist/index.js`:
- `toMessageItem`, around 2453: on `message.received` and `message.isFromMe` false,
  map messages, take the first chat GUID, invoke `onInbound`, then return values.
- `messages$1`, around 2618: create a tracker/callback when the project profile's
  `imessageSynced` flag is true or a profile gate exists.
- `registerProfileSyncGate`, around 2815: gates use the initial flag and refresh
  through `cloud.getProject`; refresh TTL 60 seconds, failure retry 30 seconds.
- `shareWhenProfileSynced` calls tracker only if the gate returns true.
- `ContactShareTracker.maybeShare`, around 2054: eagerly dedupe each chat for 24h,
  invoke `chats.shareContactInfo` asynchronously; ordinary failures evict the
  dedupe entry (allowing a later inbound retry), precondition failures retain it.

Thus merely having a profile gate is not itself a share: the flag must be true.
The callback precedes this application's exact-owner filter. It can be avoided
without changing that account flag by not creating Spectrum's provider at all.
Our replacement uses the official direct client; neither it nor our wrapper
invokes the explicit `chats.shareContactInfo` API. Test fixtures expose only
`messages.subscribeEvents`, `messages.sendText`, and `close`, so accidental extra
application calls fail rather than silently passing tests.

## Supported token and endpoint path

Use exported `cloud.issueImessageTokens(PROJECT_ID, projectSecret)` from
`@spectrum-ts/core`; its shipped source authenticates POST
`https://spectrum.photon.codes/projects/{id}/imessage/tokens` with the project
credentials. No invented account endpoint. Reject noncanonical cloud-origin
environment overrides before importing that helper. The successful bounded live
run exercised this token path; local/CI tests continue to use fixtures only.

Source `createCloudClients` in the original Spectrum provider maps shared tokens
to `imessage.spectrum.photon.codes:443` and route sentinel `shared`; dedicated
responses provide `auth` and `numbers` keyed by instance, using
`{instance}.imsg.photon.codes:443`. Our `selectLine` preserves those mappings but
chooses only one explicitly configured route and rejects ambiguity. It neither
provisions nor purchases a line. It never auto-refreshes a token or changes
permissions; it stops before expiry. The successful live run exercised the exact
filtered subscription and single fixed send for the existing project. That does
not establish broader token permissions or other routes. The dashboard mapping
was checked separately; `shared` is a routing sentinel, not independent phone
verification.

## Stream readiness and first-failure investigation

The pinned SDK loads its gRPC implementation lazily. Returning an async stream
is not confirmation that a server accepted the subscription. Loopback tests
reproduced the former optimistic listening status before the server received any
request. UNAUTHENTICATED, NOT_FOUND, INVALID_ARGUMENT, UNAVAILABLE and malformed
frames could all lead to the same transport_error. The first live failure cannot
be assigned one of those causes from the retained evidence.

The adapter now starts at connecting and reports listening only after observed
heartbeat/event activity. The public onHeartbeat callback was verified with the
real SDK on loopback. Numeric gRPC status is mapped to a fixed diagnostic category;
raw SDK errors and metadata are discarded. No automatic retry/recovery was added.

The SDK timeout middleware skips streaming RPCs. A loopback subscription remained
open past 5,300 ms with timeout:5000, an infinite server-side RPC deadline, and a
received heartbeat. Increasing the unary timeout was not a justified fix.

## Maintenance and license

Both upstream repositories publish MIT-licensed SDKs. This change imports their
public APIs and redistributes no modified vendor code. Existing package licenses
remain in the dependency distributions; no source patch/rebase burden is added.
Exact package versions/lockfile are retained. Re-audit token response shape,
endpoint mapping, message normalization, retry flags and stream semantics before
upgrading. The source-level enablement was independently reviewed; preserve all
owner/DM/request, deadline and explicit-activation guards through future changes. No new durable store, security permission or paid feature is needed for
this stop-on-failure test; production durability remains out of scope.

Official sources:
- https://photon.codes/docs/advanced-kits/imessage/getting-started
- https://photon.codes/docs/advanced-kits/imessage/error-handling
- https://github.com/photon-hq/advanced-imessage-ts
- https://github.com/photon-hq/spectrum-ts
- https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing
