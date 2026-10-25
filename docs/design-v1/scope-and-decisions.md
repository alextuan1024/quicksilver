# quicksilver V1: Scope and launch decisions

[Design overview](../design-v1.md) · Design checkpoint: October 23, 2026.

## Scope and acceptance

V1 supports general owner text, request-bound progress and delayed results, and continuity with this Athena. Exclude unsolicited iMessages, standalone reminders, groups, media and arbitrary recipients. Existing action-confirmation rules still apply; authenticated message content is not a system instruction.

Before launch, test:

- Owner rejection, scope checks and OAuth renewal/revocation.

- General exchanges and context continuity with the Mac off.

- Duplicate and out-of-order events without duplicate actions or replies.

- Restart during persistence, webhook delivery, claiming and sending.

- Subscription renewal, Photon catch-up and explicitly reported recovery gaps.

- Unknown-send reconciliation, pause behavior and backup restoration.

## Completed local scope and remaining implementation

PRs #1 and #2 are merged: durable request/claim/reply state, ordered outboxes,
pause and operator recovery, encrypted message backups and paused restoration,
local OAuth with persistent grants, and the known dependency fixes. The merged
suite passed 143 tests on Node 22.23.4; fixtures do not prove live acceptance.
OAuth library selection is complete (`oidc-provider` / `openid-client`).

Still unimplemented: MCP replay cursors; Photon reconnect/catch-up/token-renewal
host integration; production host wiring and activation policy; and any required
Auth0-to-Google message-store identity migration. The one-hour activation limit
remains. OAuth snapshot restoration is not implemented: message recovery requires
a fresh OAuth database and owner reconnection after fencing the old host.

## Decisions and gates before launch

- Hosting provider, monthly ceiling, private persistent volume and encrypted backup
  destination. A small always-on server is selected in principle; no purchase is authorized.
- Content, deduplication, revocation-tombstone and backup retention/deletion policies;
  backup key provisioning, separate escrow and rotation responsibilities.
- Real Google web-client credentials, exact redirects, verified owner subject,
  persistent signing/cookie keys and ChatGPT public-client compatibility.
- Owner-scoped Photon replay/cursor retention and send lookup/idempotency semantics
  for the pinned SDK and actual line; do not infer those guarantees from fixtures.
- CI for supported Node tests, secret/dependency checks and documentation validation;
  no GitHub Actions workflow is currently configured.
- Interruption, duplicate/out-of-order, OAuth renewal/revocation and fenced restore
  drills in the integrated host, followed by explicit owner-approved bounded live
  acceptance and a controlled launch with pause/rollback and monitoring.

The [ordered roadmap](../status.md#remaining-v1-work) separates implementation,
operational choices and acceptance. Media, groups, unsolicited messages and
arbitrary recipients remain excluded.

Render Free is unsuitable for the proposed local durable store because its filesystem is ephemeral and persistent disks are unavailable. [Render limits](https://render.com/docs/free)
