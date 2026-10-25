# Durable Message Handling Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Implement the owner-only general-text message pipeline without activating or deploying it.

**Architecture:** A SQLite store owns atomic inbound admission, independent event/execution states, claims and ordered reply attempts. An optional message service uses the existing OAuth and signed-callback bridge, with a trusted Photon SDK client for sending and a native-event ingestion method. The default proof runtime remains unchanged.

**Tech Stack:** Node.js 22.13+, built-in SQLite, existing jose and Photon SDK.

**Spec:** ../../design-v1/message-handling.md

## Global constraints

- Exact configured owner and DM only; no arbitrary recipients, media, groups or echoes.
- Persist before external calls; duplicate IDs cannot repeat execution or sending.
- Unknown sends and interrupted claims stall; no automatic rerun of Athena actions.
- OAuth replacement, verified Photon replay, hosting and backup recovery belong to the sibling designs.
- One process owns the database. Local SQLite contains private content; restrict file permissions.

## Review focus

- A claim can arrive before the webhook acknowledgment or after its loss.
- A changed payload using an existing response ID must be rejected.
- A final reply must not overtake pending or uncertain progress replies.
- Restart between send and result persistence must not cause another send.
- Switching owner, OAuth client or route must not expose an existing database.

## Task 1: Durable state and outboxes

Files: `message-store.mjs`, `message-store.test.mjs`.

- [x] Write and run failing tests for atomic admission/checkpoints, reopen deduplication, independent claims, ordered final closure, interrupted attempts and pinned database identity.
- [x] Implement `openMessageStore({path,identity,now})` with SQLite transactions, `accept`, `claim`, `enqueueReply`, event/reply reservation and settlement, `recover`, `status`, and durable private records.
- [x] Verify with `node --test message-store.test.mjs`.

## Task 2: Owner transport and authenticated MCP integration

Files: `messages.mjs`, `message-service.mjs`, `message-service.test.mjs`; modify `bridge.mjs`, `oauth.mjs`, `service.mjs`.

- [x] Write and run failing tests for native Photon input rejection, arbitrary general text, authenticated claim/reply tools, stable signed event retry, pinned reply destination, progress/final ordering, unknown sends and restart recovery.
- [x] Implement `createMessageService(config)` behind explicit `config.messageHandling`, with `receive(event,checkpoint)`, `flush()`, `handle(...)` and `stop()`; reuse existing callback validation and OAuth owner/client checks with the dedicated `quicksilver:messages` scope.
- [x] Persist subscriptions and use stored event IDs/timestamps on retries. Keep OAuth grants with the existing external issuer; local OAuth replacement is deferred.
- [x] Verify with `node --test message-store.test.mjs message-service.test.mjs` and the existing suite.

## Task 3: Documentation and verification

Files: `README.md`, `docs/design-v1/message-handling.md`, `package.json`, `.gitignore`.

- [x] Document composition, Node minimum, state semantics, retry limits, unknown-send reconciliation and remaining launch gates.
- [x] Run the complete test suite and secret-pattern scan; obtain an independent final review and fix substantive findings with regression tests.

## Implementation decisions

- The implementation request authorizes this design's local implementation; no additional design-approval pause is needed.
- Use native execution in the existing `work` branch and preserve the earlier documentation edits.
- Persist each accepted event's opaque provider checkpoint, without claiming it is a safe replay watermark. Replay semantics remain unverified.
- A final reply closes admission atomically when queued; delivery state remains independent.
- No automatic resend follows an unknown result. Only verified lookup can mark acceptance; an explicit local owner-verification operation may permit retry.


## Completion record

- Task 1: complete. Durable state tests failed before implementation, then passed; exclusive-lock regression failed before its fix. A SIGKILL test confirms uncertain send persistence.
- Task 2: complete. Eight message service tests failed before integration, then passed. Existing proof tests remain passing.
- Task 3: complete. Node 22.13 full suite: 103 passed. Secret-pattern scan and diff whitespace checks passed.
- Independent review found one P2: send reconciliation hid an execution-interruption warning. Three regression cases failed before the fix; execution interruption now persists independently and the full suite passes.
- Scope rulings: existing runtime activation, host SDK configuration, OAuth replacement, verified replay, durable pause, backup restoration and live-provider idempotency remain sibling-design work. This leaves a tested local component, not a production launch; the README states the required host contract and remaining gates.
- No deployment, provider calls, live iMessages, purchases or external configuration changes were performed.
