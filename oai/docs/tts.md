# OAI — Text to Speech

End-user TTS feature wired to OffloadMQ `tts.*` capabilities (Kokoro and any
other agent-provided TTS model).

## Architecture

Mirrors the **image-analysis** shape (one job → one OffloadMQ task → text
result), but stores its result as an **audio blob** via OpenDAL instead of a
text column.

```
React  /app/tts  ──►  POST /api/tts/jobs  ──►  services/tts.rs ──► OffloadClient.submit_tts_task
                                                       │
                                                       ▼
                                                  tts_jobs row (status='submitted')
                                                       │
                                                       ▼ (every 10s)
                                              jobs/tts_worker.rs polls task
                                                       │
                                                       ▼
                                       on completed: decode audio_data_base64
                                                       │
                                                       ▼
                                       OpenDAL write → users/{uid}/tts/{job_id}.{ext}
                                                       │
                                                       ▼
                                       row → status='completed' + storage path/bytes
```

The browser plays/downloads the audio via `GET /api/tts/jobs/{id}/audio` (JWT
travels in `?token=`).

## Capability contract

| Field | Source |
|-------|--------|
| Capability base | `tts.<model>`, e.g. `tts.kokoro` |
| Bracket attributes | List of voice names — `tts.kokoro[af_heart;am_adam;bf_emma]` |
| Payload | `{ model, voice, input }` (`model` derived from capability tail) |
| Result | `{ audio_data_base64, content_type }` |

The capability listing endpoint exposes voices via the `voices` field on each
`TtsCapability`, parsed from the bracket attributes.

## Backend

- **Migration**: `m20260522_000017_create_tts_jobs`
- **Entity**: [db/entities/tts_jobs.rs](../backend/src/db/entities/tts_jobs.rs)
- **DB**: [db/tts.rs](../backend/src/db/tts.rs)
- **Service**: [services/tts.rs](../backend/src/services/tts.rs)
- **Worker**: [jobs/tts_worker.rs](../backend/src/jobs/tts_worker.rs)
- **Routes**: [routes/tts.rs](../backend/src/routes/tts.rs)
- **OffloadClient method**: `submit_tts_task(capability, model, voice, text)` in
  [offload/mod.rs](../backend/src/offload/mod.rs).

### REST surface

All routes require a JWT (`Authorization: Bearer …` or `?token=`).

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/tts/capabilities` | List online `tts.*` models with voice arrays |
| POST   | `/api/tts/jobs` | Submit `{ capability, voice, text }` → job_id |
| GET    | `/api/tts/jobs` | List the user's most recent 100 jobs |
| GET    | `/api/tts/jobs/{id}` | Get one job |
| POST   | `/api/tts/jobs/{id}/poll` | Force a reconcile pass against OffloadMQ |
| POST   | `/api/tts/jobs/{id}/cancel` | Cancel the in-flight task |
| POST   | `/api/tts/jobs/{id}/retry` | Re-submit a failed/canceled job |
| DELETE | `/api/tts/jobs/{id}` | Delete job + stored audio blob |
| GET    | `/api/tts/jobs/{id}/audio` | Stream the synthesized audio bytes |

### Storage path

Audio is stored at `users/{user_id}/tts/{job_id}.{ext}` where extension is
derived from the response `content_type` (`mp3`, `ogg`, `flac`, `aac`, default
`wav`). Storage backend must be enabled (`STORAGE_BACKEND=fs|s3`); request
returns 400 otherwise.

## Frontend

- **Page**: [pages/TtsPage.tsx](../frontend/src/pages/TtsPage.tsx) — sidebar +
  new-panel + job-detail with HTML `<audio>` player and download link.
- **Sidebar**: [components/tts/TtsHistorySidebar.tsx](../frontend/src/components/tts/TtsHistorySidebar.tsx)
- **API client**: [api/tts.ts](../frontend/src/api/tts.ts)
- **Route**: `/app/tts` (registered in `App.tsx`)
- **Dashboard tile**: violet "Text to Speech" tile.

Auto-polling cadence is 3 s and stops on terminal states (`completed`,
`failed`, `canceled`).

## Configuration

Optional env vars (with defaults):

| Var | Default | Purpose |
|-----|---------|---------|
| `TTS_WORKER_TICK_SECS` | `10` | Background reconcile cadence |
| `TTS_WORKER_BATCH_SIZE` | `20` | Jobs reconciled per tick |

No new dependencies — uses the existing `base64` crate already in `Cargo.toml`.
