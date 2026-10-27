# Future-only Photon transport

The real SDK adapter in `photon-live-adapter.mjs` opens only the configured owner's
exact live message subscription. It does not call catch-up, list history, subscribe
to other chats, or infer that missed messages were recovered. The lifecycle host
uses this adapter only through explicit trusted composition; the deployed proof
runtime is unchanged. Historical catch-up remains deferred.

## Provider contract and implementation

The pinned packages remain `@photon-ai/advanced-imessage` 2.2.0 and
`@spectrum-ts/core` / `@spectrum-ts/imessage` 12.10.1. The default loader uses
`cloud.issueImessageTokens(projectId, projectSecret)` and `createGrpcClient` from
`@photon-ai/advanced-imessage/grpc`; it does not construct a Spectrum provider or
its broader automatically discovered subscriptions.

`createPhotonLiveAdapter({route, projectSecret})` pins project, line, owner address
and canonical `any;-;<owner>` DM. `open({signal, isActive, onActivity})` acquires a
fresh credential session and returns `{expiresAt, live, sendText, close}`. The
client uses TLS, SDK retries disabled, gRPC retries disabled and a bounded unary
timeout. The only stream request is `messages.subscribeEvents({chat: route.dm})`.
Shared mode uses the official shared gateway; dedicated mode must select exactly
the configured number and its validated official instance hostname. A token
response with a different or ambiguous route fails closed.

The default token helper is guarded against a nonofficial `SPECTRUM_CLOUD_URL`
override. Keep that process-level setting unset or fixed to
`https://spectrum.photon.codes` before importing any Spectrum module; changing
SDK environment settings inside a running host is unsupported. Credentials and
tokens remain in memory and are never written by this adapter.

`expiresAt` is a conservative usable deadline: token request start plus the
returned `expiresIn`, less five seconds. Each event/send checks that deadline and
`isActive` independently of scheduled rotation. The lifecycle controller owns
renewal by requesting a new session before expiry; renewal never extends the
message activation window.

`sendText` accepts only the pinned DM, bounded nonempty text, stable `replyTo` and
`clientMessageId`, and explicit `enableLinkPreview:false` /
`enableDataDetection:false`. Extra send options are rejected. It returns only a
provider message GUID. This is a trusted transport method: the durable message
service must establish the request/reply relationship and reserve the send first.
It is not an HTTP/MCP arbitrary-send endpoint. SDK and host send retries remain
disabled; a timeout or cancellation after reservation is an unknown outcome.

Closing a session invalidates it immediately, aborts local waits, closes its SDK
stream and both gRPC channels, and fences late results. A pending send rejects
even if its provider result arrives later. The default acquisition/send/close
wait limit is five seconds (trusted `operationTimeoutMs` can shorten it).

**SDK limitation:** the pinned public `cloud.issueImessageTokens` helper does not
accept an AbortSignal. Aborting or timing out bounds local waiting and discards
its late result, but cannot cancel that already-issued HTTP request through the
public helper. It cannot open a client after cancellation. gRPC stream/unary
operations are cancelled by closing the SDK channels. No guarantee is made that
cancelling a send undoes an external provider operation.

Only fixed errors escape the adapter: `photon_auth_failed` for HTTP 401/403 or
gRPC permission/authentication failures, `photon_scope_failed` for route/config
violations, `photon_transport_failed` for other transport failures, and
`photon_inactive` after pause/stop/expiry. No raw provider error, token, message
content or route identifier is logged. SDK logging is silenced by the loader.

## Official evidence and live limits

Read-only inspection on October 25, 2026 used the installed SDK source and:

- [Photon events](https://photon.codes/docs/advanced-kits/imessage/events): exact
  chat live subscription examples, one consumer per stream and stream closing.
- [Connection and routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing):
  explicit clients require application-managed token renewal; automatic cloud
  discovery renews at 80% TTL and may discover additional project lines. This
  adapter does not use automatic discovery.
- [Error handling](https://photon.codes/docs/advanced-kits/imessage/error-handling):
  streaming requests are not automatically retried; write idempotency describes
  stable client message IDs but does not justify retrying uncertain local sends.

The SDK's live request serializes `chatGuid`. Its historical `catchUp` request
only serializes `afterSequence`. Historical visibility under shared-token
authorization remains unresolved, not demonstrated cross-user access. The
future-only adapter does not use that API or attempt to resolve scope uncertainty
by fetching broad history. See [scoped recovery evidence](photon-recovery.md).

## Local adapter verification

Tests run the actual pinned gRPC client against a loopback fixture server. They
verify exact-chat subscription bytes, bearer metadata, stable reply ID/target
bytes, disabled retries despite retryable trailers, heartbeat observation,
authentication failure categories and cancellation of an in-flight send. An
isolated child replaces only `fetch` with a local fixture to exercise the actual
cloud helper's official URL, POST request and Basic-auth construction. Another
child rejects a nonofficial origin before credential exchange. No real Photon
credential, network history read or iMessage is involved.

These tests validate SDK integration locally. Provider-side live filtering,
credential renewal on the actual project/line, recipient delivery and behavior
during real interruptions remain explicitly authorized live acceptance work.

## Explicit local host composition

`createPhotonMessageHost(config)` composes the live SDK adapter/controller with
local OAuth and durable messages. It does not bind a listener or connect on
construction. All values below come from trusted host configuration, never an
HTTP/MCP argument or an automatic environment-variable switch:

```js
import {createPhotonMessageHost} from './photon-message-host.mjs';

const host = await createPhotonMessageHost({
  localOAuth: verifiedLocalOAuthConfig,
  expiresAt: approvedActivationDeadline, // ISO timestamp, at most one hour ahead
  photon: verifiedOwnerRoute, // projectId, ownerAddress, exact dm, line
  photonProjectSecret: provisionedProjectSecret,
  messageHandling: {
    databasePath: '/private/persistent/quicksilver/messages.sqlite',
    workerIntervalMs: 1000,
    sendTimeoutMs: 5000,
  },
});
// Mount host.handle on the trusted HTTPS/proxy listener from the OAuth contract.
// Explicit authorized startup only:
// host.start();
// Stop the HTTP listener, then await host.close().
```

The host exposes `messages`, `gate`, `handle`, `revokeGrant`, `start`,
`transportStatus` and `close`. Transport status contains only fixed state/reason
categories. `subscribing` means a stream was created; `listening` requires an
observed heartbeat or event and does not prove recipient delivery. The SDK adapter
requests server-side exact-DM filtering, and the controller rechecks the strict
owner/plain-text predicate before synchronous durable intake. Unsupported frames
are ignored. Any storage rejection/error stalls intake without replaying it.
Native sequence gaps are ignored; native message IDs still deduplicate admission.

The controller retries transient connection/stream failures at 1/2/4/8 seconds
with a finite per-controller budget. Auth/permission or route failures stop for
operator review. A 60-second inactivity watchdog resets on heartbeat/event
activity; a silent stream retires and retries. Credentials rotate at 80% of the
remaining conservative session lifetime. Closing the old generation before opening
the new one can miss inbound events, as accepted for V1. Renewal never extends
activation, resumes a pause or restarts a stopped host. A paused, expired or
permanently stalled host requires explicit operator review and new construction.

The message worker checks transport readiness before reserving a queued reply.
Once reserved, a send captures one session and is never redirected/retried on a
replacement. A disconnect, timeout or credential retirement can leave its outcome
unknown; existing reconciliation controls apply. Process tests kill the controller
after admission/claim/send reservation and verify that a restarted store cannot
reclaim the action or resend the uncertain reply. Integration tests exercise OAuth
claims/replies, reconnect duplicates and host restarts with durable SQLite state.

Trusted fixture seams are `photonLive.sdkLoader`, `photonLive.operationTimeoutMs`
and `photonLive.controller` timing/retry options. These are not exposed by the
production HTTP/MCP surface. The default `server.mjs`, `runtime.mjs` and original
proof transport are unchanged. Production HTTP/TLS/storage/secret configuration,
activation policy and real Google/Photon/ChatGPT acceptance remain separate gates.


## Completion evidence — October 25, 2026

The full local suite passed **200/200** on Node 22.23.4 (supported floor and current
Node 22 selection). Independent final review passed **41/41** targeted tests and
reported no actionable findings. Full/production audits found zero known
vulnerabilities; dependency-tree, secret and documentation checks passed. These
are fixture/loopback results, not live-provider or ChatGPT acceptance.


## Production listener

The [production entry point](production-host.md) now supplies private configuration,
HTTPS or loopback proxy listening and signal-driven host shutdown. Deployment
selection, real secrets and live acceptance remain separate gates. Activation
requires an explicit flag and fixed deadline; the one-hour limit remains.
