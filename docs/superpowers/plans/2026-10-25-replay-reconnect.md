# Durable replay and reconnect implementation plan

**Goal:** Resume owner events safely after subscription/transport interruptions.
**Architecture:** durable MCP replay in the message store; separate opt-in Photon
controller behind a verified owner-scoped adapter. No default runtime changes.
**Tech stack:** Node >=22.23.4 <23, existing SQLite and pinned SDK dependencies.
**Spec:** [Replay/reconnect design](../specs/2026-10-25-replay-reconnect-design.md).

The user explicitly authorized implementation of this roadmap step. Native
implementation plus a delegated provider module and independent final review
preserve that requested execution; no additional approval/publication is implied.

## Tasks

- [x] Add failing MCP tests for durable cursors, pending delivery holes, invalid
  cursors, refresh races, deduplicated claims and restore truncation. Run them.
- [x] Add message-replay.mjs; integrate store/bridge/service with atomic subscription
  refresh and generation-fenced settlements. New operator redispatch appends a
  sequence; restore invalidates prior cursor epoch. Run affected tests.
- [x] Research pinned Photon APIs/current official docs. Add failing lifecycle and
  process interruption tests, then scoped adapter controller and checkpoint store.
  Do not call raw unscoped catch-up or broaden owner access.
- [x] Integrate explicit local composition and document exact adapter contract,
  limits and remaining provider proof. Review expiry/pause/restore boundaries.
- [x] Obtain independent security, replay/deduplication and crash-boundary review;
  fix findings with regressions, run full suite, audit, scan and diff checks.
- [x] Commit completed local work on feat/durable-replay-and-reconnect. No push/PR.

## Review focus

- A later delivery cannot advance past earlier pending/stalled work.
- Subscription replacement cannot let an old callback erase new replay work.
- Restored snapshots cannot reuse stale cursors/checkpoints to resume unsafe work.
- Provider scope/sequence assumptions fail closed; filtered sequences may have gaps.
- Expiry, pause, shutdown and auth failure fence delayed asynchronous completions.


## Local completion record — October 25, 2026

- Base: `da058749aebc1bbb6d18c3759106d45488448d81`; branch:
  `feat/durable-replay-and-reconnect`. PRs #1, #2 and #3 are verified ancestors
  and PR #3's merge metadata was rechecked. Prior branches are preserved.
- MCP store regressions first failed 6/6 for absent replay, then passed. Four
  service integration regressions first failed, then passed. Added SIGKILL
  coverage for retained cursor/event/claim state.
- Provider controller/store fixtures and process tests: 19/19 passed, including
  a crash between committed intake and checkpoint, while a send is uncertain.
- Independent review found four issues: malformed foreign cursor authentication,
  deferred live-reader startup, uncancelled retry timers, and heartbeat-masked
  missing-sequence gaps. Each was fixed with a failing-then-passing regression.
  The reviewer rechecked final source and passed 46/46 targeted tests, with no
  outstanding findings within the documented local contract.
- Full `npm exec --yes --package=node@22.23.4 -- npm test`: **173/173 passed**,
  zero failures/skips. `node@22` also resolves to 22.23.4; the declared supported
  floor/current Node 22 release is the same. SQLite's experimental warning is expected.
- Fresh full and production `npm audit` results: zero known vulnerabilities.
  `npm ls --all` succeeds. `node scan.mjs` passes 50 root source files.
- Documentation link/fence and recursive changed-file secret checks pass;
  `git diff --check` passes. Runtime, server, original Photon transport, manifest
  and lockfile are unchanged from main. No dependencies were installed/updated
  in this implementation stage beyond using the existing Node tooling.
- Work is committed locally only. No push, PR, merge, deployment, provider reads,
  real credentials/grants, purchases, hosting or CI changes.

## Precise remaining gap

[MCP replay](../../event-replay.md) and the generic [recovery controller](../../photon-recovery.md)
are implemented locally. **The production Photon adapter and actual SDK token
mint/rebind/reconnect integration are not implemented.** The inspected catch-up
request has only `afterSequence`, without a conversation filter. Provider token
history isolation is unresolved; cross-user visibility has not been demonstrated.
No broad history was read or filtered. A verified server-side owner-scoped replay
contract or isolated owner-only transport, then adapter implementation/review and
bounded live acceptance, is required. Production wiring/activation, real identity
setup/migration, retention/backup choices, and Google/ChatGPT acceptance remain gates.
