# Verify the owner before activating Photon

The next proposed operational step is a temporary Google-only identity proof.
`owner-verification-server.mjs` does not start Photon, serve MCP/OAuth tokens,
open databases, generate application credentials or assign an owner. It returns
the cryptographically verified Google `sub` to the initiating browser once.
This is separate from `production-server.mjs --activate`, which starts Photon.

This implementation uses the fixed-origin Render listener from merged PR #8.
PR #9's deployment handoff is also merged; both are present on main at
`58f3effd782837437b428507d7d3851797ec51a4`. The verifier itself still requires
review and merge before selecting a deployment revision. Repository merges do
not change the deployed service or authorize credential access/live activation.

## Proposed next authorization bundle

After code review/merge, obtain explicit authorization for these specific actions:

1. Privately read only the staged Google client credentials and generate a fresh
   32-byte random setup ticket. Assemble the configuration below as a service-local
   Secret File. Do not read the Photon staging file. Keep the ticket out of chat,
   logs, URLs and repository files; the operator must privately paste it into the
   browser form. No signing, cookie or backup keys are needed for this step.
2. Stage a process-owned, regular, single-link mode-0600 configuration file at
   `/var/data/quicksilver/owner-verification.local.json`, with a private mode-0700
   parent directory. Verify mount metadata before use; a Render Secret File is not
   assumed to meet these checks. Any private copy must be explicitly authorized.
   Set one absolute `expiresAt` no more than ten minutes ahead at process startup.
   Deploy/build latency counts against this window; prepare the build first and
   set the deadline close to the authorized start. An expired config fails closed.
3. Manually deploy the reviewed revision with `PORT=10000` and start command:

   ```sh
   node owner-verification-server.mjs --config /var/data/quicksilver/owner-verification.local.json --verify-owner
   ```

   Keep auto-deploy/previews off. Visit
   `https://quicksilver-v1.onrender.com/setup/owner`, paste the ticket and sign in
   with the intended Google owner using **openid only**. The existing Google Web
   client callback must remain exactly
   `https://quicksilver-v1.onrender.com/interaction/google/callback`.
   Do not publish the Google app or add scopes to overcome a consent restriction;
   if Google requires a test-user change, obtain approval for that exact account.
4. Privately retain the returned `issuer`, `subject` and `googleClientId`; confirm
   the selected Google account is the intended owner. This proof identifies that
   account; it does not itself authorize making the account the owner. Then restore
   `node render-bootstrap.mjs --disabled` with an explicit manual deploy and remove
   the temporary ticket/configuration. No provider activation follows automatically.

The service domain and staged Google/Photon files were reported by the coordinating
task; this code change does not inspect those secrets or probe that deployment.
Current staging filenames are `quicksilver-google-oauth-staging.json` and
`quicksilver-photon-staging.json`, saved without deployment. Their JSON schema has
not been read here. Do not pass either file directly to this strict config loader.

Configuration shape (placeholders only, intentionally unusable):

```json
{
  "issuer": "https://quicksilver-v1.onrender.com/",
  "expiresAt": "<absolute UTC deadline, at most ten minutes ahead>",
  "google": {
    "clientId": "<existing Google Web client ID>",
    "clientSecret": "<existing Google Web client secret>"
  },
  "setupTicket": "<32 random bytes encoded as 43 base64url characters>"
}
```

The ticket is consumed before creating one state/nonce/PKCE transaction. Invalid
tickets, origins and callback bindings do not consume the valid transaction.
The callback also requires its Secure, HttpOnly, SameSite=Lax browser cookie.
Google signature, issuer, audience, nonce and expiry checks must all pass. No raw
token is returned. Responses are non-cacheable and have no referrer. Forwarded
headers cannot choose the callback origin; the configured Host must match.

After success or failure the process stays inert, avoiding an intentional restart.
**Ticket consumption is in memory, per process.** A crash/restart before the fixed
deadline can make the same ticket usable again; use a fresh ticket/config for an
operator retry. Restart never extends the original deadline. Expiry stops new
authorization/exchanges and fences late results. `/livez` stays healthy with
`photon: disabled`; it is not proof that verification remains available. At expiry
its mode becomes `disabled`. Application/MCP routes return 503 throughout.

## Obtain the existing dot's actual MCP registration

Separately, inspect the existing Athena dot/Quicksilver connection's management
page read-only and record its actual OAuth registration mode, client ID, exact
HTTPS callback(s) and token-endpoint authentication method. Do not recreate the
connection or start a grant merely to discover these fields. The Google callback
above is an upstream login callback, **not** an MCP client callback.

The current server supports one predefined public client, `token_endpoint_auth_method:
none`, PKCE S256 and 1–4 exact HTTPS redirect URIs. DCR and client-ID metadata
document registration are disabled. [OpenAI's authentication guidance](https://developers.openai.com/plugins/build/auth)
supports predefined clients and says the connection management page supplies the
exact callback/client metadata values. Callback mode can vary; do not copy a generic
documentation URL as this dot's verified registration. If its UI requires a secret,
DCR or metadata-document registration, report that compatibility gap before any
grant or configuration change. The actual values remain unverified.

## Later persistent application keys

Obtain separate approval before generating or storing these real keys. The exact
Node crypto operations below describe the required formats; they are not run by
the verifier, startup, CI or this preparation task.

| Material | Generation and application representation | Private storage |
| --- | --- | --- |
| Setup ticket, temporary only | `randomBytes(32).toString('base64url')` | Temporary config and operator's private paste source; retire after proof |
| OAuth signing key | `generateKeyPairSync('rsa', {modulusLength: 3072})`; export private key with `.export({format: 'jwk'})`; add `alg: 'RS256'`, `use: 'sig'`, unique `kid: randomUUID()` | `localOAuth.jwks.keys` array in the private production JSON; separately escrow the private JWK |
| Cookie signing key | Independent `randomBytes(32).toString('base64url')` | `localOAuth.cookieKeys` array in the same private config; preserve across restarts |
| Message-backup encryption key | Independent `randomBytes(32)` | Raw 32-byte mode-0600 file, e.g. `/var/data/quicksilver/message-backup.key`; escrow outside this disk |

Do not print keys. Use exclusive file creation (`flag: 'wx', mode: 0o600`) under
a mode-0700 directory and verify ownership; never overwrite existing material on
restart. If a binary backup key is transported in a text Secret File, encode it
privately as base64 and explicitly decode to exactly 32 bytes before the backup
CLI uses it: the CLI does not accept base64 text as a key. No backup destination
or escrow route has yet been selected. Backups contain message state, not OAuth
sessions/grants; restoration requires fencing and fresh OAuth storage/reconnection.

A later production config still needs the verified owner subject, actual MCP
registration, persistent keys, private database paths and explicit approval for
the bounded Photon activation. The one-hour activation limit and deferred
historical catch-up are unchanged. See [deployment readiness](deploy-readiness.md)
and [Render preparation](render-preparation.md).
