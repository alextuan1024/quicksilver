# Quicksilver

Temporary synthetic MCP Events connection proof. No Photon integration, phone data,
real messages, external LLM, or general send tool. No live integration success yet.

## Current state

OAuth metadata and 401 discovery are implemented. The owner/session gate is CLOSED
until the user completes application Google login, the exact issuer/subject is
verified, and an explicit absolute session deadline is configured. No first-login
auto-enrollment. Public metadata does not grant access.

- Resource: `https://quicksilver-kvt8.onrender.com/mcp`
- Issuer: `https://dev-ar7fhtveuwv8gobu.us.auth0.com/`
- Third-party client: `tpc_caXSmFzUtRmg6MaouZ9Dij` (`quicksilver-chatgpt`)
- Scope: `quicksilver:probe`; Authorization Code with PKCE; `client_secret_post`.
- Auth0 API: RFC 9068 / RS256, one-hour tokens, consent required, offline access off.
  Only the named client's user-delegated scope is granted. M2M and anonymous denied.
- Strict Auth0 third-party clients do not support OIDC scopes/ID tokens: request
  only `quicksilver:probe`, not `openid`, `profile`, `email`, or `offline_access`.
- Google login uses Auth0 development keys and basic/extended profile only; its
  domain-level promotion was explicitly approved. No Google data API permissions.
- Auth0 automatically created an unused `quicksilver (Test Application)` M2M client
  with API creation; API policy denies its client access. Do not use its credentials.

The user must enter the client secret directly into ChatGPT and complete Google
login/consent. The server requires no client secret. Register the exact fresh
callback shown by ChatGPT after metadata discovery, without a wildcard.

## Validation and running

Node 22. `npm ci --ignore-scripts --no-audit --no-fund`, `node --test`,
`node scan.mjs`, then `node server.mjs`. Render Free build uses the install,
tests and scan commands; start `node server.mjs`; health `/healthz`. No database
or disk, auto-deploy off. Source and lockfile pin `jose` 6.2.12.

`jose.jwtVerify` validates RS256 signature against issuer-pinned JWKS, issuer,
audience, RFC 9068 token type, required claims, expiry, and bounded token lifetime.
Every MCP operation additionally requires exact client/owner and scope. ID tokens,
wrong signatures/claims, legacy keys, missing owner, missing/expired/oversized
session windows are rejected. Tokens and callback secrets are not logged.

Set `QUICKSILVER_OWNER_SUBJECT` only after verifying the user's exact Auth0 app
identity. Set `QUICKSILVER_SESSION_EXPIRES_AT` to an approved absolute UTC deadline
at most one hour from startup. Neither value exists in the initial deployment.
Legacy `QUICKSILVER_API_KEY` is ignored by the server. Static fixture auth in the
bridge module is used only by local contract tests.

`/proof` is always denied in the deployable service: a separately approved operator
trigger remains to be selected. The MCP scope authorizes subscription and
acknowledgement only. Do not copy an access token or add a backdoor to trigger it.

## Bounded synthetic protocol

`server/discover` advertises MCP `2026-07-28`, events and tools. Event `probe.created`
has the exact filter `{"session":"quicksilver"}` and a synthetic proof ID/nonce.
The only tool, `acknowledge_probe`, accepts that active proof ID/nonce, idempotently.
The owner must instruct the existing Athena to acknowledge this test.

One callback is verified using a signed challenge. Standard Webhooks signatures
bind ID, timestamp and exact body. HTTPS callbacks must resolve exclusively to
public IPv4; sockets pin the checked address with hostname TLS verification.
No redirects, IPv6, credentials, custom ports, arbitrary payloads or destinations.
Wrong nonce, competing callbacks, expired state and stale acknowledgements after
unsubscribe/restart fail. Delivery is never retried automatically.

Local tests use generated test keys and simulated callbacks; they prove contracts,
not Auth0 issuance, ChatGPT callback delivery, Athena continuity, or iMessage.
The live OAuth flow must verify PKCE S256, exact redirect/resource, issued claims,
and owner binding before the synthetic round trip. A successful callback alone
is insufficient: require Athena's tool trace and matching acknowledged proof.

State is intentionally in memory; restart loses subscriptions/proofs, and an
absolute deadline prevents indefinite access. Free Render may sleep or restart.
This test does not prove durable production event delivery. After testing, remove
owner/deadline configuration and revoke the test grant/client access as appropriate.

## References

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://auth0.com/docs/get-started/applications/third-party-applications/security-controls
- https://render.com/docs/free
