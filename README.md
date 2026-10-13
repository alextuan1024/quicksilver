# Quicksilver

A temporary synthetic MCP Events connection proof. It has no Photon integration,
phone data, real messages, external LLM, or general send tool.

## Current deployment mode

**Disabled, health-only.** `/healthz` returns 200 and every control request returns
503. The deployed entrypoint deliberately ignores the former static-key environment
variables. Enabling it requires implementing and verifying the OAuth adapter below,
plus separate approval for the concrete authentication setup and access scope.

Run `node --test`, `node scan.mjs`, and `node server.mjs`. No package installation
is necessary. Use Node 22 on Render. Build: `node --test bridge.test.mjs && node scan.mjs`.
Start: `node server.mjs`. Health check: `/healthz`. Choose Free, no database or disk.

## Authentication gate

The static bearer key in `bridge.mjs` is **only a local contract-test fixture**.
ChatGPT's authentication documentation explicitly says it cannot present custom
API keys. Its custom MCP guide documents OAuth, No authentication, and OAuth or
no authentication. Static credentials in the OAuth option mean OAuth client
credentials, not a key for this server. See the linked official references below.
Generic plugin-manifest API-key support does not establish support in ChatGPT's
custom MCP connection flow. Never switch this proof to an unauthenticated endpoint.

No OAuth authorization server, client, credential, or grant has been configured.
The actual private setup UI could not be inspected: the local browser was signed
out and desktop-app inspection was blocked. Unit/contract tests do not establish
ChatGPT compatibility or live integration readiness.

### Minimum next setup and implementation

Use an existing trusted OAuth authorization server if available, or separately
approve a managed provider. A self-hosted login/consent/token service would add
unnecessary security scope to this proof; no auto-approve or fake login endpoint
will be added. A provider is not selected yet, so provider-dependent code is paused.

Before implementing the resource adapter, resolve these exact inputs:

- Final HTTPS resource URL and canonical issuer, its discovery metadata and token
  validation mechanism (JWKS for signed access tokens, or protected introspection
  for opaque tokens). Use a maintained provider SDK or JOSE implementation.
- Authorization code flow with PKCE S256; metadata must advertise S256. The
  provider must honor the exact `resource` parameter and issue resource-bound
  access tokens. A generic Google/GitHub login token is not enough.
- One allowed owner identified by the immutable issuer + subject pair, and a
  narrowly defined `quicksilver:probe` scope. Provider login/consent must be real.
- Choose the supported client registration mechanism. For a pre-registered client,
  copy the exact redirect URI displayed by ChatGPT's management UI; no wildcard
  or guessed callback. CIMD is an alternative only if the provider supports it.
- Define an independently authenticated operator trigger for `/proof`; the MCP
  token should permit subscription/acknowledgement, not arbitrary proof initiation.
  Prefer a short-lived operator grant; do not reuse a server API key in ChatGPT.

Then implement protected-resource metadata and a 401 `WWW-Authenticate` discovery
challenge; validate signature/token activity, issuer, audience, expiry, subject and
scope before every MCP action. Bind subscriptions and acknowledgements to the
validated owner. Retain the one-hour maximum proof session and bounded in-memory
state. Provider metadata is served by the provider, not fabricated by this server.

Tests must reject invalid signature, issuer, resource audience, expired/missing
expiry, wrong subject/scope, ID tokens, and bypass via the old static key. Test
discovery and challenges, owner-bound subscription/acknowledgement, and expiry.
Provider PKCE/resource/redirect enforcement must be verified in an authorized live
OAuth flow; mocked tokens alone cannot prove it.

Action-time approval is needed before creating the concrete provider/client access,
entering any client secret into ChatGPT or hosting, and granting the connection.
The proposal must name the provider/tenant, resource, owner, scope, exact redirect,
grant lifetime, credential destinations, and teardown. No approval is implied by
the local tests. After the test, revoke the grant/client as appropriate and remove
test configuration. Hosting choice and billing approval remain separate gates.

## Intended proof flow (after OAuth implementation, approval, and verification)

1. Connect `/mcp` from the existing Athena. Event: `probe.created`, filter:
   `{"session":"quicksilver"}`. The owner instructs Athena to acknowledge the
   synthetic event using its `proof_id` and `nonce` only.
2. `events/subscribe` accepts one callback, verifies a signed challenge, and keeps
   the callback secret solely in memory. Subscription lifetime is capped by the
   session deadline. HTTPS callbacks must resolve exclusively to public IPv4
   addresses; each socket is pinned to the validated address. Redirects and IPv6
   are intentionally unsupported.
3. An authenticated operator POSTs empty JSON to `/proof`, producing one synthetic
   nonce. No arbitrary message text or destinations can be supplied.
4. Athena calls `acknowledge_probe`. Only the active matching proof can be acknowledged.
   An authenticated GET `/proof` distinguishes callback acceptance from acknowledgement.
5. Confirm the actual Athena task/tool trace. A server acknowledgement alone does
   not establish same-dot identity or owner authority. No iMessage success is claimed.

Failed/uncertain event delivery is not retried automatically. Unsubscribe and start
a new explicitly authorized test if needed. Restart loses subscription/proof state,
and requires a fresh subscription. No memory state is recovered or logged. Auth
configuration itself can persist in Render until removed or expired. Render Free
can sleep after 15 idle minutes or restart at any time. This deliberately ephemeral
test is **not production MCP Events storage** and cannot prove recovery guarantees.

## References

- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/plugins/build/auth
- https://developers.openai.com/api/docs/guides/custom-mcp-server
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://render.com/docs/free
