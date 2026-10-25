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

## Decisions before implementation

- Hosting provider, monthly ceiling, persistent volume and backup destination. A small always-on server is selected in principle; no purchase is authorized.

- OAuth library and ChatGPT client compatibility.

- Content retention, backup retention and deletion policy.

- Owner-scoped Photon replay, cursor semantics and retention.

- Send reconciliation/idempotency guarantees and stalled-request recovery.

Render Free is unsuitable for the proposed local durable store because its filesystem is ephemeral and persistent disks are unavailable. [Render limits](https://render.com/docs/free)
