# Deployment readiness checklist

This checklist describes the production entry point in this branch. It is not an
activation, provisioning or deployment instruction. The repository supplies the
code and fixtures; actual host/account values below have not been provisioned or
verified in this stage. See [the production host contract](production-host.md)
for the exact JSON shape and command.

## Required decisions and values

| Configuration or decision | Required value/constraint | Current evidence or remaining input |
| --- | --- | --- |
| Hosting and budget | One always-on process; private persistent storage; an agreed monthly ceiling | Preferred: fresh Render Hobby workspace, Starter compute and 5 GB disk. Creation/spend is not authorized; see [prepared choices](render-preparation.md). |
| Runtime | Node >=22.23.4 <23 | Tested locally on 22.23.4; provision the supported version on the host. |
| Listener mode | Loopback `proxy`, direct `tls`, or fixed-external-origin `render` | Render uses port 10000, canonical issuer Host and application-owned HTTPS context; no ingress-IP allowlist or caller forwarding claims. |
| Public identity | Canonical root HTTPS `localOAuth.issuer`, and its exact `/mcp` resource | Actual hostname, DNS and issuer/resource values still need verification. |
| TLS/proxy | TLS cert/key paths for direct TLS; trusted proxy normalization for loopback; documented edge HTTPS and internal origin for Render | Confirm actual HTTPS/issuer routing during authorized setup. Render mode discards incoming forwarding headers and generates its fixed scheme locally. |
| Storage | Distinct absolute `localOAuth.databasePath` and `messageHandling.databasePath`; pre-existing private owned parent directories | Actual volume/mount/paths and single-process ownership must be chosen and verified. |
| Config/secrets | Private owned regular config file, mode 0600; private regular TLS files when used | Host secret delivery and access control are not provisioned. No automatic key generation or env fallback exists. |
| MCP client | Exact `clientId` and 1–4 registered HTTPS `redirectUris` | Obtain/verify the real ChatGPT client ID and callbacks; public client uses PKCE S256 and no client secret. |
| Google identity | Verified Google `ownerSubject` (`sub`), web-client ID/secret | Real owner binding and credentials not verified/provisioned here. Google callback is `<issuer>interaction/google/callback`. |
| OAuth persistence | Private RSA RS256 JWKS with unique key IDs and >=2048-bit keys; persistent cookie keys >=32 bytes | Keys, rotation overlap and escrow must be provisioned. Never regenerate automatically on restart. |
| Photon route | Project ID `77c7d003-2bf1-4638-b866-2e2ce16ab091`, verified owner E.164 address, line and exact `any;-;<ownerAddress>` DM | Project is pinned in code; actual owner/line/route and project secret need account verification. Example phone numbers are fixtures. |
| Activation | Explicit `--activate`; approved fixed ISO `expiresAt`, future and <=1 hour away | Choose an exact approved window later. Restart can reconnect only within the same deadline; no automatic extension. |
| Worker timing | Defaults: 1000 ms worker interval, 5000 ms send timeout | Retain defaults unless an operational reason is established. Disconnected replies stay queued; uncertain sends do not retry. |
| Retention | Content/events, deduplication, OAuth tombstones and backups | Policies and any resulting maintenance implementation remain undecided. Do not purge deduplication/claim evidence casually. |
| Backups/recovery | Destination, encryption key escrow/rotation, owner/operator and recovery objective | Provision separately; message backups exclude OAuth. Restore requires fencing, fresh OAuth storage and owner reconnection. |
| Monitoring | HTTP liveness plus transport state, expiry/stall detection, storage/backup health | `/healthz` alone does not prove Photon connection/delivery. Alert destination and integration remain to be chosen. |
| Existing Auth0 state | Determine whether old identity-bound message state must survive cutover | If yes, migration design/implementation and rollback are still required. Do not reopen it under a Google subject. |

## Safe defaults and boundaries

- `npm start` retains the parked proof. Production selection is explicit via
  `npm run start:production -- --config <absolute-private-file> --activate`.
- The production command rejects missing activation, expired/overlong deadlines,
  unsafe proxy binding, missing keys and invalid host/identity configuration.
- Persistent pause survives startup; ordinary startup does not clear it. Operator
  recovery remains separate from MCP tools. Expiry, a permanent stall or pause
  is not permission for a supervisor to rearm/extend activation.
- Historical Photon catch-up stays deferred. Inbound messages during an outage
  may be missed; admitted work remains durable and deduplicated. A timeout never
  proves an outbound send failed.
- SIGTERM/SIGINT fence the host and attempt to drain HTTP and close storage.
  Where supported, allow at least 60 seconds before forced termination; this is
  a recommendation, not a guarantee (callback DNS has no application deadline).
  Restart uses the original deadline.
  Render disks have a fixed 30-second limit; verify termination/recovery as described
  in [Render preparation](render-preparation.md#storage-shutdown-and-activation).
- CI uses local fixtures, read-only repository permissions and no real provider
  credentials. Passing CI does not prove live compatibility or deploy the service.

## Acceptance sequence

1. **Repository/local acceptance:** inspect the exact published head and both CI
   jobs. Review production configuration constraints and operator recovery docs.
   Use fixture-only startup, shutdown, restart, OAuth and recovery tests.
2. **Provisioning decision:** choose the outstanding topology/budget/retention and
   recovery responsibilities; provision host, storage, TLS and secrets in a
   separately authorized stage. Verify correct config ownership and one process.
3. **Identity/client acceptance:** with explicit live authorization, confirm Google
   owner `sub`, exact redirect/resource/scope, ChatGPT discovery, PKCE login,
   refresh rotation/reuse rejection and revocation. Resolve any required Auth0
   state migration and rollback before switching the deployment.
4. **Bounded provider acceptance:** approve exact recipient/route and fixed window,
   then verify actual Photon filtering, new messages after reconnect, renewal,
   duplicates, expiry, pause and uncertain-send behavior. Record recipient evidence;
   provider acceptance alone does not prove delivery.
5. **Integrated recovery drill:** exercise interruption around intake, callback,
   claim and send; verify no repeated Athena action or uncertain-send retry.
   Fence the old host before message restoration, retain holds, create fresh OAuth
   storage and reconnect the owner. Confirm Athena continuity with the Mac off.
6. **Controlled rollout:** approve activation with monitoring, pause/rollback
   criteria and a recorded end time. Ongoing operation beyond one hour requires
   a separate policy decision and implementation; this branch does not enable it.

## Next local work that does not require provisioning

The [integrated production acceptance drill](production-acceptance.md) now covers
real local OAuth/MCP HTTP, signed callbacks, process interruption around claims
and reserved sends, persistent pause and fenced backup/restore with fresh OAuth.
It uses synthetic providers only. This closes the previously identified gap
between individual component tests and the deployed listener composition.

A read-only config preflight command is another useful bounded follow-up, but it
must never open/migrate stores, contact providers or enable timers merely to
validate configuration. No retention deletion or identity migration should be
implemented until their required policy/keep-state decisions are settled.
