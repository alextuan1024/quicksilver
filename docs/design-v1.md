# quicksilver V1 Design

Design checkpoint: October 23, 2026. Build an owner-only, general-text iMessage channel into the existing Athena, independent of the owner’s Mac. Use one small always-on server with durable storage. Implementation is deferred; provider, budget and purchases remain undecided.

## Proven baseline

The October 15 proof completed one fixed-text exchange through Photon, quicksilver and the existing Athena, with owner-confirmed receipt. It was then parked with messaging and the temporary automation disabled. The proof used Render Free, Auth0 and in-memory state; it did not establish general conversation or durable recovery. [Proof record](https://github.com/alextuan1024/quicksilver/blob/main/PHOTON_TEST.md)

## Design documents

Read the following documents in order for the complete V1 design. The sections retain the October 23, 2026 design checkpoint.

- [Architecture and authentication](design-v1/architecture-and-authentication.md) — Deployment topology, durable storage, and OAuth requirements.
- [Message handling and state](design-v1/message-handling.md) — Inbound requests, request-bound replies, and failure rules.
- [Recovery and operations](design-v1/recovery-and-operations.md) — Subscriptions, Photon catch-up, monitoring, and backups.
- [Scope and launch decisions](design-v1/scope-and-decisions.md) — V1 boundaries, acceptance checks, and decisions before implementation.
