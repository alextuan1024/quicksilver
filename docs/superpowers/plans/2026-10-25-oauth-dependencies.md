# OAuth dependency remediation and draft PR

Continue from `e1000a3d7db310e07ffdb40f31370280c2391953` on `feat/local-oauth`.
User authorized dependency fixes, verification, push and a draft OAuth PR in the
existing private `alextuan1024/quicksilver` repository. No live configuration,
credentials, deployment, messages, purchase, replay implementation or merge.

- [x] Recheck audit and dependency requirements; preserve the pinned messaging SDKs.
- [x] Add local compatibility coverage for Photon trace/log correlation, metrics export and normal SDK metadata HTTP fetching; run before and after updates.
- [x] Update Undici within its compatible 7.x range and override Photon’s five coupled OpenTelemetry 0.218 components to official patched 0.219.0 releases. Document why the override is needed and how to retire it.
- [x] Raise the declared Node 22 floor to tested 22.23.4 so native fetch also uses patched Undici 6.29.1; no deployed runtime changes.
- [x] Verify clean install, full tests on supported Node, fresh audit, complete dependency tree, secret scans and independent read-only review; resolve findings.
- [x] Update historical audit records with current remediation, commit, verify repository/PR #1 state, publish and verify draft PR and exact-commit CI.

Historical initial findings: the audit reported four advisories across 14 production entries.
Latest Photon telemetry 3.8.3 still pins the 0.218 family; upgrading the messaging
SDK does not remove that restriction. A scoped override retains Photon telemetry
3.8.1 and all messaging SDK versions while testing the 0.219 API boundary.

PR #1 was independently observed merged as `5f7c2140f0be1329fba4b9bafd8e71e952f21650`.
The fetched main tree equals predecessor `78c4ce7`, so target main without
repeating the prior-stage file changes. No merge is required for this branch.


## Local completion record

- Clean `npm ci --ignore-scripts --no-audit --no-fund` succeeded on Node22.23.4.
- Full suite: 143/143 passed. Independent reviewer: 28/28 targeted tests passed,
  dependency graph/API boundary and updated docs approved with no findings.
- Fresh production and full npm audits: zero vulnerabilities. npm ls --all exits0.
- One reviewer run overlapped node_modules replacement and failed resolution;
  the completed-install rerun passed. This was an install/test ordering issue.
- Application source is unchanged from the previously reviewed OAuth component.
  Changes are dependencies, declared runtime, compatibility tests and records.
- Published `9f7de7ada3a8c45a738a212dcb58470687471f01` as draft
  [PR #2](https://github.com/alextuan1024/quicksilver/pull/2) against main after
  verifying PR #1 was merged. Exact-commit checks/statuses/Actions runs were empty;
  no repository workflow was configured. The owner subsequently merged PR #2 as
  `b064f20c5edd01ac229ef00687bdb548294e58fa` on October 25. Both merge states were
  rechecked for the documentation update; see the [current roadmap](../../status.md).
