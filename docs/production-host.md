# Production entry point

`npm run start:production -- --config /private/quicksilver/production-config.local.json --activate`
selects the durable Google OAuth/message/Photon host. `npm start` still selects the
parked proof server. Selecting the production command is a separate deployment
change; merging this code does not deploy or activate it.

Run a single process on Node **>=22.23.4 <23**, with private persistent storage.
The command rejects missing `--activate`, invalid configuration and an expired or
more-than-one-hour-away `expiresAt` before listening. There is no environment
variable fallback, automatic key generation or rolling activation deadline.

## Configuration

Provision one JSON file outside the checkout, owned by the service user with
mode `0600`. Config and TLS files must be regular, singly linked files, not
symlinks, with no group/other permissions and a maximum size of 1 MiB. Create the
database parent directories beforehand with mode `0700`, owned by that same
user. Use canonical absolute paths without symlinked parent directories for the
databases. Existing database files must also be private, regular and singly linked.
OAuth and message databases must have distinct paths. Never place them on an
ephemeral filesystem. The process user must have exclusive control of the config,
keys and storage; the checks are not protection against another process running
as that same user.

The following is a shape reference, not deployable credentials or an activation:

```json
{
  "listener": {"mode": "proxy", "host": "127.0.0.1", "port": 10000},
  "expiresAt": "REPLACE_WITH_APPROVED_FIXED_ISO_DEADLINE",
  "localOAuth": {
    "issuer": "https://quicksilver.example/",
    "resource": "https://quicksilver.example/mcp",
    "clientId": "REGISTERED_MCP_CLIENT_ID",
    "redirectUris": ["https://chatgpt.example/EXACT_REGISTERED_CALLBACK"],
    "ownerSubject": "VERIFIED_GOOGLE_SUB",
    "databasePath": "/private/quicksilver/oauth.sqlite",
    "jwks": {"keys": []},
    "cookieKeys": [],
    "google": {"clientId": "PROVISIONED_GOOGLE_CLIENT_ID", "clientSecret": "PROVISIONED_SECRET"}
  },
  "photon": {
    "projectId": "77c7d003-2bf1-4638-b866-2e2ce16ab091",
    "ownerAddress": "+15550000001",
    "line": "VERIFIED_LINE",
    "dm": "any;-;+15550000001"
  },
  "photonProjectSecret": "PROVISIONED_SECRET",
  "messageHandling": {
    "databasePath": "/private/quicksilver/messages.sqlite",
    "workerIntervalMs": 1000,
    "sendTimeoutMs": 5000
  }
}
```

Populate private RSA JWKS and persistent cookie keys according to the
[OAuth host contract](local-oauth.md#host-contract). Replace the example route
with the verified owner route. Configuration fields are allowlisted; JavaScript,
SDK/fetch overrides and environment-provided secrets are not supported by this
entry point. Preserve keys and identity across ordinary restarts. Existing
Auth0-bound message data still requires a separately designed migration.

### Listener modes

- **`proxy`:** plain HTTP bound only to `127.0.0.1` or `::1`. Run a trusted TLS
  proxy on the same machine/network namespace. It must overwrite Host with the
  exact issuer host, strip incoming forwarding headers, omit X-Forwarded-Host
  and set X-Forwarded-Proto to `https`. Only that proxy and trusted local processes
  may access the listener. A load balancer connecting to a public/private NIC is
  deliberately unsupported in this mode; headers alone cannot establish trust.
- **`tls`:** direct HTTPS. Set `host` to an explicit IP, plus `certFile` and
  `keyFile` with private absolute paths. TLS 1.2 is the minimum. Provision the
  certificate/chain for the public issuer; reload certificates by restarting the
  process under the same fixed activation deadline. Trust-proxy behavior is off.

Ports are integers from 0–65535 (0 is for local fixtures). Production should use
a fixed port. Edge rate limits, firewall rules, DNS, certificates, storage, secret
provisioning and monitoring remain host setup work. The listener has ten-second
request/header/socket timeouts and a five-second keep-alive timeout. OAuth and
MCP retain their existing body limits and request-origin checks.

## Activation, health and shutdown

An operator invokes the command with an approved fixed deadline and `--activate`.
It opens the durable host, binds the listener, then starts Photon. A failed bind
closes the host without starting Photon. An existing persistent pause remains in
force and prevents connection. Ordinary restarts under that command can reconnect
within the **same** deadline; they cannot extend it. Do not configure a supervisor
to generate a fresh deadline, reset pause, or retry a permanently stalled host
without operator review. Ongoing unattended activation beyond one hour remains a
separate policy and implementation decision.

`/healthz` retains the existing message service status (`message-session`,
`paused` or `disabled`) and the same Host/TLS checks. This is HTTP/service health,
not proof of a connected Photon stream or recipient delivery. The in-process
`transportStatus()` provides the controller's fixed state/reason categories;
there is no public administrative/status endpoint added here. Monitoring of that
transport state is still an operational integration task.

SIGTERM and SIGINT stop accepting connections and begin host shutdown immediately.
Photon is fenced/stopped before the OAuth and message stores close. In-flight HTTP
connections have up to ten seconds to drain before they are destroyed. Host
shutdown also awaits the existing bounded provider/send/callback work; a supervisor
should allow at least 60 seconds before forced termination. Unknown sends retain
the existing reconciliation rules. A crash does not authorize retrying them.

Startup logs report only the listening port and bounded activation. Failures use
a fixed message, never config contents, paths, raw provider errors or request URLs.
Use the [operator procedures](operations.md) for paused recovery and restoration.

## CI and verification

The GitHub Actions `CI` workflow runs on pull requests, pushes to `main`, and manual
dispatch. Each Node matrix entry (`22.23.4`, latest `22.x`) performs a clean install,
the full local suite, recursive source secret-pattern scan, local Markdown link/
anchor/fence checks, dependency-tree validation, full and production audits, and
change whitespace checks. It uses read-only repository permissions and no provider
credentials, deployment step or live messages. Fork/PR code never receives secrets.

Tests cover the actual composed OAuth/message listener and Photon SDK fixtures,
direct TLS with verified local certificates, invalid origin/forwarding headers,
unsafe configuration, bind failure, interrupted startup, stalled connections,
persistent pause, and real SIGTERM/SIGINT process shutdown. They do not establish
live Google/Photon/ChatGPT acceptance. A configured workflow is not a passing
remote run; inspect the checks for the published commit.


## Local implementation evidence — October 27, 2026

- Full suite: **210/210 passed** on Node 22.23.4. The current `node@22` selection
  resolves to the same version.
- Independent integration/security/CI review: **10/10 production tests passed**;
  no actionable findings. The private-file reader rejects FIFOs without blocking.
- Clean install, recursive source secret scan, Markdown links/anchors/fences,
  dependency tree and whitespace checks passed. Full/production audits reported
  zero known vulnerabilities.
- Based on merged PR #4 (`2b80a0b`). No dependency versions, existing transport
  controller, uncertainty handling or default proof runtime changed.
- This stage is committed locally only. Remote workflow execution, deployment,
  credentials, live-provider/ChatGPT acceptance and any activation beyond one
  hour are not established by these results.
