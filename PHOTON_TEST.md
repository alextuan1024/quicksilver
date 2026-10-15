# Photon one-message connection proof

Scope: one verified owner, one predetermined incoming text and one fixed reply in
that same DM, through the existing Athena dot. The runtime uses a managed Photon
cloud line and does not depend on the owner's Mac Messages account.

Incoming: `Athena connection test.`
Reply: `Athena received your connection test.`

## Verified result — October 15, 2026

The parent conversation observed the following live sequence on deployed commit
`5e1c51173a31d1c7740a21e2e2f22beb39e1da52`:

| UTC time | Evidence |
| --- | --- |
| 17:20:56 | Exact event subscription verified successfully after the new deployment. |
| 17:21:42 | Explicit current-boot arm returned `connecting`. |
| 17:22:10 | Status reported `listening` after observed stream activity. |
| 17:22:46.120 | The fixed owner message arrived as an event in existing Athena. |
| 17:23:16 | One request-bound `reply_photon_test` returned `provider_accepted`. |
| 17:24:11 | The owner directly confirmed receiving the reply in the same DM. |

Together, event receipt, the bound reply result, and owner confirmation prove the
approved two-way fixed-text connection. A callback 2xx, `listening`, or provider
acceptance alone would not have sufficed. Identifiers, personal phone numbers,
credentials, and raw logs are deliberately omitted from this document.

The first attempt earlier that day reached apparent `listening`, then failed
with `transport_error` before any verified inbound event/reply. Its root cause
is still unknown. The prior status was optimistic: local real-SDK fixtures proved
that it could return before the subscription reached a server. Distinct gRPC and
mapping errors also collapsed into that same state. The later successful run is
not proof that a particular upstream fault was fixed.

The successful test window was approved through **2026-10-15 17:45 UTC**. Completion consumed
the reply slot and closed the transport. The parent then disabled the temporary
automation at 17:27:01 UTC and restored the earlier expired **17:10 UTC** cutoff.
A cleanup deployment of the same runtime commit became live at 17:29:20 UTC,
passing 82 tests and the secret scan. The parent verified `mode: disabled`,
`photon: disabled`, and `syntheticOnly: true`. Render Free, the existing connector,
and stored credentials were retained. These operational cleanup actions were
performed separately; the repository wrap-up changes documentation only.
This result record is not authorization to start another session.

## Implemented controls

`photon.mjs` validates exact configured project, owner address, route and DM,
inbound iMessage service, plain text and fresh timestamp. It excludes groups,
echoes, automatic/system/spam/corrupt messages and unsupported multipart content.
The adapter applies corresponding native-message checks before normalization.

The receive slot is reserved before asynchronous callback delivery. The event
`photon.test.received` contains only a random request ID and the fixed text. Its
reply closure privately captures the original DM and incoming message GUID.
`reply_photon_test` accepts only the request ID, never arbitrary text or a target.
The send slot is consumed before the RPC. Uncertain results become
`unknown_outcome` and cannot be retried. `provider_accepted` is not proof of delivery.

The same OAuth-protected `/mcp` exposes `photon_test_status`, `arm_photon_test`, and
`reply_photon_test`. Every request requires the pinned token issuer/audience,
client, owner and scope. Safe discovery/handshake methods are explicitly
allowlisted outside a live window; tool calls and subscription operations are not.
The event callback must pass a signed verification challenge. Public-address DNS
validation, socket pinning, TLS and no redirects limit callback destinations.

Startup is disarmed. Activation requires the current boot ID, approved route,
verified event subscription and a fresh absolute deadline within one hour of
startup. A boot may arm once. Deadline expiry, termination or stop invalidates
pending requests. A restart loses subscriptions and one-shot state; it never
resumes a session automatically. Fresh approval is required before any new boot
is subscribed and armed for another test.

## Transport and diagnostics

The source-reviewed transport is enabled in code, but credentials alone cannot
activate it. `runtime.mjs` prepares it only with valid configuration and a fresh
window; explicit activation remains required. Tests inject dependencies locally;
HTTP, MCP and environment inputs cannot select alternative implementations.

The adapter uses public Spectrum token issuance and the official low-level
`@photon-ai/advanced-imessage/grpc` client. It selects the fixed shared route,
subscribes only to the exact owner DM, and sends through the captured reply target.
No provider-level profile/contact sharing, account changes, chat creation, typing,
read receipts, chat enumeration, reconnect, catch-up, or token renewal is performed.
TLS, `retry:false`, `grpc.enable_retries:0`, stable per-request identifiers, and a
bounded unary timeout are retained. Tokens are never copied into this repository.

Token issuance waits at most five seconds. Token lifetime minus five seconds or
the session cutoff, whichever comes first, closes the stream. The pinned SDK
excludes streaming calls from its unary timeout; local loopback evidence ruled
out that five-second setting as a receive-stream lifetime limit.

Arming returns `connecting` until the SDK observes a heartbeat or decoded event.
Then `listening` describes stream activity, not confirmed owner routing or future
availability. A valid first message can proceed directly to delivery. Activity
alone never bypasses exact message checks. Late activity cannot revive a stopped
attempt. Failure during a send preserves uncertainty even if a late RPC succeeds.

Diagnostics emit only a fixed marker, allowlisted phase/category, numeric gRPC
status or null, elapsed milliseconds, and heartbeat/event-seen booleans. Only the
first heartbeat and first decoded event are logged. No error text, cause, context,
metadata, token, phone/chat/message identifier, or message content is included.
Unknown failures remain explicitly unknown.

## Configuration and future test procedure

Existing runtime keys are `SPECTRUM_PROJECT_SECRET`, `PHOTON_OWNER_ADDRESS`,
`QUICKSILVER_OWNER_SUBJECT`, and `QUICKSILVER_SESSION_EXPIRES_AT`. Preserve verified
bindings; the project and shared route are source-pinned. The owner entered the
project secret directly into Render. Do not request it in chat or store it locally.
The successful filtered event exercised the canonical pinned DM; no unrelated
chats were queried. Never broaden the filter to work around a mismatch.

For any separately approved future bounded test:

1. Review the previous outcome and obtain fresh authorization for the exact
   text/reply and deadline. Do not automatically retry an uncertain attempt.
2. Deploy the reviewed commit with only approved configuration changes. Render
   Save only does not apply pending environment values, and Restart service
   retains the previous deployed environment. A deployment is required.
3. Establish and verify the exact event subscription on the resulting boot.
   During the successful run, a prompt-only automation update did not restore
   the server subscription after reboot; reapplying the exact trigger did.
   An existing automation record is not proof that the current server subscribed.
4. Inspect current boot status and explicitly arm once. Wait for observed stream
   activity before the owner sends the fixed test. Pending connection is not a
   reason to resend or rearm. Subscription setup consumes the absolute window.
5. Require the owner event, its single bound reply result, and recipient
   confirmation. On expiry, restart, or ambiguity, stop and review.

This procedure does not authorize another live run. No deployment or runtime,
credential, permission or cutoff change is part of the documentation wrap-up.

## Limits and future work

The successful deployment passed 82 tests and the secret scan. Local tests use
fixture keys, fake callbacks and loopback RPCs; the live sequence above is separate
evidence. Dependencies are pinned: Spectrum core/provider 12.10.1, direct Photon
SDK 2.2.0. See [SDK_REVIEW.md](SDK_REVIEW.md) before upgrading.

State is in memory with no durable queue/database or persistent disk. Render Free
sleep/restarts can break continuity, and the application intentionally fails
closed. This one fixed-message proof does not establish arbitrary conversation,
multimedia, sustained availability, exactly-once processing across restarts, or
safe automatic recovery. Production work needs durable event/request state,
idempotency/replay policy, subscription reconciliation, monitoring, separately
approved message scope, and an explicit hosting/cost decision. No paid upgrade
has been made by this repository work.
