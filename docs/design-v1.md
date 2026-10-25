# quicksilver V1 Design

Design checkpoint: October 23, 2026; implementation status updated October 25, 2026.
Build an owner-only, general-text iMessage channel into the existing Athena,
independent of the owner’s Mac, using one small always-on server with durable storage.
Durable messaging/recovery and local OAuth/dependency remediation are merged in
PRs #1 and #2. Production host integration, future-only reconnect/renewal and live acceptance
remain unfinished; provider, budget and purchases remain undecided.

See [current progress and remaining V1 work](status.md) for merge evidence, the
Node >=22.23.4 <23 requirement and the distinction between tested local modules
and a launched service. [Future-only Photon SDK/host wiring](photon-live.md) is
implemented under local fixtures; the default runtime remains parked. The October 25 scope decision defers historical Photon
catch-up: missed inbound messages during disconnects are tolerable. MCP replay
and durable processing of already admitted requests remain in V1; see
[scope and acceptance](design-v1/scope-and-decisions.md).

## Proven baseline

The October 15 proof completed one fixed-text exchange through Photon, quicksilver and the existing Athena, with owner-confirmed receipt. It was then parked with messaging and the temporary automation disabled. The proof used Render Free, Auth0 and in-memory state; it did not establish general conversation or durable recovery. [Proof record](https://github.com/alextuan1024/quicksilver/blob/main/PHOTON_TEST.md)

## Design documents

Read the following documents in order for the complete V1 design. The sections retain the October 23, 2026 design checkpoint.

- [Architecture and authentication](design-v1/architecture-and-authentication.md) — Deployment topology, durable storage, and OAuth requirements.
- [Message handling and state](design-v1/message-handling.md) — Inbound requests, request-bound replies, and failure rules.
- [Recovery and operations](design-v1/recovery-and-operations.md) — Subscriptions, future-only reconnect, deferred catch-up, monitoring, and backups.
- [Scope and launch decisions](design-v1/scope-and-decisions.md) — V1 boundaries, acceptance checks, and remaining implementation, operational decisions and launch acceptance.
