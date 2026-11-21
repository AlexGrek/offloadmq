# Releasing OffloadMQ

This document covers releasing the agent (agent_v2: `omq` CLI + `omq-gui` GUI).
Server deployment (Docker + Helm) is separate — see `task ship` / `task deploy` in
[Taskfile.yml](../Taskfile.yml).

## Where releases go

Binaries are published to `dl.alexgr.space`, bucket `offload-agent`, one version slot
per release with one sub-slot per `<os>-<arch>`:

| File | Built by |
|---|---|
| `omq-linux-amd64`, `omq-gui-linux-amd64` | CI, on tag push |
| `omq-darwin-arm64`, `omq-gui-darwin-arm64` | `task release` on an Apple Silicon Mac |
| `omq-windows-<arch>.exe`, `omq-gui-windows-<arch>.exe` | `task release` / `scripts/release-agent.ps1` on Windows |

Latest build: `https://dl.alexgr.space/rs/offload-agent/latest/<os>-<arch>/<file>`.
The agent's self-updater and `task agent:update:mac|linux` read from here.

PyInstaller output is platform-specific, so each platform has to be built on that platform.

## Versioning

`release-v<MAJOR>.<MINOR>.<BUILD>`, where `BUILD` is `git rev-list --count HEAD`
(e.g. `release-v0.3.691`). [scripts/compute-agent-version.sh](../scripts/compute-agent-version.sh)
takes `MAJOR.MINOR` from the latest `release-*` tag and appends the current commit count,
so bumping `MAJOR.MINOR` means creating a tag with the new numbers by hand.

## Cutting a release

From the repo root on macOS (needs `DL_API_KEY`, stored in `~/.zshrc`):

```bash
task release
```

This computes the version, creates and pushes the `release-<version>` tag, then builds
and uploads the darwin binaries. The tag push triggers CI for the Linux binaries.

Run `task release` from Windows too if a Windows build is wanted — it reuses the
existing tag and uploads the Windows binaries under the same version.

`task release:agent` (or `./scripts/release-agent.sh [version]`) builds and uploads for
the current platform **without** tagging. Use it for a re-upload; a version released this
way has no Linux build until its tag is pushed.

### The ml-sharp submodule

`agent_v2/third_party/ml-sharp` (Apple SHARP, no PyPI package or releases) is a git
submodule bundled into both binaries as PyInstaller data (`ml-sharp/`), so
`omq sharp install` can build the optional `world.sharp` runtime from a released binary.
Every build path checks it out first: `scripts/release-agent.{sh,ps1}`,
`agent_v2/scripts/build-{macos,windows}-installer.*`, the `package:*` tasks (via
`task submodules`) and CI (`actions/checkout` with `submodules: true`). A missing
submodule fails PyInstaller loudly. To move SHARP to a newer upstream commit:
`git -C agent_v2/third_party/ml-sharp pull origin main`, commit the new pointer, and
agents report "up to date: FAIL" in `omq sharp doctor` until `--fix` reinstalls it.

## CI

[.github/workflows/build-client.yml](../.github/workflows/build-client.yml) runs only on
pushed `release*` tags. On `ubuntu-latest` it checks out the repo with submodules,
type-checks agent_v2, builds `omq` and
`omq-gui` for linux-amd64 with the version stamped from the tag, attaches them to the
GitHub release, and uploads them to `dl.alexgr.space` via `scripts/release-agent.sh`
with `SKIP_BUILD=1`. The dl key comes from the `RELEASER_API_KEY` secret in the `base`
environment.

## Rollback

Ship the fix as a new release. To withdraw a bad tag:
`git tag -d release-vX.Y.Z && git push origin :release-vX.Y.Z`, then delete its GitHub
release in the web UI. On a single agent, `omq update --rollback` restores the previous
binary it kept as `<exe>.prev` (Linux CLI only).
