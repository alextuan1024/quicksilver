# Render preparation — disabled by default

This is local preparation, not a provisioned or live-ready service. The reviewed
[Blueprint](../deploy/render.yaml) creates paid resources and an initial disabled
deployment **if applied**. It has not been applied. Auto-deploy being off prevents
later Git-triggered deploys, not the initial creation/deploy.

## Proposed configuration

| Choice | Prepared value | Remaining decision |
| --- | --- | --- |
| Workspace | Fresh Hobby workspace | Creation and paid-resource authorization; do not select an existing workspace implicitly |
| Compute | `0.5c-512mb` (current name for Starter), one process | Confirm current price; the discussed $8.25/month compute plus disk estimate is not a spending authorization or guaranteed total |
| Region | `singapore` | Confirm before creation; region is immutable |
| Disk | 5 GB mounted at `/var/data` | Confirm billing and backup destination/escrow |
| Runtime/build | Node `22.23.4`, `npm ci --omit=dev` | Reverify supported Node 22 and dependency checks at deployment |
| Initial command | `node render-bootstrap.mjs --disabled` | Only this inert command is prepared for initial setup |
| Binding/health | `0.0.0.0:10000`, `PORT=10000`, `GET /livez` | Verify through Render after separately approved setup |
| Automation | `autoDeployTrigger: off`, previews off, branch `main` | Merge the milestone before any approved initial deployment; keep subsequent deploys manual |

The bootstrap imports only Node built-ins, reads no application configuration,
opens no storage and creates no provider clients. Exact `GET /livez` returns fixed
disabled health; every other route returns 503. There is no environment switch
from bootstrap to live mode. SIGTERM/SIGINT drain it and close stalled sockets.

## TLS and proxy trust: unresolved live gate

Official Render documentation says public HTTPS terminates at its load balancer,
then forwards HTTP to the application port, which is not directly public. It also
allows private connections from other services in the same workspace and region.
A fresh single-service workspace reduces exposure but does not establish a
request's provenance. Render's Express example recommends `trust proxy: 1`;
that does not document exclusive ingress addresses or which incoming forwarding
headers are removed or overwritten.

No verified proxy address list or header-normalization guarantee was established
from these sources. **Do not activate the live host on Render until this boundary
is established.** An observed source IP, private subnet, hop count or copied
`X-Forwarded-Proto` value is insufficient. Obtain an authoritative exclusive peer
and header contract (including address changes and private callers), or redesign
around an independently authenticated ingress. The code does not guess this data.

The optional production listener shape is:

```json
{
  "mode": "render",
  "host": "0.0.0.0",
  "port": 10000,
  "trustedProxyAddresses": ["REPLACE_ONLY_WITH_VERIFIED_EXCLUSIVE_PROXY_IP"]
}
```

This deliberately invalid placeholder is not usable configuration. Empty lists,
wildcards, CIDRs, names, duplicate/unspecified addresses and TLS-file fields are
rejected. The production CLI requires explicit `PORT` matching the config before
opening storage. Requests must come from an exact allowlisted socket peer, have
exactly one pinned issuer Host and one `X-Forwarded-Proto: https`, and contain no
`Forwarded` or `X-Forwarded-Host`, including empty/duplicate variants. IPv4-mapped
IPv6 is normalized. X-Forwarded-For is removed before application handling.
Headers alone cannot grant peer trust. Issuer/resource, HTTPS OAuth redirects,
secure cookies, owner/client binding and browser-origin checks remain enforced.

Only exact `GET /livez` bypasses that boundary, returning fixed process liveness
without invoking OAuth or the message host. It reveals no provider/storage state.
It stays healthy when paused, expired or disconnected: use `/healthz` through the
trusted boundary and operator transport monitoring for application acceptance.
The shutdown fence runs before liveness. Liveness never authorizes activation.

## Storage, shutdown and activation

After separate setup authorization, use a service-owned mode-0700 directory
`/var/data/quicksilver`, with distinct `oauth.sqlite` and `messages.sqlite` files.
Use a service-owned mode-0600 regular, singly linked
`/var/data/quicksilver/production-config.local.json`. Secret delivery must satisfy
the existing private-file checks; a platform secret mount is not assumed to have
the required ownership/mode. Do not put keys in the Blueprint, Git, logs or an
automatic generator. No directories, credentials or keys were provisioned here.

Render disks require a single instance and prevent zero-downtime deploys. Render
documents a **fixed 30-second shutdown delay** for disk-backed services; the
generic recommendation to allow 60 seconds cannot be configured here. Keep the
default 5-second send timeout. HTTP drains for up to 10 seconds; Photon operations
are bounded, but stalled DNS or the runtime can still cause forced termination.
Local tests cover interruption and uncertain-send recovery, not a guarantee of
graceful completion on Render. Verify actual shutdown/restart within its deadline
before live acceptance. Forced termination must recover durable claims and hold
unknown sends for reconciliation, never retry them automatically. Do not add an
unsupported `maxShutdownDelaySeconds` override to this disk-backed template.

Use encrypted application message backups and separately escrow keys. Platform
disk snapshots do not replace the application's fenced restore procedure or
OAuth recovery plan. Never run an old and restored host together.

After the ingress gate and all [required identity values](deploy-readiness.md)
are verified, live selection is a separate approved command change to
`node production-server.mjs --config /var/data/quicksilver/production-config.local.json --activate`.
It still requires a fixed approved deadline no more than one hour ahead. Ordinary
restarts retain that deadline, stored keys, pause and uncertain-send holds. No
supervisor may roll the deadline forward. Historical catch-up remains deferred.

## Smallest remaining setup and acceptance steps

1. Approve fresh workspace/service/disk creation, current price/budget and region.
   After merge, provision only the disabled template and verify health, runtime,
   disk persistence, private ownership and process termination.
2. Establish the exclusive proxy-peer and forwarding-header contract, or choose
   another authenticated ingress topology. Until then keep the live host disabled.
3. Record the actual HTTPS hostname/issuer, exact MCP client/callbacks, Google
   client and owner subject, RSA/cookie keys, Photon owner/line/secret, backup
   escrow and monitoring ownership. Decide whether existing Auth0 state matters.
4. Separately approve live credentials/grants and an exact one-hour-or-shorter
   recipient/window. Verify public discovery, PKCE/Google login, refresh/revoke,
   owner filtering, callbacks, pause, expiry, future-only reconnect and forced
   restart/recovery. Confirm delivery independently of provider acceptance.
5. Keep ongoing activation beyond one hour blocked pending its policy decision
   and implementation. Retention/migration rules remain separate decisions.

## Source evidence and verification limits

Read on October 27, 2026:

- [Web services: port binding and TLS termination](https://render.com/docs/web-services)
- [TLS and HTTP redirects](https://render.com/docs/tls)
- [Private networking and same-workspace reachability](https://render.com/docs/private-network)
- [Health-check Host and response behavior](https://render.com/docs/health-checks)
- [Authentication example and proxy recommendation](https://render.com/articles/how-to-implement-authentication-and-authorization)
- [Default PORT/environment variables](https://render.com/docs/environment-variables)
- [Compute plan naming](https://render.com/docs/compute-plans)
- [Persistent disks, shutdown limits and backup caveats](https://render.com/docs/disks)
- [Blueprint specification](https://render.com/docs/blueprint-spec) and
  [official JSON Schema](https://render.com/schema/render.yaml.json)

The Blueprint validates against the fetched official schema locally. Fixture
tests exercise real OAuth/MCP HTTP through the Render guard, secure callbacks and
cookies, refresh/revocation, owner filtering, future-only reconnect/replay,
spoofed/duplicate headers, untrusted socket peers, persistent pause/restart,
disabled startup and shutdown. They do not verify Render's ingress or live
Google/Photon/ChatGPT compatibility. No infrastructure or runtime settings changed.
