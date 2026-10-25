# Future-only Photon live integration

User authorized implementation after deferring historical catch-up. Continue from
`425fc34d2d697096cce035c9e27f392aac8d72c5` on the existing feature branch.
Node >=22.23.4 <23; no dependency/default runtime changes, real accounts, provider
calls, publication or deployment. Existing catch-up code is retained unchanged.

## Design and acceptance

Use a separate live controller with no cursor/history contract. Each connection
opens the pinned SDK's exact-DM message stream with fresh bounded credentials.
Sequence gaps are tolerated; message-ID deduplication and claims remain durable.
Ignore unsupported incoming frames, fail closed on persistence/recovery rejection,
and retire generations on pause, expiry, auth failure or shutdown. Transient stream
failures retry with bounded delays; token rotation reconnects before expiry and
never extends the approved activation deadline. State/log output contains fixed
categories only. No call to historical or broad event subscription APIs is allowed.

An explicit host factory composes OAuth/messages and this adapter/controller;
construction does not connect. A trusted sender facade reports readiness before
reserving queued replies. Once a send is reserved, any disconnect/timeout remains
unknown under the existing store rules; never retry it on a new session. Shutdown
fences intake/sending, closes transport, then drains/closes the message/OAuth stores.

The official SDK token helper has no AbortSignal interface. Bound local waiting
and discard late token results; document any uncancelled underlying HTTP work.
The real SDK runs only against loopback/protocol fixtures in this task.

- [x] Write failing controller, adapter and composition tests before implementation.
- [x] Implement new photon-live-controller.mjs and photon-live-adapter.mjs with
  filtering, real SDK RPC fixture coverage, expiry/retry/renewal/cancellation.
- [x] Implement photon-message-host.mjs and trusted sender readiness in
  message-service.mjs; test durable duplicates and uncertain in-flight sends.
- [x] Add restart/process fixtures and explicit no-history assertions; update docs.
- [x] Independent review for auth/logs/filtering/races/renewal/crash boundaries;
  fix findings, full supported-version suite/audits/secret/docs checks.
- [x] Commit local work only and report exact remaining live acceptance gates.


## Local completion and review

- Controller tests first failed for the absent module; then passed. New auth-send
  failure and disconnected-queue regressions failed before their fixes. Host
  composition tests first failed for the absent factory, then passed.
- Adapter tests were implemented test-first. Fourteen tests include actual pinned
  SDK loopback RPC filtering/authentication/no-retry/cancellation, plus actual
  cloud-helper request construction with fixture fetch and origin-override refusal.
- Controller/process coverage: sequence gaps, strict owner/plain-text filtering,
  finite reconnect retries, heartbeats/idle timeout, renewal, pause/expiry/stop,
  late authentication, terminal auth-send failure, SIGKILL after admission/claim/
  send reservation, and process exit during retry backoff. Host integration covers
  real local OAuth gates, SQLite duplicates/restart and unknown sends after loss.
- `npm exec --yes --package=node@22.23.4 -- npm test`: **200/200 passed**, no failures
  or skips. `npm exec --yes --package=node@22 -- node --version`: **v22.23.4**.
- Independent final review: **41/41** targeted tests passed with **no actionable
  findings**. Reviewer checked filtering, credentials/logs, cancellations, renewal,
  restart/crash behavior, unknown sends and final documentation against source.
- Fresh `npm audit` and `npm audit --omit=dev`: zero known vulnerabilities.
  `npm ls --all` succeeds; `node scan.mjs` passes 56 source files. Recursive
  changed-file secret checks, local documentation links/anchors/fences and
  `git diff --check` pass.
- Default runtime/server/original proof transport, retained historical recovery
  source/tests, and package manifest/lockfile are unchanged from the scope-doc
  commit. Work remains local; no push, PR, merge, deployment, live credentials,
  subscriptions, history reads or messages.

## Limits and remaining gates

The pinned public SDK token helper cannot accept AbortSignal. Cancellation bounds
local waiting and discards late credentials but cannot cancel its already-issued
HTTP request through that API. This limitation is explicit; gRPC streams and
in-flight unary calls are cancelled by channel closure, without claiming external
send rollback. Historical catch-up stays deferred. Production listener/TLS/storage/
secret setup, activation policy, identity migration if required, and bounded real
Photon/Google/ChatGPT acceptance remain separate gates. See the
[live host contract](../../photon-live.md) for trusted composition and exact behavior.
