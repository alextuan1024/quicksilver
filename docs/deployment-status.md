# Disabled deployment and next configuration approvals

## Recorded deployment — October 27, 2026

The coordinating chat reports an approved dashboard deployment, completed at
23:25:29 UTC. These are reported dashboard/HTTP observations, not live checks
performed by this documentation task:

| Item | Recorded value |
| --- | --- |
| Target | New `quicksilver-v1` service in the existing Alex's workspace |
| Service | `srv-dbgj5evf3r2c73av89jg` |
| Public origin | `https://quicksilver-v1.onrender.com` |
| Compute | Singapore, Starter 512 MB, Node 22.23.4 |
| Disk | `dsk-dbgj5evf3r2c73av89qg`, display name `disk`, 5 GB at `/var/data` |
| Initial deploy | `dep-dbgj5fvf3r2c73av8b50`, successful |
| Deployed commit | `cece0b521d44062af8461f412cfb38b0f186077f` |
| Start | `node render-bootstrap.mjs --disabled` |
| State | `/livez` returned 200 with disabled mode; other routes returned 503 |
| Automation | Auto-deploy and previews off; no provider credentials configured |
| Existing service | Old Free `quicksilver` service untouched |

The fetched repository main matches the deployed commit. PR #8 remains open and
draft at `161ac3e5d8536a4743d001b5d311564c6abbc747`; its fixed-origin listener
is **not merged or deployed**. Its two Node CI jobs passed. The bootstrap can run
without it, but the intended live Render configuration below requires PR #8 to
land first. Do not append changes to merged PR #7 or silently substitute a branch
deployment. This record supersedes the earlier proposed fresh-workspace/name
choices. The existing service was created through the dashboard; do not apply the
old template as a new Blueprint or create duplicate resources.

## Exact URLs derived from the source

These URLs describe the future OAuth host. The current disabled bootstrap does
not serve these routes:

| Purpose | Exact value |
| --- | --- |
| Canonical issuer, including trailing slash | `https://quicksilver-v1.onrender.com/` |
| MCP resource and endpoint | `https://quicksilver-v1.onrender.com/mcp` |
| Google web-client authorized redirect URI | `https://quicksilver-v1.onrender.com/interaction/google/callback` |
| OAuth discovery | `https://quicksilver-v1.onrender.com/.well-known/oauth-authorization-server` |
| Protected-resource discovery | `https://quicksilver-v1.onrender.com/.well-known/oauth-protected-resource/mcp` |
| Authorization endpoint | `https://quicksilver-v1.onrender.com/auth` |
| Token endpoint | `https://quicksilver-v1.onrender.com/token` |
| Revocation endpoint | `https://quicksilver-v1.onrender.com/token/revocation` |
| Public signing keys | `https://quicksilver-v1.onrender.com/jwks` |

Google's callback above is distinct from the ChatGPT MCP client's own redirect
URI(s). Obtain those exact registered callbacks from the actual client setup;
do not substitute the service's Google callback or a fixture value. The app's
server-side Google flow does not require an Authorized JavaScript origin.

## Credentials, identity pins and reuse boundaries

| Required input | Source contract | Availability/reuse decision |
| --- | --- | --- |
| Google OAuth client ID and client secret | Web application client, with the exact Google redirect URI above; upstream scope is only `openid` | Existing Google client availability is unknown. Prefer a dedicated client; reuse only after identifying its owning project and authorizing the added callback. Auth0 credentials are not a substitute. |
| Google owner subject | Exact verified `sub` for the intended owner; Google issuer is pinned to `https://accounts.google.com` | Unknown. Do not infer from email, display name, Auth0 subject or an unverified decoded token. If no verified identity record exists, approve a separate controlled Google identity-verification flow before configuring this pin. |
| MCP client ID and 1–4 redirects | Exact public-client identifier and HTTPS callback allowlist; S256 PKCE; no MCP client secret | Actual ChatGPT registration values are unknown. Requests may use `openid offline_access quicksilver:messages`; `offline_access` belongs to the local provider, not the upstream Google request. |
| Photon project secret and route | Project `77c7d003-2bf1-4638-b866-2e2ce16ab091`; owner E.164 address; exact `any;-;<ownerAddress>` DM; line `shared` or the verified dedicated E.164 line | Earlier proof establishes historical Photon use, not current secret validity or route entitlement. Reuse may be possible after explicit authorization and private provision from its owner; do not read/copy the old service's secrets or infer its line. |
| OAuth signing material | Private RSA JWKS, RS256, at least 2048 bits, `use: sig`, unique nonempty `kid` for each key | No provisioned material is known. Approve generation of dedicated persistent keys or explicit reuse of previously verified compatible material. Never regenerate on restart. |
| Cookie signing keys | Persistent independent random values; each string at least 32 bytes | Recommend generating at least 32 random bytes and encoding for JSON; no values have been generated. Keep stable across restarts and retain required rotation overlap. |
| Message backup key | Independent 32-byte binary AES-256-GCM key, supplied to the offline operator command | Not part of production JSON. Approve generation and separate escrow; a base64 string is not the raw key file consumed by the CLI. Choose backup destination/retention separately. |

The pinned SDK obtains short-lived Photon tokens from the project secret; the
operator does not manufacture or persist those tokens. SDK provider permissions
must permit the selected line's live subscription and send operations; no
invented OAuth scope names are added. The app filters to one owner DM and defers
historical catch-up.

MCP webhook delivery also needs the client's actual HTTPS callback URL and a
`whsec_` signing secret containing 24–64 decoded random bytes. Those arrive through
the authenticated event subscription, not the startup JSON; never reuse Google,
Photon, cookie, JWT or backup keys for that purpose. Verify how the actual ChatGPT
client supplies this during approved compatibility testing.

## Private storage route

Use the individual service's **Render Secret Files**, not shared environment
groups and not individual credential environment variables: the application only
loads a private JSON file. The user should enter secret values privately in the
Render dashboard or an approved secret-manager workflow, never in chat, Git,
screenshots, shell arguments, build commands or logs.

Recommended staging filename: `production-config.local.json`, available at
`/etc/secrets/production-config.local.json`. Render documents that secret files
are also present in the root of native-runtime services and that their combined
size cannot exceed 1 MB. Saving a secret file triggers a deploy; approval must
explicitly include that **disabled** redeploy. Keep the bootstrap command intact.

Render's documentation does not establish ownership, mode, regular-file status
or link count required by this app. After authorized secret-file setup, inspect
metadata only. Direct loading is supported only if the file meets all app checks.
Otherwise an explicitly authorized service-user operation must stage a private,
regular, singly linked mode-0600 JSON copy at
`/var/data/quicksilver/production-config.local.json`.

The separate future database paths are `/var/data/quicksilver/oauth.sqlite` and
`/var/data/quicksilver/messages.sqlite`. Approved production startup creates them;
do not copy JSON into those paths or overwrite existing stores.

The parent directory must be service-owned, canonical (no symlinked parents),
mode 0700; the database paths must be distinct. The three paths are intended
future files, not claims that they already exist. A private copy leaves another
secret-bearing file on persistent storage: include it in access/rotation and
cleanup procedures. The bootstrap does not copy files or initialize databases;
no automatic staging helper is implemented. Do not weaken file validation to
accommodate a platform mount. Keep backups and escrow outside the service's sole
disk; message backups exclude OAuth, and restoring old grants is unsupported.

## Minimal approval bundles and sequence

1. **Credential and identity preparation, keeping the service disabled.** Confirm
   the Google project/client creation or specific reuse, exact callback addition,
   owner sign-in/grant using only `openid` if identity verification is needed,
   actual MCP registration, and private provision of the specific Photon project
   secret/owner/line. Approve dedicated RSA, cookie and backup-key generation and
   escrow. Identify exact accounts first; do not grant broad account access.
2. **Private configuration staging, still disabled.** Approve adding the one
   service-local secret file to `srv-dbgj5evf3r2c73av89jg`, its resulting disabled
   redeploy, metadata inspection, and any required private-directory/file staging.
   No production startup, grants, provider calls or messages follow merely from
   this approval. Provision no speculative future activation deadline: set the
   final fixed `expiresAt` only for the separately approved window.
3. **Deploy reviewed code while disabled.** After the user merges PR #8, verify
   main ancestry and checks, then obtain approval for a manual deployment of that
   exact revision retaining `node render-bootstrap.mjs --disabled`. A merge alone
   does not deploy because auto-deploy remains off.
4. **Bounded live acceptance, separately approved.** Record exact owner/line/DM,
   allowed test messages/actions, start/end UTC (at most one hour), operator and
   stop/rollback procedure. Approve final config/deadline, production start-command
   change and manual deploy, Google/ChatGPT login/grants, Photon token acquisition,
   subscription and the specified sends. Use
   `node production-server.mjs --config /var/data/quicksilver/production-config.local.json --activate`
   only after these prerequisites. Retain `PORT=10000`, health `/livez`, one process,
   worker defaults 1000 ms/5000 ms and existing pause/recovery behavior.

The normal production entry point starts Photon after binding. It is **not** a
credential-validation or OAuth-only preflight command. The bootstrap cannot
obtain the Google owner subject because it serves no OAuth routes. If a separate
identity-verification flow or OAuth-only acceptance phase is needed, define that
specific procedure first; no such operator command exists in this repository.
The one-hour window cannot be silently extended or rearmed after a restart.
Stopping live acceptance means disabling the production command/host, not merely
removing client tokens. Preserve uncertain-send evidence and do not auto-retry.

## Evidence and current limits

URL, scope, owner/key and startup requirements were read from
[local OAuth](../local-oauth.mjs), [production configuration](../production-config.mjs),
[production startup](../production-server.mjs), [Photon adapter](../photon-live-adapter.mjs),
[callback validation](../bridge.mjs), [backup format](../message-backup.mjs), and
[offline operations](operations.md). The intended fixed-origin behavior is in
[PR #8](https://github.com/alextuan1024/quicksilver/pull/8), pending merge.

[Render's official secret-file documentation](https://render.com/docs/configure-environment-variables#secret-files)
was retrieved on October 27, 2026. No secret values, account grants, current
credential validity, private-file metadata, live OAuth routes or provider access
were inspected in this task. Provisioning reports do not establish those gates.
