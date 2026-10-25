# Local OAuth final audit — October 25, 2026

## Reviewed implementation

- Branch: `feat/local-oauth`.
- Implementation commit: `b462b839b487bb33165c5cdb94baf3069b795f0b`.
- Predecessor: `78c4ce75f7e4d47ca860546676bab7a52d89cd7e` (durable messaging/recovery, draft PR #1).
- The independent reviewer rechecked the final queue deadline, canonical issuer,
  Koa error-handler fixes and local-service integration at the implementation
  commit. Verdict: **approved for the documented local component scope**; no
  remaining actionable source-level findings. Existing targeted tests passed
  **23/23 on Node 22.13.0**. The final audit adds documentation only.
- A review request was initially blocked by an automated cybersecurity filter.
  A narrower read-only source review plus existing local tests completed. The
  approval does not establish live-provider compatibility or cover the dependency
  conclusions below, which were investigated separately by the implementing agent.

## Dependency findings

`npm audit --omit=dev` reports **14 affected package entries**, not 14 independent
advisories: **13 moderate entries** propagate one OpenTelemetry advisory, and
**one high entry** (`undici`) contains three advisories. These are production
runtime dependencies; there are no dev dependencies in this manifest.

| Installed affected package | Advisory / effect | Affected range relevant here | First patched version in the same major |
| --- | --- | --- | --- |
| `undici` 7.30.0, transitive | [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), **high**, process denial of service during fetch response decoding | >=7.18.0 <7.30.1 | **7.30.1** |
| `undici` 7.30.0, transitive | [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685), moderate, EventSource memory exhaustion | >=7.0.0 <7.30.1 | **7.30.1** |
| `undici` 7.30.0, transitive | [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472), moderate, subresource integrity bypass with non-lowercase algorithm metadata | >=7.15.0 <7.30.1 | **7.30.1** |
| Nested `@opentelemetry/core` 2.7.1, transitive | [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf), moderate, unbounded W3C Baggage parsing allocation | <2.8.0 | **2.8.0** |

The installed dependency paths are:

- Direct `@spectrum-ts/core` 12.10.1 → `open-graph-scraper` 6.12.0 →
  `undici` 7.30.0; Cheerio 1.2.0 also reaches the same Undici installation.
  The parent ranges are `^7.28.0` and `^7.19.0`, respectively, so 7.30.1 fits
  without a major upgrade. Its published Node engine is >=20.18.1.
- Direct `@spectrum-ts/core` / `@spectrum-ts/imessage` 12.10.1 →
  `@photon-ai/otel` 3.8.1 → OpenTelemetry exporters/SDK 0.218.0 → nested
  `@opentelemetry/core` 2.7.1. The 13 moderate entries include these dependents;
  the direct Spectrum entries are dependency propagation, not new distinct flaws.
  The hoisted core 2.12.0 is already above the patched boundary; nested copies
  remain affected.

All **24 distinct advisory-affected lockfile paths**, versions and integrity
hashes exactly match predecessor commit `78c4ce75f7e4d47ca860546676bab7a52d89cd7e`.
This proves the findings were not introduced by the OAuth dependency additions;
it does **not** establish safety or justify ignoring them.

### Reachability and limits

The new OAuth handler imports `oidc-provider`, `openid-client`, their protocol
helpers and local storage. The message composition does not itself import the
Photon/Spectrum SDK; the host injects a provider. A Node module-load trace while
running the existing local-service integration tests observed **263 distinct
module URLs**, with **zero** modules from npm `undici`, Spectrum, Photon
telemetry or OpenTelemetry. The three integration tests passed during tracing.
Source inspection agrees with that result. This is evidence for the tested
composition, not a blanket assertion about every future host/provider.

The high Undici advisory requires an affected `fetch()` client receiving a
malformed response from the server it contacts. The installed Spectrum SDK has
an actual `fetchLinkMetadata` → `open-graph-scraper` → npm `undici.fetch` path.
The new OAuth surface neither calls that helper nor accepts a caller-selected
upstream URL. It uses fixed Google HTTPS token/JWKS endpoints. Nevertheless,
other SDK consumers, injected provider behavior or future URL-fetching features
could reach the affected client. No production exploitability test was run.

No EventSource construction or SRI fetch-integrity option exists in the new
OAuth module. It installs no baggage extraction middleware. Photon telemetry's
own direct `W3CBaggagePropagator` resolves to the patched hoisted core 2.12.0,
while affected 2.7.1 copies remain under exporters/SDKs. No path from the new
OAuth HTTP input to those vulnerable parsers was found. Live host tracing,
instrumentation and configuration may differ and must be assessed separately.

`openid-client` / `oauth4webapi` use native `fetch` unless the trusted host
supplies `google.fetch`. Native fetch embeds a **separately versioned** Undici;
updating the npm lockfile cannot patch it:

- Tested minimum Node **22.13.0** reports bundled Undici **6.21.0**. This is below
  the high advisory's 6.x affected floor (6.23.0), but is within the EventSource
  advisory's range. This OAuth component does not use EventSource. Passing the
  test suite is not a general security certification of that old runtime.
- Current Node **22.23.4** reports bundled Undici **6.29.1**, the patched 6.x
  version for the two applicable Undici advisories. It is the recommended
  supported runtime for further acceptance work.
- The workspace default Node **24.19.0** reports bundled Undici **7.29.0**, within
  the listed high advisory range, and is outside this project's declared Node
  >=22.13.0 <23 target. No live Google/Photon flow was run on it. Use the explicit
  supported runtime commands; do not mistake the workspace default for the
  deployment choice.

### Remediation decision

No additional local OAuth code defect was established by this dependency audit.
The bounded local implementation can be accepted with the documented unresolved
repository/runtime risks; this does not authorize launch.

Before live launch, make a separate reviewed dependency-remediation change:

1. Refresh the locked npm Undici to **7.30.1 or a later patched 7.x release**, then
   rerun SDK/transport compatibility tests. This is a compatible-range patch
   update, not a required SDK major migration, but changes the existing runtime
   dependency graph beyond this authentication stage.
2. Coordinate the OpenTelemetry chain upgrade. Exporters/SDK **0.219.0** use core
   **2.8.0**; the current `@photon-ai/otel` **3.8.3** still requests `^0.218.0`,
   which excludes 0.219.0 under 0.x semver. A simple top-level core update does not
   replace exact nested 2.7.1 dependencies. Prefer an upstream compatible fix or
   a deliberately reviewed override/SDK update; do not apply a broad forced
   audit upgrade without testing the coupled telemetry versions.
3. Use a patched supported Node release such as **22.23.4**, inventory its bundled
   client independently, and assess any injected fetch/telemetry/provider code.

Published versions and dependency constraints were checked with `npm view` for
Undici 7.30.1, core 2.8.0, exporters/SDK 0.219.0, Photon telemetry 3.8.1/3.8.3,
open-graph-scraper 6.12.0 and Cheerio 1.2.0. Advisory pages above were fetched from
GitHub. No dependency versions or runtime configuration were changed in this
bounded audit.

## Local completion versus launch

Implemented and independently rechecked: owner/client/resource-bound local OAuth,
Google OIDC validation through fixtures, durable grants, PKCE, refresh rotation
and revocation, existing message-tool integration, bounded request handling,
and preservation of the one-hour activation limit.

Still external/live gates: Google and ChatGPT acceptance with real credentials,
TLS/proxy isolation and rate limits, key provisioning/rotation, dependency
remediation, persistent hosting and operational retention decisions.

Still **unimplemented**, not merely untested: production activation policy beyond
the bounded session, Auth0-to-Google message-store identity migration, coordinated
OAuth snapshot restoration, MCP replay cursors and Photon catch-up/reconnect/token
renewal integration. Message restoration requires fresh OAuth authorization.

No push, PR change, merge, deployment, credential configuration, Auth0 change,
live account connection, live message, or purchase occurred.

## Final checks

- `npm exec --yes --package=node@22.13.0 -- npm test` — **140/140 passed**, zero failures or skips.
- `npm exec --yes --package=node@22.23.4 -- npm test` — **140/140 passed**, zero failures or skips.
- Independent reviewer: `npm exec --yes --package=node@22.13.0 -- node --test local-oauth.test.mjs local-service.test.mjs oauth-store.test.mjs` — **23/23 passed**.
- Existing local-service tests with a read-only module-load observer on Node 22.13.0 — **3/3 passed**; the observer recorded import URLs only and did not replace application modules or network behavior.
- `npm exec --yes --package=node@22.13.0 -- node scan.mjs` — **43 root source files passed**.
- Recursive secret-pattern check — **55 source/documentation files passed**; **25 local documentation links** and balanced code fences passed.
- `git diff --check` — passed. The final audit changes documentation only; the independently reviewed application source and dependency lockfile remain identical to implementation commit `b462b839b487bb33165c5cdb94baf3069b795f0b`.
