# quicksilver V1: Scope and launch decisions

[Design overview](../design-v1.md) · Design checkpoint: October 23, 2026.

## Scope and acceptance

V1 supports general owner text, request-bound progress and delayed results, and continuity with this Athena. Exclude unsolicited iMessages, standalone reminders, groups, media and arbitrary recipients. Existing action-confirmation rules still apply; authenticated message content is not a system instruction.

## Reliability decision — October 25, 2026

The owner accepts that inbound messages sent during a Photon disconnect may be
missed. Historical Photon catch-up is deferred, and verifying history access or
retention is no longer a V1 launch blocker. Keep basic reconnection and token
renewal so new live messages can resume. [The SDK/host wiring](../photon-live.md)
is implemented under fixtures; real-provider acceptance remains outstanding. Reconnect does not promise recovery of the offline interval.

Requests already admitted to durable storage retain MCP replay, deduplication,
claim/reply ordering and recovery controls. This decision never permits retrying
an uncertain outbound send, treating a timeout as failure, or repeating Athena
actions. The existing catch-up controller/tests are retained for optional future
work; they are not a completed future-only adapter.

Before launch, test:

- Owner rejection, scope checks and OAuth renewal/revocation.

- General exchanges and context continuity with the Mac off.

- Duplicate and out-of-order events without duplicate actions or replies.

- Restart during persistence, webhook delivery, claiming and sending.

- Subscription renewal and future-only Photon reconnect/token renewal; new live
  messages resume while missed offline messages are explicitly not promised.

- Unknown-send reconciliation, pause behavior and backup restoration.

## Completed local scope and remaining implementation

PRs #1 and #2 are merged: durable request/claim/reply state, ordered outboxes,
pause and operator recovery, encrypted message backups and paused restoration,
local OAuth with persistent grants, and the known dependency fixes. The merged
suite passed 143 tests on Node 22.23.4; fixtures do not prove live acceptance.
OAuth library selection is complete (`oidc-provider` / `openid-client`).

Locally implemented next-stage components: [MCP replay cursors](../event-replay.md)
and an optional [generic catch-up controller](../photon-recovery.md), retained with
its fixtures for deferred work. [Future-only live SDK/host composition](../photon-live.md)
is now implemented and locally tested at `abf36788759773272fa64b702ec93fe376b704d7`
in merged PR #4: 200 full-suite tests and 41 independent targeted
tests passed, with no actionable review findings. The next branch adds the
[production listener/configuration](../production-host.md) and CI. Still unfinished
for V1: deployment/provisioning and any ongoing activation policy; real-provider acceptance;
and any required Auth0-to-Google message-store identity migration. The one-hour activation limit
remains. OAuth snapshot restoration is not implemented: message recovery requires
a fresh OAuth database and owner reconnection after fencing the old host.

## Decisions and gates before launch

- Hosting provider, monthly ceiling, private persistent volume and encrypted backup
  destination. A small always-on server is selected in principle; no purchase is authorized.
- Content, deduplication, revocation-tombstone and backup retention/deletion policies;
  backup key provisioning, separate escrow and rotation responsibilities.
- Real Google web-client credentials, exact redirects, verified owner subject,
  persistent signing/cookie keys and ChatGPT public-client compatibility.
- Owner-scoped live subscription, reconnect and credential-renewal behavior for
  the pinned SDK and actual line. Verify any send lookup/idempotency capability
  before relying on it; uncertain sends otherwise remain under operator review.
  Historical replay scope/retention is deferred, not a launch prerequisite.
- Confirm the configured CI passes for the published production-entrypoint commit;
  it covers supported Node tests, secret/dependency checks and documentation validation.
- Interruption, duplicate/out-of-order, OAuth renewal/revocation and fenced restore
  drills in the integrated host, followed by explicit owner-approved bounded live
  acceptance and a controlled launch with pause/rollback and monitoring.

The [ordered roadmap](../status.md#remaining-v1-work) separates implementation,
operational choices and acceptance. Media, groups, unsolicited messages and
arbitrary recipients remain excluded.

Render Free is unsuitable for the proposed local durable store because its filesystem is ephemeral and persistent disks are unavailable. [Render limits](https://render.com/docs/free)
