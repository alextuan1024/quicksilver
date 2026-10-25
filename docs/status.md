# Progress and remaining V1 work — October 25, 2026

## Verified repository baseline

Both implementation PRs are merged into the private `alextuan1024/quicksilver`
repository. This update started from freshly fetched `main` at
`b064f20c5edd01ac229ef00687bdb548294e58fa`:

| Work | Implementation head | Merged result |
| --- | --- | --- |
| Durable messaging and recovery | `78c4ce75f7e4d47ca860546676bab7a52d89cd7e` | [PR #1](https://github.com/alextuan1024/quicksilver/pull/1), merge `5f7c2140f0be1329fba4b9bafd8e71e952f21650` |
| Local OAuth and dependency remediation | `9f7de7ada3a8c45a738a212dcb58470687471f01` | [PR #2](https://github.com/alextuan1024/quicksilver/pull/2), merge `b064f20c5edd01ac229ef00687bdb548294e58fa` |

Merge metadata, source, tests, package manifest and lockfile were rechecked for
this update. The declared runtime is **Node >=22.23.4 <23**, not Node 22.13 or 24.
The known four dependency advisories were remediated with npm Undici 7.30.1 and
coordinated Photon OpenTelemetry overrides at 0.219.0/core 2.8.0. The dated full
and production audits reported zero known vulnerabilities; see the
[remediation record](dependency-remediation.md) for commands and override rationale.

## Completed and tested locally

- **Messaging:** SQLite-backed owner-bound requests, atomic deduplication/claims,
  stable signed events, durable subscriptions and bounded callback retries,
  ordered request-bound progress/final replies and visible uncertain sends.
  Repeated claims do not restart work; provider acceptance does not prove delivery.
- **Recovery:** persistent pause, sanitized inspection, explicit operator
  reconciliation, encrypted message snapshots and non-overwriting paused restore.
  Restored work remains held behind reconciliation and a verified intake boundary;
  missing post-snapshot replies cannot silently resend.
- **Authentication:** mature OAuth/OIDC libraries, pinned Google subject and MCP
  client/redirect/resource/scope, S256 PKCE, persistent grants, refresh rotation
  and revocation, plus explicit HTTP composition with the message component.
- **Dependency compatibility:** loopback trace/log correlation, metrics export and
  metadata HTTP tests cover the coordinated updates without live account access.

The merged implementation's clean-install suite passed **143/143 on Node
22.23.4**. Independent reviews rechecked OAuth security fixes and integration,
then dependency compatibility (28/28 targeted tests), with no remaining findings
within the local scope. Secret scans and dependency-tree checks passed. These
are the implementation-stage results, not a test rerun or live acceptance claim
for this documentation-only change. Earlier 82/117/140-test and Node 22.13 records
are dated history, superseded for the current runtime and suite size.

## Production integration is unfinished

`server.mjs` still constructs `runtime.mjs`, whose Auth0 configuration selects the
bounded in-memory proof. It does not select `messageHandling` or
`createLocalMessageService`. The new factory requires trusted host configuration;
no environment variable activates it. The one-hour message activation ceiling
also remains in the new composition. Merging the modules did not switch or deploy
the runtime.

The last recorded live success is the [October 15 fixed-text proof](../PHOTON_TEST.md),
followed by shutdown/disabled configuration. It does not establish ongoing general
conversation, durable recovery or the local Google OAuth flow. This update did
not inspect the current hosted service, real credentials or provider accounts.

## Remaining V1 work

The recommended order is implementation and local reliability first, followed
by operational setup and explicitly approved live acceptance:

1. **Implement MCP event replay cursors.** The bridge currently rejects non-null
   cursors; persisted subscriptions and outbox retries do not implement replay.
   Define cursor ordering, retention, truncation and recovery-gap behavior without
   skipping pending work or repeating claimed actions.
2. **Implement Photon reconnect, catch-up and token renewal in the host.** First
   establish owner-scoped sequence/replay, retention and lookup semantics for the
   pinned SDK and actual shared line. Preserve exact owner/DM filtering, stable
   identifiers and conservative unknown-send handling. Persisted opaque provider
   checkpoints alone are not a verified replay watermark or idempotency guarantee.
3. **Build production composition and activation policy.** Wire the durable
   message/OAuth modules and managed Photon lifecycle into a host with explicit
   startup, shutdown, pause and monitoring behavior. Decide and implement the
   ongoing activation policy; do not automatically extend the current one-hour
   limit. An Auth0-bound message database cannot be reopened under a Google `sub`:
   design and implement an operator-reviewed identity migration if such state
   must be retained. No migration command exists today.
4. **Add CI.** No `.github/workflows` files are present; the OAuth commit had no
   remote statuses, check runs or Actions runs. Recommended CI: clean install and
   full tests on the supported Node floor/current supported Node 22, secret scan,
   dependency audit/tree checks, documentation links and whitespace validation.
   Keep provider fixtures and exclude real credentials/messages from CI.
5. **Choose and provision operations.** Select hosting/budget, a private persistent
   volume, TLS/proxy isolation and edge rate limits, monitoring, backup destination
   and restore ownership. Decide message/content, deduplication, OAuth tombstone
   and backup retention/deletion policies. Provision backup encryption keys with
   separate escrow and rotation, plus persistent OAuth signing/cookie keys. These
   are operational choices, not completed repository configuration. Render Free's
   ephemeral filesystem is unsuitable for the local durable store.
6. **Set up real identity and verify client compatibility.** Provision the Google
   web-client credentials and exact callback, establish the pinned owner `sub`,
   register exact MCP redirects and validate Google and ChatGPT public-client,
   discovery, PKCE, refresh and revocation behavior. Plan any Auth0 cutover only
   after identity/state migration and rollback are ready. Fixtures do not prove
   provider acceptance; credential setup has not been done in this phase.
7. **Run integrated reliability and recovery drills.** Extend local fixtures for
   replay/reconnect and then perform bounded authorized provider/ChatGPT tests:
   interruption during persistence/callback/claim/send, duplicate/out-of-order
   delivery, expiry/renewal, unknown-send reconciliation, pause/resume and fenced
   backup restoration. Verify continuity with the existing Athena and the Mac off.
   Use real provider evidence for recovery boundaries and send outcomes; do not
   infer failure from a timeout or a missing lookup.
8. **Controlled launch.** After the above gates pass, obtain explicit approval for
   a bounded live rollout with monitoring, pause/rollback criteria and recorded
   recipient confirmation. Expand to ongoing operation only under the implemented
   activation policy. No merge or docs update authorizes deployment or messaging.

Message backups intentionally exclude the separate OAuth database. The supported
recovery procedure fences the old host, retains message restore holds, opens a
fresh OAuth database and requires owner reconnection. **Coordinated OAuth snapshot
restoration is unimplemented**; do not restore old revoked grants. If retained
OAuth sessions across disaster recovery become a requirement, that needs a
separate design and implementation before use.

Media, groups, unsolicited iMessages, standalone reminders, arbitrary recipients
and a separate LLM bot remain outside V1. Existing Athena action-confirmation
rules continue to apply.

## Operating references

- [Design overview](design-v1.md) and [scope/acceptance](design-v1/scope-and-decisions.md)
- [Message integration contract](../README.md#durable-message-component)
- [Local OAuth host contract](local-oauth.md)
- [Pause, reconciliation, backup and restoration](operations.md)
- [Historical OAuth audit](local-oauth-final-audit.md) and [dependency remediation](dependency-remediation.md)
