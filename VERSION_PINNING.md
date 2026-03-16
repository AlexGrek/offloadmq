# Version Exchange Design

**Goal:** Both sides know what version they're talking to, logged and visible in management UI.

---

## What gets exchanged

**Agent → Server** (at registration): the agent sends its own version as part of `SystemInfo`.

```json
{
  "systemInfo": {
    "client": "offload-agent.py",
    "clientVersion": "0.2.1",
    ...
  }
}
```

The server stores this in the `Agent` model alongside the rest of `system_info`. It persists across restarts — no re-registration needed to update it; the existing `/private/agent/update` call (used on every poll cycle or reconnect) refreshes it.

**Server → Agent** (at authentication): the server includes its own version in the `AgentLoginResponse`.

```json
{
  "token": "eyJ...",
  "expiresIn": 3600,
  "serverVersion": "0.3.0"
}
```

The agent logs this on startup: `[auth] Connected to server v0.3.0 (agent v0.2.1)`.

---

## Agent version source

A single `VERSION` constant lives in `app/version.py`. Everything that needs the version imports it from there. PyInstaller-built binaries freeze this constant at build time — no runtime file reads.

---

## Compatibility policy

| Situation | Behavior |
|---|---|
| Versions match | Normal operation |
| Minor version mismatch | Log a warning, continue |
| Major version mismatch | Log a prominent warning, continue (no hard block) |

The agent compares on auth and logs accordingly. The server makes no compatibility decisions — it accepts all agents regardless of version.

---

## Where versions surface

- **Management UI → Agents page**: the `clientVersion` field from `system_info` shown alongside OS/arch in the agent detail card.
- **Agent startup log**: one line after successful auth showing both versions.
- **Management API**: `GET /management/agents/list` already returns the full agent including `system_info`, so `clientVersion` is available to any management tooling with no new endpoints needed.

---

## What does NOT change

- The version is informational only — no handshake, no negotiation, no rejection.
- Existing agents without `clientVersion` (older agents) are unaffected; the field is optional with a `null`/absent default.
- No new API endpoints required.
