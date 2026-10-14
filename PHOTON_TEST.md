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
with only a random request ID and the fixed text, and retains a reply closure bound to the captured
inbound DM and message GUID privately. The reply tool accepts only that request ID.
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

`createPhotonTransport` uses public `@photon-ai/advanced-imessage/grpc` APIs
for both directions. It exchanges the exact project's secret using Spectrum's
exported `cloud.issueImessageTokens` helper, selects only the configured line,
and subscribes with `messages.subscribeEvents({chat: exactDM})`. No Spectrum
instance or iMessage provider is created. No profile/contact, account-settings,
chat-creation, typing, read-receipt, reconnect or catch-up method is called.

The direct client sets TLS, `retry:false`, `autoIdempotency:true`,
`channelOptions:{'grpc.enable_retries':0}` and a bounded unary timeout. The
single captured reply calls `messages.sendText` with the captured DM/message GUID,
a stable per-request UUID, fixed reply text, and link preview/data detection off.
Both event and message must explicitly be inbound (`isFromMe===false`). Text,
owner/service, exact chat IDs, fresh timestamp, normal item type and no app,
attachments, automatic/system/spam/corrupt/multipart content are checked before
normalization into the existing controller. The controller's checks still apply.

Token exchange is only a prepared code path: **it has never been run with real
credentials.** Its wait is bounded to five seconds; late results are discarded.
No auto-renewal occurs. Token expiry minus five seconds or the approved session
expiry, whichever comes first, closes the stream and client. Stream error/end or
earlier token expiry synchronously notifies the controller before cleanup awaits,
invalidates its pending request, and exposes a terminal state instead of stale
listening/awaiting status. Closure during a send preserves `unknown_outcome`,
even if the original RPC later resolves successfully. Normal accepted replies
retain their result through intentional cleanup. Cloud origin and
managed gRPC endpoints are fixed/validated, not arbitrary operator URLs.
Shared routing uses the literal `shared`, not the displayed managed number.
Dedicated routing must uniquely match the configured number in the authenticated
token response. Parent must verify the displayed owner/managed-line association
in Photon; shared tokens do not independently attest to that displayed number.

## Retry/profile findings and supported resolution

Original MIT packages: Spectrum core/provider 12.10.1; Photon SDK 2.2.0. All are
exact lockfile dependencies. No vendor patch, internal monkey-patch or copied
vendor source is used in the replacement. See [SDK_REVIEW.md](SDK_REVIEW.md) for
source locations, exact retry conditions, original-SDK loopback observations,
licensing/maintenance assessment and remaining live verification limits.

The earlier gate was conservative: `retry:true` is not proof of duplicate sends.
The middleware intends to retry only server-marked failures, with a default
maximum of four attempts; generic unmarked ambiguous network errors are not
selected by that middleware. In the pinned installation's real loopback test,
a marked trailer produced ONE request and a final `retryable:true` error; the
trailer capture is outside retry middleware. We do not rely on that ordering or
claim a universal SDK guarantee. The replacement explicitly disables both retry
layers regardless. Pre-send retries should not be characterized as duplication.

The Spectrum provider's contact-share callback runs on non-self
`message.received` events before application filtering when profile sync is true.
The direct SDK replacement does not create that provider and therefore never
installs that callback. No Photon profile/account-setting change is required.

The prepared source unlock sets `PHOTON_LIVE_TRANSPORT_ALLOWED=true`; it has no
env/MCP override. `server.mjs` uses `runtime.mjs` to read approved configuration.
Construction still does not connect: the existing owner OAuth gate,
verified subscription, fresh deadline and explicit current-boot activation apply.
Credentials alone cannot activate it. Local dependency injection is used only by
tests; the server never selects dependencies from environment or HTTP/MCP input.
This code has only fixture and loopback RPC evidence, not Photon server acceptance
or iMessage proof.

All SDK-start tests inject local loaders; the reviewed source-flag test also
injects a loader and proves it is never reached when activation is inactive.
Runtime source-default tests inject a transport factory. No CI test exchanges
a fixture secret with Photon, regardless of the source flag.

## Verified mapping and runtime configuration (2026-10-14)

The logged-in Photon Athena Users page showed one active owner, Alex Tuan,
registered sender `+13322179242`, assigned number `+17739371532`, Shared. The
Platforms page showed iMessage Shared Connected with the same managed number.
These observations are dashboard evidence, not live transport evidence:
https://app.photon.codes/dashboard/77c7d003-2bf1-4638-b866-2e2ce16ab091/users
and https://app.photon.codes/dashboard/77c7d003-2bf1-4638-b866-2e2ce16ab091/platforms.

Runtime inputs:
- `SPECTRUM_PROJECT_SECRET`: existing Athena secret, entered directly by the user
  in Render. Never supplied in chat, local files, tests or logs.
- `PHOTON_OWNER_ADDRESS`: must equal the dashboard-verified `+13322179242`;
  a missing or different value leaves Photon unconfigured.
- `QUICKSILVER_OWNER_SUBJECT`: preserve the existing verified Auth0 owner value.
- `QUICKSILVER_SESSION_EXPIRES_AT`: fresh absolute UTC deadline, at most one hour
  after process startup. Do not reuse the expired October 13 window.

The project is fixed to `PROJECT_ID`; shared SDK routing is fixed to `shared`.
No project, managed-number, endpoint or DM environment override is accepted.
Expected DM `any;-;+13322179242` is derived from the SDK's canonical form and the
verified sender. An actual live provider GUID has not been observed. Incoming
events must match this exact GUID at both adapter and controller or fail closed;
do not broaden subscriptions or discover unrelated chats if it differs.

## Next secure handoff and live go/no-go gates

1. Review the local runtime wiring and tests, then separately authorize the source
   unlock and deployment for the bounded test. Reassess
   any provider account/plan/cost requirement with the owner before proceeding.
2. Use the verified owner/shared-line mapping above. Confirm the actual incoming
   DM GUID through the exact filtered test; never infer identity from Google or
   create another conversation. A mismatch stops the experiment.
3. User approved and completed direct secret storage in the existing Render
   service on October 14. The saved key was verified without reading its value.
   Configure only the verified non-secret owner field and a freshly approved
   deadline. No new credential or broader grant is needed for this revision.
4. Obtain a fresh explicit bounded live-test deadline and user authorization for
   the exact text/one-reply test. Update only approved routing/deadline fields,
   refresh tools in the existing Athena connection, verify subscription, inspect
   the current boot ID, and explicitly arm once. Never reuse the expired window.
5. User sends the fixed text once from the registered number. Require the event
   in existing Athena, its exact request-bound reply tool result, and user/Photon
   evidence that the fixed reply reached the same DM. Neither a callback 2xx nor
   provider acceptance alone proves the two-way connection. On ambiguous send,
   sleep/restart or expiry: stop, inspect and do not retry automatically.

The deadline is an absolute ISO UTC value read once at process startup, not a
15-minute timer that starts when armed. Changing the Render variable requires a
new process; Save only does not change a running process. A restart also clears
subscriptions and changes the boot ID. Therefore first finish deployment and
connector preparation, then set the agreed deadline to 15 minutes ahead, restart,
establish the authenticated subscription on that boot, inspect status and arm.
Subscription setup consumes part of that window. It cannot be finalized with the
expired deadline and then retained through a deadline-changing restart. Do not
extend or renew the deadline automatically if setup takes too long.

No plugin install, security changes, credential generation, paid service/storage,
or actual iMessage is authorized or performed by this implementation deployment.

Sources: https://photon.codes/docs/spectrum-ts/providers/imessage,
https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing,
https://photon.codes/docs/spectrum-ts/messages,
https://developers.openai.com/plugins/build/mcp-events,
https://github.com/photon-hq/spectrum-ts (MIT).
