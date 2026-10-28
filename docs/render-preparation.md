# Render preparation — disabled by default

This is local preparation, not a provisioned or activated service. The reviewed
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

## Fixed external HTTPS origin

Official Render documentation says public HTTPS terminates at its load balancer,
then forwards HTTP to the application port, which is not directly public. It also
allows private connections from other services in the same workspace and region.
A private caller is an untrusted client with the same authentication requirements
as a public caller. Network location is not an owner identity. The reviewed
design therefore does not need exclusive ingress IPs or authoritative incoming
forwarding headers. PR #7's exact-IP requirement was an unnecessarily restrictive
deployment assumption; the fixed-origin design replaces it.

`oidc-provider` documents TLS offloading as a normal deployment. Its Koa contexts
use the request scheme/host for some endpoint and interaction URLs, as well as
secure-cookie handling, even with a fixed issuer. Before every application
handler, the Render listener requires exactly one raw Host matching the canonical
configured issuer, removes `Forwarded`, all `X-Forwarded-*` and `X-Real-IP` from
both header representations, then inserts one application-owned
`X-Forwarded-Proto: https`. That value expresses the explicit deployment's fixed
external scheme; it is never copied from the request or used as authentication.
This covers contexts created by both the provider callback and interaction APIs.

The optional production listener shape is:

```json
{
  "mode": "render",
  "host": "0.0.0.0",
  "port": 10000
}
```

This is only the listener section, not a complete activation config. The production
CLI still requires explicit `PORT` matching the config before opening storage.
The old `trustedProxyAddresses` field is rejected rather than silently ignored;
remove it when reviewing an unactivated PR #7 configuration. TLS-file fields are
also invalid for this edge-terminated mode. Loopback proxy and direct TLS modes
retain their existing transport checks.

Only exact `GET /livez` bypasses the Host check, returning fixed process liveness
without invoking OAuth or the message host. It reveals no provider/storage state.
It stays healthy when paused, expired or disconnected: use `/healthz` through the
pinned Host and operator transport monitoring for application acceptance.
The shutdown fence runs before liveness. Liveness never authorizes activation.

### Security invariants and transport assumptions

- Host poisoning cannot change the issuer, resource, discovery endpoints or
  callback URLs: raw duplicate/mismatched Hosts fail, and forwarding claims are
  discarded. Generated provider URLs use the pinned Host and application-owned
  HTTPS scheme. The real `Origin`, `Cookie` and `Authorization` remain intact.
- Private HTTP callers can fetch public discovery or begin an OAuth transaction,
  just as public callers can. They cannot acquire another browser's Secure cookies
  or stored interaction binding by supplying headers. Google owner subject,
  state, nonce, browser binding, single-use code and S256 PKCE checks still apply.
- MCP requires an owner/client/audience/scope-bound token and live grant. Browser
  Origin checks and token rotation/revocation are unchanged. A stolen bearer token
  already permits replay through the public endpoint; IP filtering is not token
  binding. No operator methods become HTTP-accessible.
- This mode assumes the documented Render public edge provides HTTPS and the
  platform protects the internal transport. It does not encrypt the internal
  HTTP hop, claim a socket is TLS, or defend against a compromised platform or
  network observer. Do not expose this listener as a public plaintext origin on
  another host. Use direct TLS or an appropriate secured topology there.
- Retain a dedicated workspace and minimal service access. Private callers can
  bypass edge-only rate limits, so application body/time limits and bounded OAuth
  queues remain relevant. Do not treat private callers as privileged or use a
  forwarded address for authorization or abuse controls.

The minimum platform evidence is Render's documented external HTTPS/internal HTTP
model and the configured service/issuer topology. No undisclosed proxy-IP list or
support assurance about forwarding-header rewriting is needed by this adapter.
Actual public HTTPS, canonical-host routing and provider compatibility still need
acceptance after separately approved provisioning; local fixtures do not prove them.

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

After host setup and all [required identity values](deploy-readiness.md)
are verified, live selection is a separate approved command change to
`node production-server.mjs --config /var/data/quicksilver/production-config.local.json --activate`.
It still requires a fixed approved deadline no more than one hour ahead. Ordinary
restarts retain that deadline, stored keys, pause and uncertain-send holds. No
supervisor may roll the deadline forward. Historical catch-up remains deferred.

## Smallest remaining setup and acceptance steps

1. Approve fresh workspace/service/disk creation, current price/budget and region.
   After merge, provision only the disabled template and verify health, runtime,
   disk persistence, private ownership and process termination.
2. Verify the configured public issuer uses Render's HTTPS edge and the deployed
   listener is only the platform's internal HTTP origin. Check canonical Host,
   fixed HTTPS discovery/redirects and Secure cookies during authorized acceptance.
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
- [Official oidc-provider TLS-offloading guidance](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md#trusting-tls-offloading-proxies)
- [Default PORT/environment variables](https://render.com/docs/environment-variables)
- [Compute plan naming](https://render.com/docs/compute-plans)
- [Persistent disks, shutdown limits and backup caveats](https://render.com/docs/disks)
- [Blueprint specification](https://render.com/docs/blueprint-spec) and
  [official JSON Schema](https://render.com/schema/render.yaml.json)

The Blueprint validates against the fetched official schema locally. The design
was independently reviewed against the official guidance and installed
`oidc-provider` 9.13.0/Koa URL and cookie behavior. Fixture
tests exercise real OAuth/MCP HTTP through the Render guard, secure callbacks and
cookies, refresh/revocation, owner filtering, future-only reconnect/replay,
spoofed/duplicate headers, unauthenticated private callers, owner/PKCE/browser
binding rejection through the actual listener, persistent pause/restart,
disabled startup and shutdown. They do not verify Render's ingress or live
Google/Photon/ChatGPT compatibility. No infrastructure or runtime settings changed.
