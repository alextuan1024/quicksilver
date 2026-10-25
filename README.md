# Quicksilver

A bounded Photon iMessage ↔ existing Athena connection proof, hosted on Render
Free independently of the owner's Mac. No separate LLM bot or general send tool.

## Verified result — October 15, 2026

One complete fixed-text round trip succeeded: the owner's iMessage reached the
existing Athena through an authenticated MCP Events subscription; Athena invoked
one request-bound reply; the owner confirmed receiving that reply in the same DM.
The successful deployed implementation is commit
[`5e1c511`](https://github.com/alextuan1024/quicksilver/commit/5e1c51173a31d1c7740a21e2e2f22beb39e1da52).
The evidence is the parent conversation's event/tool trace and direct owner
confirmation, distinct from the local fixture tests. See [PHOTON_TEST.md](PHOTON_TEST.md)
for the UTC timeline, boundaries, and operating notes.

This proves the single approved text/reply route and existing-Athena continuity.
It does **not** prove arbitrary conversation, unattended operation, durable
recovery, general media support, or production reliability. The first live attempt
failed with `transport_error`; its precise cause remains unknown. Later diagnostics
and truthful status improved observability but do not establish what caused it.

The completed attempt consumed its single reply and closed its transport. During
cleanup, the parent disabled the temporary automation and restored the expired
**2026-10-15 17:10 UTC** cutoff. The same runtime commit was redeployed at
17:29:20 UTC; the parent verified health reported `mode: disabled`,
`photon: disabled`, and `syntheticOnly: true`. The connector and credentials were
preserved on Render Free. No activation follows a restart automatically, and a
future live test requires fresh explicit approval. This docs-only update does not
deploy or change configuration.

## Connection and controls

The path is Photon managed iMessage → strict one-owner transport → authenticated
relay → signed MCP event → existing Athena → request-bound reply → original DM.
State is deliberately in memory; this prototype does not implement a durable relay.

- Auth0 RS256/RFC 9068 tokens must match the pinned issuer, audience, client,
  verified owner, scope, and bounded token-lifetime policy.
- Only valid authenticated discovery/handshake requests work outside a test
  window. Every tool call and subscription operation still requires the window.
- The transport requires a verified subscription, current boot ID, configured
  owner route, and explicit one-time activation. Startup alone never connects.
- Both adapter and controller enforce the exact owner/chat/text and reject
  groups, echoes, attachments and unsupported message types.
- Only one fixed reply to the captured request is permitted. Ambiguous results
  consume the attempt; no automatic retries, reconnects, catch-up, or rearming.
- `connecting` means pending. `listening` requires observed heartbeat/event
  activity; it does not prove recipient delivery. Only the received owner event
  permits a reply. `provider_accepted` also needs recipient confirmation.
- Transport logs contain only fixed phase/category, allowlisted numeric gRPC
  status, elapsed time, and activity booleans. No raw provider errors, message
  content, credentials, metadata, or phone/chat/message identifiers are logged.

The public SDK adapter uses the managed cloud path, exact chat subscription,
TLS, disabled retry layers, and a bounded unary timeout. It avoids Spectrum's
provider-level contact-sharing callback. [SDK_REVIEW.md](SDK_REVIEW.md) records
version-specific findings; do not assume them for other SDK versions.

## Validation and local operation

Target runtime: Node 22.13 or newer within Node 22 (built-in SQLite). The successful deployment passed **82 tests and the
secret-pattern scan**. Tests cover OAuth/discovery, signed callbacks, owner and
message filtering, lifecycle/expiry, single-attempt behavior, diagnostics, and
real SDK calls to loopback gRPC fixtures. CI uses fixture keys and injected
transports; it does not contact Photon with real credentials or send iMessages.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test
node scan.mjs
node server.mjs
```

The existing Render Free service uses those install/test/scan commands, starts
`node server.mjs`, and exposes `/healthz`. Auto-deploy is off; no persistent disk
or database is configured. A docs-only push is not a deployment. No secrets
belong in this repository. Local evidence and dependencies remain ignored.

`/proof` is denied. The optional synthetic proof uses its owner-gated MCP tool,
a verified callback, and its own one-shot nonce acknowledgment. It is separate
from the now-proven live iMessage round trip.

## Durable message component

The V1 [message-handling design](docs/design-v1/message-handling.md) now has a
local implementation. The existing server/runtime still selects the parked
fixed-text proof; no environment variable activates the new component.

A trusted host can compose the message path through `createService`:

```js
import { createService } from './service.mjs';

const service = createService({
  ...ownerOAuthConfig, // issuer, resource, clientId, ownerSubject, expiresAt
  photon: verifiedRoute, // projectId, ownerAddress, line, exact canonical dm
  messageHandling: {
    databasePath: '/private/persistent/quicksilver/messages.sqlite',
    provider: photonClient, // trusted client for this line; automatic retries OFF
    workerIntervalMs: 1000,
    sendTimeoutMs: 5000,
  },
});

// Forward authenticated HTTP/MCP requests through service.handle(...).
// Forward native events only from the verified owner-scoped SDK subscription:
service.receive(nativePhotonEvent, opaqueProviderCheckpoint ?? null);
// service.flush() drains a bounded batch; the worker also runs every second.
// On shutdown, stop the host's subscription/client and await service.stop().
```

This is a composition example; the host supplies the named values and owns
transport startup, authentication configuration and shutdown. `receive` is a
trusted in-process method, not an HTTP ingestion endpoint. Never advance a
provider cursor after a persistence error. Provider checkpoint semantics still
require verification before adding replay.

The MCP tools are `claim_message`, `reply_message` and `message_status`, protected
by the pinned OAuth owner/client and `quicksilver:messages` scope. Only a first
claim returns text with `acquired: true`. Reuse response IDs for retries. Final
replies close admission when queued; progress and final sends remain ordered.
Timeouts and interrupted sends remain visible as unknown and never resend
automatically. Provider acceptance is not proof of recipient delivery.

For verified provider lookup, the trusted host may supply
`messageHandling.lookup = { verified: true, findByClientMessageId }` and call
`service.reconcile()`. The adapter must return `{ clientMessageId, guid }` only
when acceptance is established for that exact identifier. A not-found result
never permits retry. After actual owner verification, a local operator can call
`service.resolveReply(requestId, responseId, { outcome: 'sent', ownerVerified: true,
provider_id })`, or use `outcome: 'not_sent'` to requeue with the same stable client
message ID. These operations are not exposed to Athena through MCP.

Use a private persistent directory. SQLite contains message text and subscription
secrets; the database file is restricted to its owner, and an exclusive OS lock
prevents competing workers. Do not copy a running database as a backup or resume
from an old snapshot automatically. Persistent pause, explicit request recovery,
encrypted snapshots and paused restoration are implemented; see the
[operator procedures](docs/operations.md) for the local API and offline CLI.
Local OAuth, verified Photon replay and live deployment remain separate work.

## Remaining work

Before considering live ongoing conversation: complete the sibling designs for
authentication, verified replay, retention and hosted operation, then validate the durable message component against the real provider. Reassess hosting availability
and costs with the owner. Free service sleep/restarts can interrupt an in-memory
connection; this prototype deliberately stops instead of recovering unattended.
Any expansion needs separate review and authorization.

## References

- [V1 design overview and documents](docs/design-v1.md)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Photon cloud iMessage](https://photon.codes/docs/spectrum-ts/providers/imessage)
- [Render Free services](https://render.com/docs/free)
- [Render environment changes](https://render.com/docs/configure-environment-variables)
