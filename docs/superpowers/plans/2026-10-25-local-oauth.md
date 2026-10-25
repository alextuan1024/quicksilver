# Local OAuth Implementation Plan

Status update, October 25: this plan is complete and merged through
[PR #2](https://github.com/alextuan1024/quicksilver/pull/2). The 14 dependency
entries and Node 22.13 results below are historical: the subsequent
[remediation](../../dependency-remediation.md) resolved the four advisories,
raised the floor to Node >=22.23.4 <23 and passed 143 tests. See the
[current roadmap](../../status.md) for remaining production work.

> Execute natively with test-first steps and a fresh whole-change review.

**Goal:** Implement the remaining local authentication component from the approved V1 design, with Google identity and durable owner/client-bound authorization.

**Architecture:** `oidc-provider` owns OAuth protocol processing; `openid-client` owns upstream Google OIDC validation. A private SQLite adapter persists grants, tokens, sessions and short-lived login transactions. A trusted HTTP composition factory joins the OAuth handler and existing message service without activating the parked runtime.

**Spec:** [Architecture and authentication](../../design-v1/architecture-and-authentication.md)

## Constraints and implementation decisions

- Node >=22.13 <23, existing Node test runner; no credentials, deployment, provider messaging or external configuration changes.
- Pin one Google subject, one pre-registered MCP client, exact HTTPS redirects and exact resource/scope. No dynamic registration or arbitrary upstreams.
- Require S256 PKCE, use rotating refresh tokens and revoke the grant on reuse. Resource authentication checks live token/grant state so revocation is immediate.
- Operator supplies persistent signing JWKS and cookie keys. Database identity includes issuer, owner, client and resource; no silent key regeneration on boot.
- Existing one-hour message/session activation boundary remains. Persistent OAuth login/grants can survive it; removing the launch boundary is a separate runtime decision.
- Google consent and ChatGPT compatibility require later authorized live acceptance. Local tests use a protocol fixture for Google only.
- Keep OAuth state in a separate private database in the same deployment; never restore old OAuth grants from a message backup. Document revocation/reconnection after restoration.

## Review focus

1. Expired/replayed authorization codes and Google login transactions must fail closed.
2. Wrong owner, client, redirect, scope, resource, state or nonce must not create a usable grant.
3. Refresh rotation/reuse and revocation must survive restart and reject previous credentials.
4. Missing keys, changed identity, competing database owners and stopped services must fail closed.
5. Browser/HTTP boundaries must not trust arbitrary host/proxy headers or expose raw OAuth/provider errors.

## Tasks

### 1. Durable adapter (`oauth-store.mjs`, `oauth-store.test.mjs`)

- [x] Write and run failing tests for restart, expiry, consumption, grant revocation, identity isolation and exclusive access.
- [x] Implement `openOAuthStore({path, identity, now})`, exposing provider `Adapter`, atomic one-use login transaction methods, `close()` and local grant revocation.
- [x] Run adapter tests; check privacy permissions and failure cleanup.

### 2. Local provider (`local-oauth.mjs`, `local-oauth.test.mjs`)

- [x] Write and run failing tests against real HTTP authorization/token/revocation endpoints for PKCE, client/redirect/resource pinning and persistence.
- [x] Implement `createLocalOAuth(config)` with pinned client, supplied keys, SQLite adapter, resource indicators, rotating refresh tokens and live opaque-token gate.
- [x] Implement upstream Google login using `openid-client`, browser-bound one-use state, nonce and PKCE; test owner mismatch and callback replay using a local protocol fixture.
- [x] Verify refresh/revoke/reuse across restarts, safe errors and stopped state.

### 3. Trusted composition (`local-service.mjs`, `local-service.test.mjs`, message-service gate injection)

- [x] Write and run failing tests proving local tokens authorize the existing message MCP tools, revoked tokens fail and existing Auth0 tests still pass.
- [x] Add trusted gate injection to message service and HTTP composition with bounded JSON input, exact routing/host checks and lifecycle cleanup.
- [x] Document operator configuration, key rotation and recovery, compatibility gates and current activation boundary.
- [x] Run full Node 22.13 suite, secret scan, whitespace checks and independent review; fix substantive findings with regression coverage.

## Progress and rulings

- Recovered completed predecessor from `feat/durable-messaging-recovery`, commit `78c4ce7`; this new local branch is `feat/local-oauth`.
- User requested continuation of implementation. The existing V1 design supplies scope; library selection and internal composition are implementation decisions.


## Completion and review record

- Task 1: complete. Adapter contract failed before implementation, then passed. Records/consumption survive reopen, expirations and one-use browser state are enforced, grant revocation prevents resurrection, permissions and exclusive/identity checks pass.
- Task 2: complete. Real HTTP authorization/token/revocation tests failed before implementation. Google is the only wire fixture. PKCE, issuer/audience/subject/signature/nonce/state, expired/replayed codes, browser binding, durable refresh rotation/reuse/revocation and concurrent refresh tests pass.
- Task 3: complete. Integration tests failed before composition, then pass for local-token claim/reply, revocation, inactive session discovery, bounded JSON and browser/host rejection.
- Independent security review found two P2 defects: an incomplete OAuth POST could hold the serialized queue/shutdown; a noncanonical issuer without a slash could construct a wrong-host redirect. Both were reproduced by failing regressions before correction. Active OAuth requests now abort on an absolute deadline; configuration rejects noncanonical issuer/resource values before opening SQLite.
- Reviewer also observed Koa's raw transport error stack. Both provider and Koa error channels are now handled without raw logging; the incomplete-request regression verifies no console error output.
- No authentication bypass was found by the reviewer. No review findings were deferred. Review fixes were first verified with regression tests and the full suite. At the user coordinator’s request, the independent reviewer then rechecked final commit `b462b839b487bb33165c5cdb94baf3069b795f0b` and approved the local component, with 23/23 supported-version targeted tests and no remaining source-level findings.
- Ruling: keep the existing one-hour activation boundary — runtime activation remains outside this local component. Cost: no unattended ongoing channel until a production policy is implemented.
- Ruling: separate OAuth SQLite state from message backups and require fresh authorization after restore — restoring revoked credentials would be unsafe. Cost: operator reconnection; coordinated auth restore is unimplemented.
- Ruling: retain the existing Auth0 runtime and use the Google subject for the optional local component — silently changing a message database's owner binding would weaken isolation. Cost: migration of existing Auth0-bound message stores needs separate implementation.
- Ruling on review exclusions: live Google/ChatGPT acceptance, TLS/proxy isolation/rate limits, operational key provisioning/rotation, production activation, Photon replay/reconnect, identity migration and OAuth restoration remain explicit gates or unimplemented work as documented. No live acceptance is inferred from fixtures.

## Final verification

- `npm exec --yes --package=node@22.13.0 -- npm test`: **140/140 passed**, no failed/skipped tests.
- `npm exec --yes --package=node@22.13.0 -- node scan.mjs`: **43 root source files passed**.
- Recursive secret-pattern check: **54 source/documentation files passed**; **22 local documentation links** and code fences passed.
- `git diff --check`: passed. Manifest/lockfile Node requirement and direct dependencies agree.
- `runtime.mjs`, `server.mjs` and `photon-transport.mjs` have no changes relative to base `78c4ce75f7e4d47ca860546676bab7a52d89cd7e`.
- `npm audit --omit=dev`: **14 affected dependency entries (13 moderate, 1 high)**. All affected package paths and versions are unchanged from the predecessor commit. These are in the existing Spectrum/Photon/OpenTelemetry and `undici` dependency chains, not the added OAuth libraries. They remain unresolved and need a separate dependency remediation/compatibility pass before launch. No audit-wide automatic upgrade was applied to the pinned transport SDKs.
- The high entry is `undici` 7.30.0 (EventSource memory exhaustion, subresource-integrity algorithm normalization, and excessive content-encoding error handling); the moderate root advisory concerns OpenTelemetry baggage memory allocation, propagated through its dependents.
- No push, PR modification, merge, deployment, real Google/ChatGPT account connection, real persistent grant, Auth0 setting change, live messaging or purchase occurred.

## Requested final audit

The [final audit](../../local-oauth-final-audit.md) records independent re-review,
exact dependency advisories, baseline equality, runtime/import reachability,
patched version options and the separate remediation decision. No runtime or
dependency changes were made during that audit.
