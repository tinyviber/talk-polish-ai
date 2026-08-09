# Host deployment migration plan

## Current deployment

GitHub CI validates the monorepo. The current Tencent path builds API and web
Docker images on a Tencent self-hosted runner, pushes immutable digests to TCR,
and rolls those images through a private `/opt/kotoba` Compose deployment behind
Caddy. PostgreSQL and MinIO use persistent volumes and loopback-bound ports.
The private runbook is intentionally untracked and remains the source for real
host names, domains, ports, and secrets.

## Target deployment

GitHub remains canonical. A green GitHub Actions run synchronizes explicitly
named refs to Gitee and verifies the exact commit SHA. Tencent fetches the
tested SHA from Gitee into an immutable release directory, installs/builds only
what changed, and runs API/web as unprivileged systemd services. PostgreSQL and
MinIO remain Docker Compose infrastructure with existing volumes and loopback
bindings. Caddy remains containerized if the existing server runbook confirms it
is active; reverse-proxy behavior stays unchanged.

```text
GitHub (canonical)
  -> green CI
  -> Gitee branch mirror + SHA verification
  -> Tencent read-only Gitee fetch
  -> /opt/kotoba/releases/<full-sha>
  -> selective Bun install/build
  -> systemd API/web restart
  -> live/ready/web smoke
```

## Product fixes

- Add explicit `purpose` to Daily Story audio outbox records, with a versioned
  IndexedDB migration. Unknown legacy records default safely to `conversation`.
- Preserve `readAloudTarget` when needed and retry from persisted purpose, not
  React state. Read-aloud retry must finish in `review` and update
  `readAloudTranscript` without creating `pendingTranscript`.
- Remove English-only prompts from generic transcription providers. Daily Story
  may retain its request-scoped English hint.
- Bound WebM/Ogg-to-WAV normalization by the 25 MiB upload limit and test the
  oversized path.
- Handle microphone denial/cancellation in both ordinary and read-aloud flows.
- Format the current route file and rerun all CI stages.

## Gitee mirroring

`.github/workflows/sync-gitee.yml` will support push-triggered `main` sync after
CI success and manual `workflow_dispatch` for an explicitly selected branch and
full SHA. It will use `GITEE_SSH_PRIVATE_KEY`, `GITEE_KNOWN_HOSTS`, and
`GITEE_REPOSITORY` Actions secrets. Secrets never print. Only explicit branch
refs are pushed; no `--mirror`, force push, pull refs, or internal refs. The
workflow verifies Gitee's remote branch SHA equals the requested GitHub SHA and
fails on divergence.

## Server layout and services

The checked-in deployment assets use configurable defaults matching the existing
private runbook, but never replace its real domain or proxy config:

```text
/opt/kotoba/
  repo/                         # bare/cache clone from Gitee
  releases/<full-sha>/          # immutable checked-out source/build
  current -> releases/<sha>     # atomic active release pointer
  shared/.env.production        # server-only, mode 0600
  deploy/current-sha
  deploy/previous-sha
  logs/
```

The existing Caddy container must use `network_mode: host` for this topology
before it proxies to host-loopback services; otherwise container `127.0.0.1`
points at Caddy itself. Preserve its real TLS mounts and config. Alternatively
Caddy may become a host service, but the deployment must choose one topology
explicitly before cutover.

`talk-polish-infra.service` starts only PostgreSQL/MinIO Compose services after
Docker is ready; it never removes volumes. `talk-polish-api.service` and
`talk-polish-web.service` run as separate existing
least-privilege deployment user, bind only to localhost, restart on failure,
and log through journald. API reads a server-only API credential file; Web
receives no API/database/storage secret environment. Unit files contain no
secrets. Exact `ExecStart` commands follow the repository production scripts.

## Infrastructure

The repository Compose file remains local/infrastructure-only. Production
Compose must preserve PostgreSQL/MinIO volumes, credentials, network behavior,
and loopback bindings. Host processes use `127.0.0.1` ports, not Docker service
hostnames. The S3 policy permits only the exact configured local MinIO endpoint
for this topology; generic provider HTTPS/SSRF policy remains fail-closed.
No deployment runs `docker compose down -v`.

## Incremental deploy algorithm

`deploy/deploy-host.sh TARGET_SHA` validates a full lowercase 40-hex SHA, takes
an `flock`, fetches from the configured Gitee remote, verifies the exact commit,
and computes `OLD_SHA..TARGET_SHA` changed paths. It installs with
`bun install --frozen-lockfile` only when dependency manifests changed. It builds
web for web-impacting paths and API for API-impacting paths; contracts and root
dependency/build changes conservatively affect both. Docs-only changes do not
restart services. Builds happen in a new release directory, before the active
symlink changes. Health failure leaves the old release active and restores the
previous service state. Current/previous SHA markers update only after smoke
passes. The script is idempotent for the current SHA.

Database migration uses the existing API migration command only when migration
files changed, and is a separate reviewed step. Destructive reset/seed and
volume deletion are forbidden. Non-backward-compatible migrations block the
deployment instead of pretending source rollback can undo schema changes.

## CI changes

CI keeps format, lint, typecheck, unit, build, integration, proxy, PWA, and
production smoke validation. App Docker builds stop being the production
release gate; Docker remains optional local portability. The old TCR app-image
publish workflow is removed/replaced so Web/API deployment identity is the
tested Git commit SHA, not an image digest. Gitee sync is the explicit mirror
release path and never deploys every PR automatically.

## Security boundaries

- GitHub Actions may write Gitee; Tencent server has a separate read-only Gitee
  credential and no GitHub write credential.
- SHA, ref, repository, and target paths are validated before shell use; no
  `eval`, `sh -c` with user input, or unsafe ref interpolation.
- Secrets stay in Actions secret storage or the server env file; no command-line
  or unit-file secret exposure.
- Public firewall/proxy exposes only HTTPS (and HTTP redirect if already active);
  API, web, PostgreSQL, MinIO, and MinIO console bind privately.
- Provider URLs retain SSRF, DNS pinning, redirect, and HTTPS restrictions.

## Cutover and rollback

Before cutover, record the active Compose services, Caddy config, current app
images, database/MinIO volume names, and public health results from the private
runbook without printing secrets. Prepare and smoke host services on localhost,
then switch proxy upstreams, run external smoke, and only then stop old app
containers. On any failure, restore the previous proxy target/services or
release symlink; leave PostgreSQL, MinIO, and volumes untouched. Keep old app
containers until host deployment passes production smoke.

## Required validation

Local: `bun install --frozen-lockfile`, format, lint, typecheck, unit, build,
integration, `git diff --check`, deployment script shell/static tests, and
changed-path cases for docs/web/api/contracts/lockfile/rollback/lock contention.

Remote: full GitHub CI green, Gitee SHA equals GitHub SHA, production SHA equals
both, API live/ready, web HTTPS/PWA/CSP smoke, Daily Story UI smoke, cached normal
ASR retry, cached read-aloud retry, Japanese legacy transcription, and oversized
audio handling. If server or Gitee credentials are unavailable, report exact
missing secret/config and the single follow-up workflow/command; never invent it.
