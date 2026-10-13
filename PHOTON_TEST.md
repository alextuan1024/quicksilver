# Disabled Photon one-message connection proof

Approved scope: existing cloud project `77c7d003-2bf1-4638-b866-2e2ce16ab091`,
one verified owner, one predetermined incoming text and one fixed reply in that
same DM. Use the managed cloud line, not the user's Mac Messages account.

Incoming text: `Athena connection test.`
Reply text: `Athena received your connection test.`

## What is implemented and tested

`photon.mjs` validates exact configured project/owner address/line/DM, inbound
imessage platform and service, plain text, timestamp since activation, and excludes
groups, echoes, automatic/system/spam/corrupt messages and multipart parents.
It reserves the receive slot before async delivery, emits `photon.test.received`
with only a random request ID and the fixed text, and retains the original bound
message reply method privately. The reply tool accepts only that request ID.
No caller-supplied text or destination is accepted. Phone/DM identifiers and raw
provider errors are not logged or included in the event/tool result.

The same `/mcp` endpoint and exact-owner OAuth gate expose the new event and three
tools: `photon_test_status`, `arm_photon_test`, `reply_photon_test`. Existing Athena
must subscribe to the event, preserving the existing dot and conversation. No
new LLM or bot is created. The signed webhook callback must pass verification.
The reply slot is consumed before the async send; errors/undefined result mean
`unknown_outcome`, never retry. `provider_accepted` is not recipient delivery.

Each process starts disarmed with a random boot ID. Activation requires the
current boot ID, a verified subscription, private route configuration and a fresh
absolute session deadline (maximum one hour). The boot may arm once. Deadline
expiry or explicit stop invalidates the request and closes transport. Old boot
activation and old request IDs fail after restart. On Free Render sleep/restart,
stop the experiment: do not automatically resubscribe/rearm/replay. A new manual
activation requires fresh human approval after reviewing the previous outcome.
This fail-closed guard needs no disk; it does not provide durable exactly-once or
automatic recovery across separately approved sessions. Production durability
would require a separately reviewed store and design, not silently paid storage.

`createSpectrumTransport` awaits Spectrum's async factory, preserves original
space/message bindings, disables SDK telemetry and logs, and closes late startup
or completed streams. Its API is exercised using injected in-process fixtures;
real pinned SDK exports/configuration are imported offline. **No network calls to
Photon or real messages occur in these tests.** OAuth, signed callback and reply
are joined in a local contract test, not a live integration test.

## Blocking SDK findings

The published MIT packages `@spectrum-ts/core` and `@spectrum-ts/imessage` 12.10.1
were installed with lifecycle scripts disabled and exact lockfile versions.
Inspection of `@spectrum-ts/imessage/dist/index.js` found:

- Both cloud-token and explicit-client construction hard-code `retry: true` and
  `autoIdempotency: true`. The strict provider config exposes only `clients` and
  has no retry override. Underlying `@photon-ai/advanced-imessage/grpc` exposes
  `retry: false`, but Spectrum does not forward it through its public config.
  Stable auto-idempotency helps, but transport retries/unknown remote execution
  must be reviewed before promising a strictly one-attempt send.
- Cloud authentication registers a profile-sync gate; the receive stream can
  automatically share the project's contact card when profile sync is enabled,
  before this adapter's owner filter sees a message. Do not assume the project
  setting, change it, or allow extra sends under this one-reply approval.

Consequently `SPECTRUM_LIVE_TRANSPORT_ALLOWED=false` is a source-level lock with no
HTTP/MCP/environment override. `server.mjs` does not read Photon secret/routing
fields or attach a Photon transport. Setting environment credentials alone cannot
activate it. No secret fields were added to Render. Removing this lock is NOT an
operator setup step: first provide a supported no-extra-side-effect transport or
reviewed provider change, with tests for retry and contact-sharing behavior.
Do not patch node_modules or use internal runtime objects as a workaround.

## Next secure handoff and live go/no-go gates

1. Resolve the SDK issues above using supported APIs or a reviewed change; wire
   the reviewed transport into the server in a new tested deployment. Reassess
   any provider account/plan/cost requirement with the owner before proceeding.
2. Parent/user verify the exact registered owner E.164 address, managed line's
   SDK routing value and existing DM ID through Photon. Do not infer them from
   Google identity or create another conversation. Shared mode may use a routing
   sentinel instead of the displayed phone; verify the actual provider value.
3. Only then ask the user to enter the existing project secret directly in the
   approved Render secret UI. Do not put secrets in chat, tool arguments, repo,
   logs, screenshots or local files. No secret has been read or transmitted by
   this task. No new credential or grant is requested now.
4. Obtain a fresh explicit bounded live-test deadline and user authorization for
   the exact text/one-reply test. Update only approved routing/deadline fields,
   refresh tools in the existing Athena connection, verify subscription, inspect
   the current boot ID, and explicitly arm once. Never reuse the expired window.
5. User sends the fixed text once from the registered number. Require the event
   in existing Athena, its exact request-bound reply tool result, and user/Photon
   evidence that the fixed reply reached the same DM. Neither a callback 2xx nor
   provider acceptance alone proves the two-way connection. On ambiguous send,
   sleep/restart or expiry: stop, inspect and do not retry automatically.

No plugin install, security changes, credential generation, paid service/storage,
or actual iMessage is authorized or performed by this implementation deployment.

Sources: https://photon.codes/docs/spectrum-ts/providers/imessage,
https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing,
https://photon.codes/docs/spectrum-ts/messages,
https://developers.openai.com/plugins/build/mcp-events,
https://github.com/photon-hq/spectrum-ts (MIT).
