# Quicksilver

A temporary synthetic MCP Events connection proof. It has no Photon integration,
phone data, real messages, external LLM, or general send tool.

## Current deployment mode

**Disabled, health-only.** With no configured authentication, `/healthz` returns
200 and every control request returns 503. Do not change this until the user
approves the authentication mechanism and its specific access scope.

Run `node --test`, `node scan.mjs`, and `node server.mjs`. No package installation
is necessary. Use Node 22 on Render. Build: `node --test bridge.test.mjs && node scan.mjs`.
Start: `node server.mjs`. Health check: `/healthz`. Choose Free, no database or disk.

## Authentication gate

The test implementation accepts an Authorization bearer key, but **compatibility
with ChatGPT custom-server authentication is not yet verified**. The official
plugin authentication guide expects OAuth 2.1. If the account UI does not support
API-key/custom-header authentication, stop; implement a supported OAuth flow only
after its separate setup is agreed. Never switch to an unauthenticated endpoint.

After action-time approval, the operator would configure a fresh random value of
at least 32 bytes as `QUICKSILVER_API_KEY` through Render's secret UI and the
matching supported plugin authentication field. Do not paste it into a chat,
repository, URL, or command arguments. `QUICKSILVER_SESSION_EXPIRES_AT` must be an
absolute ISO time in the next hour; missing, invalid, expired, or longer lifetimes
disable the service. No deployment credential has been generated or configured.

## Bounded proof flow (after authentication approval)

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
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://render.com/docs/free
