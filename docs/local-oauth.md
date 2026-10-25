# Local OAuth component

The local authentication component is implemented behind explicit trusted host
configuration. It uses `oidc-provider` 9.13.0 for OAuth and `openid-client` 6.8.8
for Google OIDC. The existing `server.mjs` / `runtime.mjs` still use the parked
Auth0 proof path. No environment variable switches them to local OAuth.

## Host contract

Run one Node >=22.23.4 <23 process with a private persistent directory. Supply:

- A canonical root HTTPS issuer ending in `/`, such as `https://quicksilver.example/`, and the same
  origin's `/mcp` resource. Both values are pinned configuration.
- One pre-registered **public** MCP client ID, with `token_endpoint_auth_method:
  none`, and one to four exact HTTPS redirect URIs. Dynamic registration, client
  metadata URL fetching and arbitrary client IDs are disabled. Compatibility
  with the actual ChatGPT connector remains a live acceptance gate.
- The owner's verified Google **`sub`**, not their email address and not the
  old Auth0 `google-oauth2|...` subject. This changes the message-store identity;
  an existing Auth0-bound database must not silently be reopened under it. An
  operator-reviewed identity migration is not implemented in this phase.
- Google OAuth web-client credentials with the exact callback
  `https://quicksilver.example/interaction/google/callback`. The host provisions
  these separately. The module uses Google's fixed HTTPS authorization, token
  and JWKS endpoints; it does not request profile/email scopes or retain Google
  access tokens. `openid-client` validates signature, issuer, audience, expiry,
  nonce, state and S256 PKCE before the pinned subject can authorize anything.
- Persistent private RSA signing JWKS: every key must have a unique `kid`,
  `kty: RSA`, `alg: RS256`, `use: sig`, private components, and >=2048 bits.
  Also supply at least one high-entropy cookie signing key of >=32 bytes.
  Provision keys in the host secret system; never commit them. Startup rejects
  missing keys rather than generating replacements.
- A fixed, explicitly approved `expiresAt` no more than one hour ahead. Durable
  OAuth grants survive restarts, but this existing message activation boundary
  still limits intake, claims, replies and delivery. Authenticated discovery
  remains available after it expires. Do not automatically roll it forward.

Example of trusted in-process composition (the host supplies all named values):

```js
import {createServer} from 'node:https';
import {createLocalMessageService} from './local-service.mjs';

const app = await createLocalMessageService({
  localOAuth: {
    issuer: publicIssuer,
    resource: new URL('/mcp', publicIssuer).href,
    clientId: registeredMcpClientId,
    redirectUris: registeredMcpRedirectUris,
    ownerSubject: verifiedGoogleSubject,
    databasePath: '/private/persistent/quicksilver/oauth.sqlite',
    jwks: persistentPrivateSigningJwks,
    cookieKeys: persistentCookieSigningKeys,
    google: {clientId: googleClientId, clientSecret: googleClientSecret},
    trustProxy: false,
  },
  expiresAt: approvedSessionExpiresAt,
  photon: verifiedOwnerRoute, // projectId, ownerAddress, line, exact owner DM
  messageHandling: {
    databasePath: '/private/persistent/quicksilver/messages.sqlite',
    provider: verifiedPhotonClient, // trusted owner-scoped client, retries OFF
    workerIntervalMs: 1000,
    sendTimeoutMs: 5000,
  },
});

const server = createServer(tlsOptions, app.handle);
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(443);
// Forward native events only from the verified owner-scoped subscription:
// app.messages.receive(event, providerCheckpoint);
// Stop the host's subscription/client and HTTP listener, then await app.close().
```

The host controls transport startup and shutdown. `app.messages` exposes the
existing local pause, inspection, reconciliation and backup methods. Those
operator methods are not OAuth or MCP endpoints. Construction does not contact
Google or Photon. `createLocalOAuth(config)` is also available independently,
exposing the HTTP `handle`, resource `gate`, local `revokeGrant(id)` and `close`.
Neither factory binds a listening port.

For TLS termination, set `trustProxy: true` **only** on a listener reachable
exclusively by the trusted proxy. The proxy must overwrite Host with the exact
configured issuer host, strip client-supplied forwarding headers, omit
`X-Forwarded-Host`, and set `X-Forwarded-Proto: https`. Headers alone do not prove
the peer is a trusted proxy. Bound request/header timeouts and edge rate limits
are host responsibilities. MCP rejects browser Origin headers and limits JSON
bodies to 16 KiB; the OAuth library limits form bodies to 56 KiB. Authorization
state transitions are serialized with a bounded queue. Each active OAuth request
has a ten-second absolute deadline that aborts incomplete bodies; the optional
trusted `requestTimeoutMs` setting may shorten it (1–10000 ms). Google requests
are bounded to five seconds. Transport failures return fixed categories and do
not log framework stacks. A host requiring a proxy
for outbound HTTPS can provide a trusted `google.fetch` implementation; preserve
certificate verification, endpoint restrictions and request cancellation.

## Protocol and lifetime

Discovery is served at `/.well-known/oauth-authorization-server` and
`/.well-known/openid-configuration`. Protected-resource metadata is served by the
composed service at `/.well-known/oauth-protected-resource/mcp` (and its root
alias). Endpoints are `/auth`, `/token`, `/token/revocation` and `/jwks`.

Authorization must supply the exact resource, `quicksilver:messages` scope,
S256 PKCE, the pinned client ID and an exact configured redirect. `openid` and
`offline_access` are optional additional scopes. Implicit grants, dynamic
registration, pushed authorization requests, userinfo, logout and DPoP are not
supported by this bounded component. The owner/client/resource/scope combination
is pre-authorized by trusted configuration; there is no additional local consent
screen. Google account selection still runs on an interaction.

Authorization codes last 60 seconds and can be used once. Browser-bound Google
login transactions last five minutes and are consumed before exchanging the
upstream code. The cookie uses Secure, HttpOnly and SameSite=Lax. A bad owner,
nonce, signature, state or replay cannot complete authorization.

Access tokens are opaque and last five minutes. The resource gate checks current
SQLite token and grant state on every request, including owner, client, resource
and scope, so grant revocation immediately blocks subsequent calls. Requests
already authorized or provider sends already in flight cannot be undone by
revocation; use `app.messages.pause()` to quiesce messaging too.

Refresh tokens rotate on every exchange, with a maximum 30-day original grant
lifetime. Reusing a consumed refresh token revokes that grant's entire token
family, including the newly issued access/refresh tokens. Refresh calls and
code exchanges are serialized to prevent two concurrent uses from succeeding.
Revoking either an access or refresh token through `/token/revocation` also
revokes its grant. Local `app.revokeGrant(id)` is for the trusted operator only;
there is no grant-listing dashboard or remote administrative API.

## Persistence, rotation and recovery

OAuth records live in a separate SQLite database in the same private persistent
directory/deployment as message state. This keeps token/grant recovery separate
from message snapshot recovery. The database has owner-only file permissions,
full synchronous WAL writes, an exclusive process lock and an identity binding.
Do not open it from a second process, read it into logs or copy a running file.
The directory, SQLite sidecars, storage volume and host must also be private.
Expired records are pruned on writes. Revocation tombstones are retained to
prevent late writes from resurrecting revoked grants; operational retention
and deletion policies remain to be chosen before launch.

Preserve signing JWKS and cookie keys across ordinary restarts. Rotate by
prepending the new signing key and cookie key while retaining previous keys for
the applicable token/session overlap; distribute the public JWKS before retiring
an old signing key. Access tokens are opaque and independently revocable. This
module accepts supplied key sets; automated secret provisioning, rotation
scheduling and key escrow are not implemented.

**Do not restore old OAuth databases.** Doing so could revive previously revoked
credentials. For message backup recovery, stop/fence the old host, preserve the
message restore holds, start with a fresh OAuth database at a new path, and
require the owner to reconnect. If the old host cannot be fenced, do not resume.
Keep the same pinned identity for message restoration. Google/Auth0 subject
migration requires separate design and operator review. The existing message
backup deliberately excludes the OAuth database. This phase does not implement
a coordinated auth/message backup, OAuth snapshot restoration or an identity
migration command.

## Verification and remaining gates

Local tests run the real provider over HTTP with browser cookie paths and
locally generated signing keys. Only Google's remote authorization/token/JWKS
wire behavior is replaced by fixtures. They cover restart, refresh reuse,
revocation, concurrent refreshes, PKCE, code/login expiry, invalid Google
identity/signatures, callback binding, host checks and authenticated message
claims/replies. They do not establish live Google or ChatGPT acceptance.

Before launch: provision credentials and persistent keys, validate the real
Google/ChatGPT redirect and public-client behavior, choose retention/backup and
hosting controls, implement the intentional production activation policy and
any required identity migration, and accept the fixture-tested future-only Photon
live reconnect/token renewal with the real provider. Historical catch-up is deferred and is not a V1 launch gate.
[MCP replay cursors](event-replay.md) are implemented locally. A generic
[catch-up controller](photon-recovery.md) is fixture-tested and retained as
optional deferred work. [Future-only live reconnect and token renewal](photon-live.md)
now have explicit SDK/host wiring under local fixtures; real-provider and production
acceptance remain outstanding. The runtime has not been switched, deployed or activated.

The initial October 25 audit found 14 affected dependency entries. The authorized
[dependency remediation](dependency-remediation.md) now updates npm Undici to
7.30.1 and the coordinated OpenTelemetry components to 0.219.0/core 2.8.0. The
fresh audit reports zero known vulnerabilities. The declared runtime floor is
Node 22.23.4, with bundled Undici 6.29.1. Messaging SDK versions are preserved.

The [historical source/dependency audit](local-oauth-final-audit.md) records the
independent OAuth review and initial dependency findings; the remediation record
above supersedes its vulnerable versions and older Node minimum. Both stages are
merged through [PR #2](https://github.com/alextuan1024/quicksilver/pull/2). See the
[current roadmap](status.md) for the remaining implementation and launch gates.
