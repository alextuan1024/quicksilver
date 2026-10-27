# Progress and remaining V1 work — October 27, 2026

## Verified repository baseline

PRs #1–#4 are merged into the private `alextuan1024/quicksilver` repository.
Production-entrypoint/CI work starts from freshly fetched `main` at
`2b80a0b34d463cd84fab013f103b6a78dfff1b17` (PR #4's merge):

| Work | Implementation head | Merged result |
| --- | --- | --- |
| Durable messaging and recovery | `78c4ce75f7e4d47ca860546676bab7a52d89cd7e` | [PR #1](https://github.com/alextuan1024/quicksilver/pull/1), merge `5f7c2140f0be1329fba4b9bafd8e71e952f21650` |
| Local OAuth and dependency remediation | `9f7de7ada3a8c45a738a212dcb58470687471f01` | [PR #2](https://github.com/alextuan1024/quicksilver/pull/2), merge `b064f20c5edd01ac229ef00687bdb548294e58fa` |
| Progress documentation | `907f25610c27f15685e5d0e42ef8313331909554` | [PR #3](https://github.com/alextuan1024/quicksilver/pull/3), merge `da058749aebc1bbb6d18c3759106d45488448d81` |
| MCP replay and future-only Photon reconnect | `6cfb4316ff9b1c943a3240e6f588f0282b752e70` | [PR #4](https://github.com/alextuan1024/quicksilver/pull/4), merge `2b80a0b34d463cd84fab013f103b6a78dfff1b17` |

The PR #4 merge and current main were verified before this implementation. The declared runtime is **Node >=22.23.4 <23**, not Node 22.13 or 24.
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
- **MCP replay:** authenticated durable cursors, safe acknowledgment positions,
  atomic subscription refresh, stable event IDs and restored-history truncation.
- **Future-only Photon integration:** real SDK token acquisition, exact-DM live
  subscription, bounded reconnect, token renewal, shutdown/pause/expiry fencing
  and explicit OAuth/message host composition. Disconnected replies remain queued;
  uncertain sends never automatically retry on a new session.
- **Dependency compatibility:** loopback trace/log correlation, metrics export and
  metadata HTTP tests cover the coordinated updates without live account access.

The merged implementation's clean-install suite passed **143/143 on Node
22.23.4**. Independent reviews rechecked OAuth security fixes and integration,
then dependency compatibility (28/28 targeted tests), with no remaining findings
within the local scope. Secret scans and dependency-tree checks passed. These
are the implementation-stage results, not a test rerun or live acceptance claim
for this documentation-only change. Earlier 82/117/140-test and Node 22.13 records
are dated history, superseded for the current runtime and suite size.

## PR #4 implementation and verification

Merged PR #4 contains:

| Local milestone | Commit |
| --- | --- |
| Durable MCP replay and optional catch-up controller | `ac585abaeeb4f3ba464ee468ee7a3b97e3a9fdc5` |
| Defer historical Photon catch-up from V1 | `425fc34d2d697096cce035c9e27f392aac8d72c5` |
| Future-only reconnect/renewal, real SDK adapter and trusted host wiring | `abf36788759773272fa64b702ec93fe376b704d7` |

The latest full suite passed **200/200 on Node 22.23.4**, with zero failures or
skips. Independent final review passed **41/41 targeted tests** and found no
actionable issues. Coverage includes actual SDK loopback RPC filtering/authentication,
renewal, cancellation, duplicate delivery, OAuth/SQLite host restarts, SIGKILL
recovery and uncertain sends. Full and production audits report zero known
vulnerabilities; the dependency tree is valid. The secret scan passed 56 source
files, and changed-file secret, documentation and whitespace checks passed.

These historical results belong to the PR #4 implementation commit above; they
are local verification, not live acceptance or remote CI for this new change.
There was no GitHub Actions workflow for PR #4. The production-entrypoint branch
now adds CI; its remote result must be checked separately.
See [the live host contract](photon-live.md), [MCP replay](event-replay.md), and the
[implementation/verification record](superpowers/plans/2026-10-25-future-live.md).
The optional [historical catch-up controller](photon-recovery.md) is preserved but
is not a V1 launch requirement.

## Production entry point and CI

The production-entrypoint branch adds [the production command](production-host.md):
private JSON configuration, a direct HTTPS or loopback proxy listener, the composed
Google OAuth/message/Photon host, and SIGTERM/SIGINT shutdown. Activation requires
`--activate` and a fixed deadline at most one hour ahead; restarts cannot extend it.
It retains persistent pause and uncertain-send safeguards. `npm start` still runs
the parked proof; deployment must explicitly select `npm run start:production`.

GitHub Actions CI now covers clean installs/full tests on Node 22.23.4 and latest
Node 22, recursive secret scanning, docs, dependency tree/audits and whitespace.
No deployment or provider credentials are part of CI. Local verification passed
**210/210 tests on Node 22.23.4**, including ten production-entrypoint tests. The
latest `node@22` selection resolves to the same version. Clean install, recursive
secret scan, documentation links/anchors/fences, dependency tree and whitespace
checks passed; full and production audits reported zero known vulnerabilities.
Independent integration/security/CI review found **no actionable findings** and
passed **10/10 production tests**, plus secret, docs and whitespace checks.
Workflow configuration does not by itself establish passing remote CI. This stage
is being published as a draft PR; no deployment, credentials or live activation
are included. The [deployment readiness checklist](deploy-readiness.md) records
required configuration, outstanding decisions and the next local verification work.

Hosting, real secrets, monitoring/edge controls and ongoing activation beyond one
hour remain unfinished. The last recorded live success is the
[October 15 fixed-text proof](../PHOTON_TEST.md), followed by shutdown/disabled
configuration. It does not establish ongoing conversation, durable recovery or
local Google OAuth acceptance. This work does not inspect or change the hosted
service, real credentials or provider accounts.

## Integrated fixture acceptance stage

A separate test/reliability branch stacks on draft
[PR #5](https://github.com/alextuan1024/quicksilver/pull/5), whose
[CI run #1](https://github.com/alextuan1024/quicksilver/actions/runs/40535805619)
passed both supported Node jobs at `fc306e437eb87ca3dafc58494f65a918eccc0763`.
It adds [three production acceptance drills](production-acceptance.md): real
OAuth/MCP HTTP with reconnect/replay, SIGKILL during callback/claim/send, and
persistent pause plus fenced encrypted restoration with fresh OAuth. Providers
and recipients remain synthetic. No production source, dependency versions or
one-hour activation policy change is included. The full suite passed **213/213**
on Node 22.23.4; independent test-validity review passed **3/3** integrated cases
with no actionable findings. Scans, docs, dependency tree/audits and whitespace
checks passed. Initial remote CI exposed stale Node 22.23.3 cache selection; the stacked branch
now requests latest resolution and checks the supported runtime before installation.
The stacked PR must report its own final remote CI result.

## Reliability scope decision — October 25, 2026

Historical Photon catch-up is deferred. The owner accepts missed inbound messages
during disconnects; owner-scoped history verification is no longer a V1 launch
blocker. Basic future-only live reconnection and token renewal now have
[SDK and host wiring](photon-live.md) tested locally; production activation and
real-provider acceptance remain outstanding. Existing catch-up code/fixtures are retained as
optional future work. MCP replay and durable handling of admitted requests remain
in scope; this does not authorize uncertain outbound retries or repeated Athena
actions. The [controller coupling](photon-recovery.md#future-only-reconnect-design-coupling)
explains why the new live implementation uses a separate controller.

## Remaining V1 work

The local components are implemented. Remaining work is production integration,
operational setup and explicitly approved live acceptance:

1. **Accept the local MCP replay implementation.** Durable cursor replay now exists
   for retained message events, including conservative acknowledgment positions,
   refresh races and restore truncation. Complete live ChatGPT acceptance and
   choose retention before launch; see [the contract](event-replay.md).
2. **Accept the future-only Photon integration with the real provider.** The new
   [live controller, SDK adapter and host factory](photon-live.md) implement exact-DM
   subscription, fresh token acquisition/rebinding, bounded reconnect and safe
   shutdown/pause/expiry under fixtures. No history calls or sequence completeness
   are required. New messages can resume after reconnect; the offline interval may
   be lost. Verify this behavior with the real pinned SDK/account before launch.
   The historical catch-up controller remains separate and deferred. Admitted
   requests retain durable deduplication and conservative unknown-send handling.
3. **Integrate the host into a production deployment and activation policy.** The
   explicit local host factory now composes OAuth, messages and the Photon lifecycle.
   The production listener and config loader now exist; select that command in the
   chosen deployment and provision private storage, trusted secrets and monitoring.
   Decide and implement the ongoing activation policy; do not automatically extend
   the current one-hour limit. An Auth0-bound message database cannot be reopened under a Google `sub`:
   design and implement an operator-reviewed identity migration if such state
   must be retained. No migration command exists today.
4. **Accept CI on the published change.** The workflow is implemented. Confirm
   both supported Node jobs pass on the PR commit and configure required checks
   under repository policy if desired. CI uses fixtures, never real credentials.
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
7. **Run integrated reliability and recovery drills.** Repeat the covered local
   scenarios in the chosen host and bounded authorized provider/ChatGPT tests:
   interruption during persistence/callback/claim/send, duplicate/out-of-order
   delivery, expiry/renewal, unknown-send reconciliation, pause/resume and fenced
   backup restoration. Confirm new messages resume after reconnect without promising
   offline recovery. Verify continuity with the existing Athena and the Mac off.
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
