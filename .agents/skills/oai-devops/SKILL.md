---
name: oai-devops
description: >-
  Deploy, upgrade, and troubleshoot OAI on Kubernetes (Helm, Garage S3, Postgres,
  Docker). Use when working on oai/helm-chart/**, oai/Dockerfile, oai/docker-compose*.yml,
  oai/Taskfile.yml deploy tasks, garage-init failures, ImagePullBackOff, wait-garage-creds,
  helm upgrade, task deploy/ship, or oai.alexgr.space outages.
---

# OAI DevOps — Deploy & Troubleshoot

OAI runs in namespace `oai`, release name `oai`, public URL `https://oai.alexgr.space`. All deploy commands run from **`oai/`** via [Go Task](https://taskfile.dev) (`task`), not Make.

| Constant | Value |
|----------|-------|
| Release / fullname | `oai` |
| Namespace | `oai` |
| Chart | `oai/helm-chart/` |
| Image | `grekodocker/oai:<git-short-hash>` |
| Ingress host | `oai.alexgr.space` |

---

## Cluster layout

```
Ingress (Traefik + cert-manager) → Service oai:3000 → Deployment oai
  ├── Init: wait-garage-creds (busybox, checks mounted secret files)
  └── Container: oai (Rust backend + static frontend)

StatefulSet oai-postgres-0  →  Secret oai-secret (DATABASE_URL, JWT, …)
StatefulSet oai-garage-0    →  S3 API :3900, admin :3903

Job oai-garage-init (Helm post-install/post-upgrade hook)
  → creates Secret oai-garage-creds (S3 access key for the app)
```

**OffloadMQ** is not in this chart — configure `OFFLOAD_MQ_URL` / client key in the admin UI after deploy.

---

## Commands (from `oai/`)

```bash
task infra:up          # local: Postgres + Garage (docker-compose.dev.yml)
task dev               # local backend :3001 + Vite :5174
task build             # frontend dist + cargo release
task docker:build      # local amd64 image, tag = git short hash
task docker:release    # build + push grekodocker/oai:<hash> and :latest
task deploy            # helm upgrade --set image.tag=<git hash>  ⚠ see Image tag below
task ship              # docker:release then deploy (full pipeline)
task template          # render chart locally
task lint              # helm lint
task status / history / rollback / undeploy
```

**Production deploy rule:** `task deploy` only works if `grekodocker/oai:<GIT_HASH>` already exists on Docker Hub. Use **`task ship`** when the commit changed, or push the image first then deploy.

Override image without rebuilding:

```bash
helm upgrade --install oai ./helm-chart --namespace oai --create-namespace \
  --set image.tag=6d5655b
```

---

## Helm hook ordering (Garage enabled)

Non-hook resources apply first (Postgres + Garage StatefulSets, Services, Ingress, Secrets template). Then **post-install / post-upgrade** hooks by weight:

| Weight | Resource | Purpose |
|--------|----------|---------|
| -20 | ServiceAccount, Role, RoleBinding | `oai-garage-init` can write secrets |
| -10 | ConfigMap `oai-garage-init-script` | `init.sh` |
| -5 | Job `oai-garage-init` | layout, bucket, API key → `oai-garage-creds` |
| 10 | **Deployment `oai`** | starts only after hooks; needs creds secret |

The Deployment is a hook so pods are not created before `oai-garage-creds` exists. `hook-delete-policy: before-hook-creation` recreates the Deployment each upgrade (brief rollout).

---

## Garage init job (`oai-garage-init`)

Script: `oai/helm-chart/templates/garage-init-script.yaml` (mounted at `/scripts/init.sh`).

Flow:

1. Skip if `oai-garage-creds` already has `garage-access-key-id`
2. Wait for `GET /v2/GetClusterStatus` (≥1 node)
3. If node has no `role`: **UpdateClusterLayout** → **ApplyClusterLayout** (`version = layoutVersion + 1`)
4. Wait for `GET /v2/GetClusterHealth` → `status == "healthy"`
5. `CreateBucket` (global alias from `values.garage.storage.bucket`, default `oai`)
6. `CreateKey` + `AllowBucketKey` → `kubectl apply` secret `oai-garage-creds`

Admin API auth: `Authorization: Bearer <garage.rpcSecret>` (same value as `admin_token` in `garage.toml`).

### Garage v2 layout API (common failure)

**Wrong** (returns HTTP 200 with `InvalidRequest` in body; `ApplyClusterLayout` then fails; job exits at layout step):

```json
{ "<node-id>": { "zone": "k8s", "capacity": 21474836480, "tags": [] } }
```

**Correct:**

```json
{ "roles": [{ "id": "<node-id>", "zone": "k8s", "capacity": 21474836480, "tags": [] }] }
```

Chart validates staged changes: `jq -e '(.code | not) and ((.stagedRoleChanges | length) >= 1)'`.

---

## Known deployment struggles

### 1. Job `oai-garage-init` Failed / BackoffLimitExceeded

**Symptoms:** `kubectl get job -n oai`; logs stop after “Applying initial cluster layout…”; no `oai-garage-creds` secret.

**Checks:**

```bash
kubectl logs -n oai -l job-name=oai-garage-init --tail=80
kubectl get pods -n oai -l job-name=oai-garage-init
```

**Fixes:**

- Fix layout payload in chart (see above), `helm upgrade`, delete failed job if stuck: `kubectl delete job -n oai oai-garage-init` (hook recreates on upgrade).
- If layout already applied but secret missing: re-run upgrade; job skips layout when `nodes[0].role` is set and creates key + secret.

### 2. Pod stuck `Init:0/1` — `wait-garage-creds`

**Symptoms:** Logs show `waiting for garage-init job to populate credentials (N/360)…`; `ls /etc/oai-garage/` inside init container is empty.

**Causes:**

- Garage-init job never completed (no secret).
- **Race (older chart):** pod started before secret existed with `optional: true` on the volume; kubelet may not populate files when secret appears later.

**Fixes:**

- Ensure `oai-garage-creds` exists: `kubectl get secret -n oai oai-garage-creds`
- Delete pod to remount: `kubectl delete pod -n oai -l app.kubernetes.io/instance=oai`
- Current chart: Deployment is hook weight 10; secret volume is **not** optional.

### 3. `ImagePullBackOff` — `grekodocker/oai:<hash>: not found`

**Cause:** `task deploy` sets `image.tag` to current git hash, but image was never pushed.

**Fix:** `task ship` or `task docker:release`, then deploy. Or deploy an existing tag: `--set image.tag=<published-hash>`.

```bash
helm get values oai -n oai --all
kubectl describe pod -n oai -l app.kubernetes.io/instance=oai | grep -A2 "Failed"
```

### 4. Two ReplicaSets / old pod Terminating

Normal during rolling hook-based Deployment recreate. Wait until one pod `1/1 Running` and `deployment.apps/oai` shows `READY 1/1`.

### 5. App up but storage broken

Verify env from secret:

```bash
kubectl exec -n oai deploy/oai -- env | grep STORAGE_
```

Garage S3 endpoint inside cluster: `http://oai-garage:3900`, bucket `oai`, region `us-east-1` (from `values.yaml`).

### 6. Ingress / TLS

```bash
kubectl get ingress -n oai
kubectl get certificate -n oai   # if cert-manager installed
```

---

## Diagnostic checklist

Run when user reports “OAI deployment broken”:

```bash
kubectl get pods,job,secret,ingress -n oai
kubectl get events -n oai --sort-by='.lastTimestamp' | tail -30
kubectl logs -n oai -l job-name=oai-garage-init --tail=50
kubectl logs -n oai deploy/oai -c wait-garage-creds --tail=20 2>/dev/null || true
kubectl logs -n oai deploy/oai -c oai --tail=50
kubectl run -n oai curl-health --rm -i --restart=Never --image=curlimages/curl:8.5.0 \
  -- curl -sf http://oai.oai.svc.cluster.local:3000/api/health
```

**Healthy cluster:**

| Resource | Expected |
|----------|----------|
| `pod/oai-*` | `1/1 Running` |
| `job/oai-garage-init` | `Complete 1/1` |
| `secret/oai-garage-creds` | exists, keys `garage-access-key-id`, `garage-secret-access-key` |
| `pod/oai-postgres-0`, `pod/oai-garage-0` | `1/1 Running` |
| `/api/health` | `{"status":"ok"}` |

---

## Chart values & secrets to change in production

Edit `oai/helm-chart/values.yaml` or pass `--set` / `-f` overrides:

| Value | Default | Notes |
|-------|---------|-------|
| `secret.jwtSecret` | `change-me-in-production` | App JWT signing |
| `postgres.password` | `change-me-in-production` | Wired into `oai-secret` |
| `garage.rpcSecret` | 64-char hex | Garage RPC + admin bearer token |
| `ingress.host` | `oai.alexgr.space` | |
| `garage.persistence.*` | PVC sizes / storageClass | |
| `resources` | memory only (no CPU limits) | Scheduling on small nodes |

Generated at runtime (do not hand-edit unless recovering): **`oai-garage-creds`**.

---

## Local vs Kubernetes storage

| Environment | `STORAGE_BACKEND` | Notes |
|-------------|-------------------|-------|
| `task dev` | often unset / fs | `STORAGE_FS_ROOT` in backend `.env` |
| Helm (garage.enabled) | `s3` | Endpoint `http://oai-garage:3900`, creds from `oai-garage-creds` |

Local Garage: `task infra:up` (compose). K8s Garage: StatefulSet + init job only.

---

## Files to read before changing deploy

| Topic | Path |
|-------|------|
| Task workflows | `oai/Taskfile.yml` |
| App env in pod | `oai/helm-chart/templates/deployment.yaml` |
| Garage bootstrap | `oai/helm-chart/templates/garage-init-script.yaml` |
| Defaults | `oai/helm-chart/values.yaml` |
| Docker image | `oai/Dockerfile` |
| Product overview | `CLAUDE.md` § OAI |

---

## Related skills

- **oai-frontend** — UI work, not cluster deploy
- **oai-itests** — API tests against local backend (`task dev` + `task itest`)
