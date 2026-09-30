# Database maintenance

The server keeps seven [sled](https://github.com/spacejam/sled) databases under
`DATABASE_ROOT_PATH` (`tasks`, `service_messages`, `agent_logs`, `heuristics`,
`agents`, `buckets`, `client_api_keys`).

## Retention (always on)

| Data | Env var | Default | Swept |
|------|---------|---------|-------|
| Finished tasks: live → archive | fixed 7 days after finishing | — | startup + every 3 h |
| Archived tasks: deleted | `TASK_ARCHIVE_RETENTION_DAYS` | 30 | same sweep |
| Service messages | `SERVICE_MESSAGE_RETENTION_DAYS` | 30 | startup + every 6 h |
| Agent logs | fixed 14 days | — | startup + every 6 h |

Each sweep posts a `task-archive-job` / `service-messages-cleanup-job` message to the
`bg` service-log class with the counts. A value of `0` (or garbage) falls back to the default.

`SLED_CACHE_MB` (default 64) caps each database's page cache.

## Reclaiming disk: compaction

sled never shrinks its files — deleting rows only lets it *reuse* the space. After a big
purge (e.g. the first retention run on a bloated database) the files stay the same size.
To give the disk back, rebuild the databases once:

1. Set `DB_COMPACT_ON_START=1` (Helm: uncomment it under `env:` in
   `offloadmq-chart/values.yaml`) and restart. Startup blocks until every database is
   done; the log shows `Compaction: <db> <before> -> <after> bytes`.
2. Unset it again — it is meant for **one** restart, not permanent.
3. Check sizes (`kubectl exec <pod> -- du -sh /data/db/*`) and that the service is healthy
   (`omqcli status`).
4. Delete the backups after a few days, once you trust the result:
   `kubectl exec <pod> -- sh -c 'rm -rf /data/db/*.bak-*'`.

How it works, per database: export every tree into `<db>.compact-tmp`, verify the sled
checksums match, rename `<db>` → `<db>.bak-<unix-ts>` and the copy into place. Any failure
(including a panic inside sled) removes the temp copy and leaves the original untouched; one
database failing never blocks startup or the others. Backups are **never** deleted
automatically.

Safety rails:
- Refuses when free space on the volume is below 2× the database size.
- Needs exclusive access, so it only runs before the server opens the databases.
- Until the backups are deleted the data directory holds roughly twice the data.
