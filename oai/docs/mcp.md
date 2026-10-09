# OAI MCP server

OAI exposes its image generation as a remote [MCP](https://modelcontextprotocol.io) server, so
Claude can generate images, manage jobs, and use the prompt library from any Claude app,
including the **mobile app**. It covers the same ground as `oai image …` in the Go CLI
(`oai/cli/`).

- **Endpoint:** `https://oai.alexgr.space/mcp` (Streamable HTTP, stateless)
- **Auth:** OAuth 2.1 with Dynamic Client Registration and PKCE; users sign in with their OAI
  login and password
- **Code:** `backend/src/mcp/` (transport + tools), `backend/src/services/oauth.rs` +
  `routes/oauth.rs` + `db/oauth.rs` (authorization server), `services/prompt_expansion.rs`
  (server-side `{placeholder}` expansion)

## Connecting

**Claude (web, desktop, mobile):** on claude.ai open *Settings → Connectors → Add custom
connector*, enter `https://oai.alexgr.space/mcp`, and leave the OAuth client ID/secret empty.
Claude registers itself and opens the OAI sign-in page; sign in and press **Allow**. Connectors
sync to the desktop and mobile apps, so after this the tools are available on the phone too.

**Claude Code:**

```bash
claude mcp add --transport http oai https://oai.alexgr.space/mcp
# then /mcp inside Claude Code to sign in
```

**Scripts / testing:** `/mcp` also accepts a regular OAI user JWT, the one `oai login` stores:

```bash
curl -s https://oai.alexgr.space/mcp \
  -H "Authorization: Bearer $(jq -r .token ~/.oai-cli.json)" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**MCP Inspector:** `npx @modelcontextprotocol/inspector`, then use transport "Streamable HTTP"
and URL `…/mcp`. CORS on `/mcp` and the OAuth endpoints allows any origin.

## Tools

| Tool | CLI equivalent | Notes |
|------|----------------|-------|
| `list_image_models` | `oai image capabilities` | Online/offline status, tags (txt2img, img2img…), recent usage |
| `generate_images` | `oai image generate` | `prompt`, `negative_prompt`, `model`, `workflow`, `input_image_id` (img2img), `width`/`height`, `seed` (job N uses seed+N), `count` ≤10, `save_to_history`, `star_prompt`, `wait_seconds` |
| `get_image_job` | `oai image job` / `poll` / `download` | Forces a reconcile; optional `wait_seconds`; returns previews and links |
| `list_image_jobs` | `oai image jobs` | `status` (comma list), `active_only`, `limit` ≤50 |
| `cancel_image_jobs` | `oai image cancel` | Several IDs; continues past failures |
| `retry_image_job` | `oai image retry` | New job with identical settings, waits like generate |
| `delete_image_jobs` | `oai image delete` | Also deletes the stored images |
| `view_image` | — | One image at up to 1024 px, so Claude can actually look at it |
| `list_saved_prompts` | `oai image prompts recent\|starred` | `kind`, `negative`, `query`, `limit`, `cursor` |
| `get_saved_prompt` | `oai image prompts show` + `preview` | Full text plus the preview image |
| `star_prompt` | `oai image prompts star` / `unstar` | `text` or `entry_id`; `starred:false` unstars (exact text) |
| `edit_saved_prompt` / `delete_saved_prompts` | `oai image prompts edit` / `delete` | |
| `list_placeholders` | `oai image placeholders list` | Custom placeholders plus the built-ins |
| `save_placeholder` | `create` / `set` / `add` / `remove` / `rename` | Create if missing; `variants` (replace), `add_variants`, `remove_variants`, `rename_to` |
| `delete_placeholders` | `oai image placeholders delete` | By name or ID |
| `expand_prompt` | `oai image placeholders expand` | Same expander as `generate_images` |

The CLI and this table should stay in step: a new `oai image` feature gets a tool here too.

### Waiting and results

- Claude's hosted apps give a tool call **240 s**. `wait_seconds` defaults to 150 for
  generate/retry and 0 for `get_image_job`, with a maximum of 200.
- A job that is still running when the wait ends is **not** an error. The result tells Claude
  to call `get_image_job` with the job ID. `wait_seconds: 0` is the CLI's `--no-wait`.
- Polling every 5 s goes through `image_jobs::poll_job`, the same forced reconcile as
  `POST /api/images/jobs/{id}/poll`. The background `image_pipeline_worker` keeps going
  regardless.
- Images come back two ways:
  - **Inline previews.** The stored 384 px thumbnails are sent as MCP `image` content,
    re-encoded at 256 px if needed. They share a budget of about 110k base64 characters per
    result, because Claude caps a whole tool result at about 150k characters. Images that
    don't fit are listed by link only.
  - **Signed links** to the full-resolution file:
    `/mcp/files/{image_id}?u=&exp=&sig=`, an HMAC-SHA256 over id, owner and expiry, keyed
    from `JWT_SECRET`. They are valid for `MCP_FILE_LINK_TTL_HOURS` (default 24), so no user
    JWT ever appears in a transcript.

### Placeholders

`generate_images` expands `{color} {animal} {adjective} {country} {language} {name} {starwars}`
and the user's custom placeholders on the server. It uses one expander per call, so a batch
never repeats a value, and the word lists are the web UI's own (`unique-names-generator`,
copied into `backend/src/services/placeholder_dicts/` by
`backend/scripts/gen-placeholder-dicts.mjs`). `{?}` is left for job creation, as everywhere
else. The raw template is sent as `prompt_template`, so saved-prompt previews attach to it.

## OAuth

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728; `resource` = `{base}/mcp` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata |
| `POST /oauth/register` | RFC 7591 DCR. Public clients only; redirect URIs must be `https` or loopback `http` |
| `GET /oauth/authorize` | Server-rendered sign-in and consent page; shows the client name and redirect host |
| `POST /oauth/authorize` | Form submit; per-IP rate limited (bcrypt). Returns a 303 to the redirect with `code`, `state`, `iss` |
| `POST /oauth/token` | Form-encoded. `authorization_code` (S256 PKCE required) and `refresh_token` |
| `POST /oauth/revoke` | RFC 7009. Revoking a refresh token ends the whole connection |

- **Tokens** are opaque. Only their SHA-256 is stored, in `oauth_tokens`. Access tokens last
  1 h; refresh tokens last 30 d and **rotate** on every use. A rotated token reused more than
  2 minutes later revokes the whole grant, which counts as theft. Codes last 5 minutes and are
  single-use.
- **Redirect matching** is exact, except that loopback `http` URIs ignore the port, because
  Claude Code uses an ephemeral port. Unknown clients and mismatched redirects get an error
  page and are never redirected.
- **No per-IP limit** applies to `/oauth/token`, `/oauth/register` or `/mcp`. All of Claude's
  traffic comes from Anthropic's shared egress range (`160.79.104.0/21`).
- **Changing the password** (`POST /api/auth/change_password`) revokes every MCP connection
  the user has.
- **Cleanup:** `jobs/oauth_cleanup_worker.rs` runs hourly (`OAUTH_CLEANUP_TICK_SECS`). It
  deletes expired codes, tokens and grants that have been dead for 7 days, and DCR clients
  that never completed a sign-in within 24 h.

## Protocol details

- **Dual-era server.** Legacy clients open with `initialize` (`2024-11-05` … `2025-11-25`; an
  unknown version gets `2025-11-25`). Modern `2026-07-28` clients carry the version in
  `_meta["io.modelcontextprotocol/protocolVersion"]` and may call `server/discover`.
- **Modern requests are validated.** An unsupported version gets 400 / `-32022`.
  `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` headers that disagree with the body get
  400 / `-32020`. An unknown method gets 404 / `-32601`.
- **Stateless.** There is no `Mcp-Session-Id`, so the server survives pod restarts. `GET` and
  `DELETE /mcp` answer 405. Notifications get 202.
- **Origin header.** Requests with an `Origin` are rejected with 403 unless it is the server
  itself, `claude.ai`/`claude.com`, loopback, or listed in `CORS_ALLOWED_ORIGINS`. Claude's
  backend sends no `Origin`.
- **Errors.** A tool failure comes back as an `isError: true` result with a readable
  message; only an unknown tool name is a JSON-RPC error.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `PUBLIC_BASE_URL` | from `X-Forwarded-Proto`/`-Host` or `Host` | OAuth issuer and `{base}/mcp` resource. Helm sets `https://<ingress.host>` |
| `MCP_FILE_LINK_TTL_HOURS` | `24` | Lifetime of signed image links |
| `OAUTH_CLEANUP_TICK_SECS` | `3600` | OAuth cleanup interval |

## Testing

- **Unit tests:** `cd oai/backend && cargo test`. Covers PKCE, redirect matching, the
  dispatcher, version negotiation, the expander, and the image budget.
- **Integration:** `oai/itests/tests/test_mcp.py`. Covers discovery, DCR, consent, tokens,
  rotation, revocation, the protocol, and the agent-free tools.
- **Generation end to end** needs an online `imggen.*` agent. Locally, run OffloadMQ with
  `HOST`/`PORT` set to spare values, point OAI's admin settings at it, and attach any agent
  that uploads its output to `data.output_bucket` and resolves with
  `{"images":[{"file_uid","filename"}]}`.
