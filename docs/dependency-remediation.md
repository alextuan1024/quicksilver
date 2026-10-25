# OAuth dependency remediation — October 25, 2026

The authorized follow-up to the [initial audit](local-oauth-final-audit.md)
remediates all four reported advisories. Both the fresh production audit and the
full dependency audit report **zero known vulnerabilities**. This is the audit
result at verification time, not a guarantee against unknown vulnerabilities.

## Changes and compatibility rationale

| Component | Before | After | Reason |
| --- | --- | --- | --- |
| npm Undici | 7.30.0 | 7.30.1 | Official patch for all three reported Undici advisories; satisfies both existing parent ranges |
| Photon telemetry API logs, SDK logs and three OTLP/HTTP exporters | 0.218.0 | 0.219.0 | Coordinated official releases pull patched core and compatible serializers |
| Affected nested OpenTelemetry core/resources/SDKs | 2.7.1 | 2.8.0 | Official patched baggage implementation and coordinated dependencies |
| Declared Node runtime | >=22.13.0 <23 | **>=22.23.4 <23** | Tested supported release with patched bundled Undici 6.29.1 |

The exact messaging dependencies remain `@photon-ai/advanced-imessage` 2.2.0,
`@spectrum-ts/core` 12.10.1 and `@spectrum-ts/imessage` 12.10.1. Photon telemetry
remains 3.8.1. No transport, runtime or server application source was changed.
No deployed Node version or live setting was changed.

`package.json` scopes five overrides to the `@photon-ai/otel` subtree:
`api-logs`, `sdk-logs`, and the logs, traces and metrics HTTP exporters, all at
0.219.0. This is necessary because even the current Photon telemetry 3.8.3
still requests the `^0.218.0` family, which excludes 0.219 under 0.x semver.
Blindly updating the messaging SDK would not fix that constraint. The official
0.219 packages depend on core/resources 2.8.0 and corresponding OTLP serializers;
we do not override individual exact core dependencies in isolation.

The remaining stable OpenTelemetry 2.12.0 packages are preserved. API peer ranges
remain satisfied, and `npm ls --all` exits successfully. The root API-logs
0.219.0 also deduplicates the previously nested instrumentation API-logs copy.
No forced major upgrade, hand-edited lockfile package, or vendor source patch
was used. Undici was updated through normal lockfile resolution within the
existing `^7.28.0` / `^7.19.0` parent ranges.

Remove the scoped overrides only when Photon’s normal dependency ranges select
a patched, coordinated family without them. Reinstall from scratch, rerun the
compatibility/full suites and audit, and verify no vulnerable nested copies
return. The official `sdk-trace-base` 2.8.0 package has a deprecation notice in
favor of `sdk-trace`; migrating Photon’s API usage is separate from these fixes.
The notice is not an audit vulnerability or a failed compatibility test.

## Verification

`dependency-integration.test.mjs` uses only loopback HTTP collectors/pages and
fixture content. It verifies the actual Photon dependency graph can:

- Export spans and logs while preserving their correlation IDs.
- Export a measured counter value through the metric provider and HTTP exporter.
- Fetch and parse ordinary OpenGraph metadata through the SDK’s installed
  metadata dependency and npm Undici.

All three compatibility tests passed on the original graph before the updates;
they verify the API boundary across the coordinated update, rather than
asserting version strings. The existing OAuth, message/recovery and loopback
SDK transport tests cover the rest of the integration. No malicious payloads,
real account connections, telemetry collectors or provider endpoints were used.

Reproducible commands (use the declared runtime):

```sh
npm exec --yes --package=node@22.23.4 -- npm ci --ignore-scripts --no-audit --no-fund
npm exec --yes --package=node@22.23.4 -- npm test
npm exec --yes --package=node@22.23.4 -- npm audit --omit=dev
npm exec --yes --package=node@22.23.4 -- npm audit
npm exec --yes --package=node@22.23.4 -- npm ls --all
npm exec --yes --package=node@22.23.4 -- node scan.mjs
```

The prior Node 22.13 runs remain historical compatibility evidence; 22.13 is no
longer the supported deployment floor. The current minimum and current selected
Node 22 release are both 22.23.4.

## Sources and remaining scope

- [Undici response-decoding advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c)
- [Undici EventSource advisory](https://github.com/advisories/GHSA-4qv8-2p9j-2685)
- [Undici integrity advisory](https://github.com/advisories/GHSA-f72v-6w45-q472)
- [OpenTelemetry baggage advisory](https://github.com/advisories/GHSA-8988-4f7v-96qf)

Library and runtime versions/engines were rechecked against published npm
metadata. These changes address the known dependency findings; live
Google/ChatGPT acceptance, real credential/key provisioning, hosting/proxy/rate
limit decisions, production activation, identity migration and replay/reconnect
implementation remain outside this phase. The existing activation and owner
boundaries remain in force.


## Completion evidence

The clean-install full suite passed **143/143** tests on Node22.23.4. The independent
reviewer passed **28/28** targeted compatibility/OAuth/transport tests, inspected
the graph and current documentation, and approved with no findings. Both fresh
registry audits report zero vulnerabilities. The initial reviewer test attempt
ran during node_modules replacement; the completed-install rerun passed.
