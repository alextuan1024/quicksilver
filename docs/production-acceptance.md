# Integrated production acceptance drill

The fixture-only drill in `production-acceptance.test.mjs` runs the real production
listener and composed OAuth/message/Photon host in child processes. Browser OAuth
and MCP calls cross HTTP sockets; message/OAuth state uses real private SQLite
files. The callback receiver checks the generated HMAC, event ID, subscription
header and minimal event payload before responding.

Run it with the supported Node version:

```sh
node --test production-acceptance.test.mjs
```

The full `npm test` suite and CI include it automatically. The fixture process
loads an actual private production JSON config, then installs trusted test-only
Google fetch, Photon SDK and callback destination seams. No production config
can select those seams. The child inherits only PATH, rejects unexpected global
fetch, and maps the allowlisted synthetic callback to a loopback receiver.
Synthetic Google assertions and signing responses use IPC to the existing OAuth
fixture; no Google account, Photon account or real ChatGPT connector is contacted.

## Acceptance cases

| Case | Real composition exercised | Required observations |
| --- | --- | --- |
| OAuth, future-only reconnect and MCP replay | Browser redirect/cookie/PKCE flow, Google ID-token validation, production HTTP discovery/tools/events, real adapter/controller and persistent grants | Wrong owner rejected; only owner plain text admitted; exact-DM subscription and retry-disabled client; duplicate native IDs suppressed; a new sequence-gap event accepted after reconnect without history reads; same event IDs/cursors replay after process restart; duplicate claim never reacquires; refresh-token reuse revokes the rotated family; explicit revocation survives restart. |
| Hard interruption after claim and during send | Held signed callback over HTTP, HTTP claim/reply, running message worker, two actual SIGKILL events and reopened durable databases | In-flight callback replays with the same event ID; claimed work stays claimed/interrupted; a reserved send becomes unknown after restart; same reply ID never retries through reconnect/restart; an independent fresh request sends successfully, proving that no-retry assertions are not merely observing a stopped worker. |
| Pause and fenced backup restoration | Persistent operator pause, clean production shutdown, encrypted message backup, source-process exit, restored message DB plus fresh OAuth DB, real HTTP reconnection | Pause survives restart with no Photon subscription; old process is dead before restore; old OAuth token fails; owner must log in again; restore holds block resume/completion; old cursor reports truncation; a reply sent only after snapshot remains unknown when its missing ID is retried; old intake boundary stalls safely; a new post-boundary request sends successfully. |

All owner operations go through authenticated MCP HTTP. The trusted local IPC
commands are limited to synthetic provider delivery/disconnect, status, send fault
selection and existing operator pause/backup/reconciliation controls. They do not
seed database rows or directly acquire claims/replies. The fixture observes send
invocation only after the worker's durable reservation. It never interprets that
observation as recipient delivery.

## Existing coverage deliberately reused

The original suites already cover actual pinned SDK loopback RPC construction,
credential renewal, timeout/cancellation, OAuth protocol permutations, cursor
forgery/refresh races, encrypted-backup tampering and operator permission checks.
This drill adds their deployment-facing composition across process boundaries;
it does not duplicate every unit case. PR #5's production tests separately cover
direct verified TLS, invalid proxy headers, failed bind, interrupted startup,
stalled connections and actual SIGTERM/SIGINT behavior.

The OAuth browser helper's optional `addressOf` callback points it at an existing
production listener. Its default local HTTP behavior remains unchanged for prior
component tests. The drill child and IPC interfaces are test-support files only;
no runtime, transport, dependency or activation-policy change is part of this stage.

## Limits and remaining acceptance

This establishes fixture evidence, not live Google/Photon/ChatGPT compatibility,
recipient delivery, provider recovery lookup semantics or correctness of an actual
host/proxy/storage deployment. The backup drill assumes the verified synthetic
source can be fenced; it is not an automatic distributed fencing implementation.
Old-token rejection demonstrates fresh-database isolation, not revocation of the
source OAuth database. This drill calls `startProductionServer`; CLI activation
and direct TLS remain covered separately by the production-entrypoint tests.
Public callback DNS/TLS transport is not exercised by the mapped loopback receiver.
Unknown sends still require operator evidence. Historical catch-up remains
deferred, and the one-hour activation policy is unchanged.

The next necessary gates are the real configuration/operational choices and
explicitly authorized provider/client acceptance listed in the
[deployment readiness checklist](deploy-readiness.md). A read-only configuration
preflight is a possible local follow-up; retention deletion, identity migration
and activation beyond one hour need their underlying policy decisions first.


## Verification — October 27, 2026

- Full suite: **213/213 passed** on Node 22.23.4, including all three integrated
  scenarios and the prior 210 tests.
- Independent test-validity/integration review: **3/3 passed**, no actionable
  findings. Reviewed crash timing, persisted state, restore fencing and positive
  post-recovery sends that prevent vacuous no-retry assertions.
- Recursive source scan: 88 files. Documentation checks: 26 Markdown files and
  106 local links/anchors. Dependency tree, full/production audits and whitespace
  checks passed; audits reported zero known vulnerabilities.
- These are local results. Inspect the stacked draft PR's exact head for remote CI.
  PR #5 is preserved; this stage adds tests, test helpers and documentation only.
