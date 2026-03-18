# Releasing OffloadMQ

This document describes the release process and deployment workflow for OffloadMQ.

## Release Tags

Releases are triggered by creating **git tags matching the pattern `release*`**. When a tag matching this pattern is pushed, the GitHub Actions CI/CD pipeline automatically:

1. Builds the offload-agent Python package as a single-file executable
2. Uploads the artifact to the GitHub release

### Tag Naming Convention

Release tags **must** follow the format `release-vMAJOR.MINOR.PATCH.BUILD` where `BUILD` is the commit count from `git rev-list --count HEAD`.

The build number is mandatory to ensure traceability between releases and specific commits.

Examples:
```bash
# Get current commit count
git rev-list --count HEAD  # e.g., 142

# Create release tag with build number
git tag release-v0.1.142
git push origin release-v0.1.142

# Later release with more commits
git rev-list --count HEAD  # e.g., 156
git tag release-v0.2.156
git push origin release-v0.2.156
```

**Invalid formats** (do not use):
- `release-v1.0.0` (missing build number)
- `release-1.0.0.rc1` (rc tags without build count)

## CI/CD Workflow

The GitHub Actions workflow (`.github/workflows/build-client.yml`) is configured to run:

- **On branches**: `master`, `release` (on every push)
- **On tags**: `release*` (on tag creation matching the pattern)
- **On pull requests**: `master` (on every PR)

### Automated Release Artifacts

When a `release*` tag is pushed:

1. **Linux build**: The agent web UI is built with npm (`offload-agent/frontend`), then Python offload-agent is compiled to a single-file executable using PyInstaller (bundles `frontend/dist`)
2. **Artifact upload**: The executable is uploaded as a GitHub Release artifact and attached to the release page
3. **Release management**: Use GitHub's web interface to edit release notes and publish

## Manual Steps

After the workflow completes:

1. Go to GitHub Releases page
2. Find the release corresponding to your tag
3. Edit the release notes to document:
   - New features
   - Bug fixes
   - Breaking changes
   - Migration instructions (if any)
4. Publish the release

## Development Workflow

- **Feature/bugfix branches**: Push to `master` directly or via PR (workflow runs on both)
- **Pre-release testing**: Push to `release` branch (workflow runs for testing)
- **Official releases**: Create a `release*` tag (full build and upload)

## Rollback

If a release has a critical issue:

1. Delete the release from GitHub (web interface)
2. Delete the tag: `git tag -d release-vX.X.X && git push origin :release-vX.X.X`
3. Fix the issue and create a new release tag

## Server Deployment

The Kubernetes/Helm deployment is separate from the client release process. See `Dockerfile` and Helm charts for server deployment.
