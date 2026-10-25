# Progress and remaining V1 work — October 26, 2026

## Verified repository baseline

The durable-message and OAuth implementation PRs, plus docs PR #3, are merged
into the private `alextuan1024/quicksilver` repository. The local feature branch
starts from their verified main baseline,
`da058749aebc1bbb6d18c3759106d45488448d81`:

| Work | Implementation head | Merged result |
| --- | --- | --- |
| Durable messaging and recovery | `78c4ce75f7e4d47ca860546676bab7a52d89cd7e` | [PR #1](https://github.com/alextuan1024/quicksilver/pull/1), merge `5f7c2140f0be1329fba4b9bafd8e71e952f21650` |
| Local OAuth and dependency remediation | `9f7de7ada3a8c45a738a212dcb58470687471f01` | [PR #2](https://github.com/alextuan1024/quicksilver/pull/2), merge `b064f20c5edd01ac229ef00687bdb548294e58fa` |
| Progress documentation | `907f25610c27f15685e5d0e42ef8313331909554` | [PR #3](https://github.com/alextuan1024/quicksilver/pull/3), merge `da058749aebc1bbb6d18c3759106d45488448d81` |

Merge metadata was verified before feature work; this progress update rechecks
the local commits and recorded verification results without fetching remote state. The declared runtime is **Node >=22.23.4 <23**, not Node 22.13 or 24.
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

## Latest local implementation and verification

The unpushed branch `feat/durable-replay-and-reconnect` contains:

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

These results belong to the implementation commit above; this documentation-only
update does not rerun application tests or claim live acceptance. The branch has
not been pushed or submitted as a PR, and no remote CI ran for these local commits.
See [the live host contract](photon-live.md), [MCP replay](event-replay.md), and the
[implementation/verification record](superpowers/plans/2026-10-25-future-live.md).
The optional [historical catch-up controller](photon-recovery.md) is preserved but
is not a V1 launch requirement.

## Production integration is unfinished

`server.mjs` still constructs `runtime.mjs`, whose Auth0 configuration selects the
bounded in-memory proof. It does not select `messageHandling` or
`createLocalMessageService` / `createPhotonMessageHost`. The new host factory
requires trusted configuration and explicit `start()`;
no environment variable activates it. The one-hour message activation ceiling
also remains in the new composition. Merging the modules did not switch or deploy
the runtime.

The last recorded live success is the [October 15 fixed-text proof](../PHOTON_TEST.md),
followed by shutdown/disabled configuration. It does not establish ongoing general
conversation, durable recovery or the local Google OAuth flow. This update did
not inspect the current hosted service, real credentials or provider accounts.

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
   Supply the production HTTP/TLS listener, private storage, trusted configuration
   and monitoring; the default server still selects the parked proof. Decide and
   implement the
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
