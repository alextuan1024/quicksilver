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

Target runtime: Node 22. The successful deployment passed **82 tests and the
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

## Remaining work

Before considering ongoing conversation: design durable event/request state,
idempotent recovery and subscription reconciliation, replay handling, explicit
message/content scope, and operational monitoring. Reassess hosting availability
and costs with the owner. Free service sleep/restarts can interrupt an in-memory
connection; this prototype deliberately stops instead of recovering unattended.
Any expansion needs separate review and authorization.

## References

- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Photon cloud iMessage](https://photon.codes/docs/spectrum-ts/providers/imessage)
- [Render Free services](https://render.com/docs/free)
- [Render environment changes](https://render.com/docs/configure-environment-variables)
