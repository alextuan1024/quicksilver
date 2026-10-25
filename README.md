# Quicksilver

An owner-only Photon iMessage channel into the existing Athena, independent of
the owner's Mac. Durable messaging, recovery controls and local OAuth are merged
and locally tested; production integration and live acceptance remain unfinished.
No separate LLM bot, arbitrary-recipient send tool, media or group support.

## Current progress — October 25, 2026

[PR #1](https://github.com/alextuan1024/quicksilver/pull/1) (durable messaging and
recovery) and [PR #2](https://github.com/alextuan1024/quicksilver/pull/2) (local OAuth
and dependency remediation) are merged into `main`. The current supported runtime
is **Node >=22.23.4 <23**. The merged implementation passed 143 local tests; its
full and production dependency audits reported zero known vulnerabilities.
These are dated verification results, not evidence of live readiness.

The default server still selects the bounded Auth0 proof path. The new components
require explicit trusted host composition; merging them does not deploy or activate
the channel. See the [progress and remaining V1 tasks](docs/status.md) for completed
work, implementation gaps, operational decisions and acceptance gates.

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

## Parked proof connection and controls

The path is Photon managed iMessage → strict one-owner transport → authenticated
relay → signed MCP event → existing Athena → request-bound reply → original DM.
This default proof path keeps state in memory. The optional durable component
described below has separate SQLite-backed state.

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

Target runtime: **Node >=22.23.4 <23** (built-in SQLite and patched native fetch).
The October 15 proof deployment passed 82 tests and the secret-pattern scan.
The merged October 25 implementation passed **143/143 local tests**, including
durable messaging/recovery, OAuth and dependency compatibility. Local tests use
fixture keys, injected providers and loopback servers; they do not establish
live Google, Photon or ChatGPT acceptance. No GitHub Actions workflow is configured;
CI remains recommended work, not completed verification.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test
node scan.mjs
node server.mjs
```

The proof deployment record describes a Render Free service using those
install/test/scan commands and starting `node server.mjs` with `/healthz`. At that checkpoint auto-deploy was off,
and no persistent disk or database was configured. This update does not recheck
the live service or upgrade its Node runtime. A docs-only push is not a deployment.
No secrets belong in this repository. Local evidence and dependencies remain ignored.

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
provider cursor after a persistence error. Provider checkpoint semantics would need
verification if historical catch-up is resumed in a future phase.

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
Local OAuth is now available through explicit trusted composition; see the
[local OAuth host contract](docs/local-oauth.md). Historical Photon catch-up is
deferred; production live reconnection and deployment remain separate work.

The [dependency remediation record](docs/dependency-remediation.md) describes the
scoped OpenTelemetry override, patched Undici, runtime floor and compatibility checks.

## Replay and reconnect components

The local next stage adds [durable MCP replay cursors](docs/event-replay.md) with
safe acknowledgment positions, refresh/restart recovery and restore truncation.
The [separate recovery controller](docs/photon-recovery.md) and its catch-up fixtures
are retained as optional, deferred work. They depend on verified scoped history
and cannot yet serve as a future-only reconnect adapter.

**V1 scope decision — October 25:** messages sent during a Photon disconnect may
be missed. Historical catch-up and history-scope verification are not V1 launch
blockers. [Future-only live reconnection and token renewal](docs/photon-live.md)
now have explicit SDK/host wiring tested with local fixtures; real-provider
acceptance and deployment remain outstanding. Durable handling and MCP replay
for requests already persisted remain required. Tolerating missed inbound traffic
never permits retrying uncertain outbound sends or repeating Athena actions.
These modules do not change the default server/runtime or activate any provider.

## Remaining work

Validate the fixture-tested future-only Photon SDK/host wiring with the real
provider under a bounded approved test, without historical catch-up. Validate
MCP cursor behavior in ChatGPT,
then integrate the durable components into a production host with an intentional
activation policy. Add CI, choose hosting/persistence, backup keys and retention,
provision Google credentials and persistent OAuth keys, and implement any required
Auth0 identity migration. Real Google/ChatGPT and Photon acceptance must include
interruptions, duplicates, uncertain sends and restore drills before a controlled
launch. The [ordered roadmap](docs/status.md#remaining-v1-work) separates these
implementation tasks from operational choices and live checks.

## References

- [V1 design overview and documents](docs/design-v1.md)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Photon cloud iMessage](https://photon.codes/docs/spectrum-ts/providers/imessage)
- [Render Free services](https://render.com/docs/free)
- [Render environment changes](https://render.com/docs/configure-environment-variables)
