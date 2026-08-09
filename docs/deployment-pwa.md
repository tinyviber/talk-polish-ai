# Daily Story production notes

Run web and API under one HTTPS origin. Production builds use
`VITE_APP_MODE=api` and an empty `VITE_API_URL`, so Daily Story always calls
relative `/api/daily-story/*` endpoints. Do not point a production Daily Story
build at another origin: browser-held provider credentials must pass only
through same-origin API requests.

## Browser and cache policy

Provider configuration is stored only in versioned IndexedDB on current
browser device. It must not appear in environment variables, deployment files,
server logs, database rows, localStorage, Cache Storage, React Query
persistence, or recording outbox. Browser reload may retain only stable,
non-secret conversation snapshots; no audio Blob survives it.

Service worker rules are mandatory:

- every `/api/*` request is NetworkOnly;
- authenticated, POST, multipart, Daily Story, and TTS/audio requests are
  never cached;
- navigation remains NetworkFirst with checked-in offline page fallback;
- cache namespace changes clean legacy navigation/prompt caches before release.

Keep `sw.js`, `manifest.webmanifest`, and `offline.html` revalidated
(`no-cache`). Hashed assets, local fonts, and icons may be immutable.

## Proxy baseline

[deploy/Caddyfile](../deploy/Caddyfile) and
[deploy/nginx.conf](../deploy/nginx.conf) are examples, not production server
configuration. Retain real domain, certificates, reverse-proxy targets, and
timeouts when carrying over the narrowly reviewed headers. Never copy the
placeholder Caddy site block onto a live host.

TanStack streaming output has a small, request-specific bootstrap script; a
static hash cannot cover it. Web creates a cryptographically random nonce for
each HTML response, applies it to every script tag, and emits exactly one CSP:

```text
default-src 'self'; connect-src 'self'; script-src 'self' 'nonce-<fresh-value>'
```

`script-src 'unsafe-inline'` is forbidden. CI proves one CSP header exists,
limits `connect-src` to self, binds every script tag to its response nonce, and
uses a different nonce for a second response. Caddy/Nginx
must forward this upstream header unchanged; do not add a proxy-level static
CSP, because multiple CSP headers intersect and static `script-src 'self'`
would block nonce-bound stream scripts. Existing `style-src 'unsafe-inline'`
is limited to style compatibility; it is not a script exception. Realtime is
hidden, so do not re-add `wss:` or broad `https:` to `connect-src`.

`/api/*` needs enough room for one 25 MiB audio file plus multipart framing:

- Caddy >=2.10: `request_body { max_size 30MiB }`
- Nginx: `client_max_body_size 30m`

Current 420s proxy timeout is legacy synchronous-pipeline baseline. Recompute
it with actual Daily Story upstream retry, ASR, chat, and network bounds before
changing either proxy. Keep app and proxy limits paired.

## Source release identity

GitHub remains canonical source and CI. After `main` CI succeeds,
`.github/workflows/sync-gitee.yml` pushes the exact full lowercase 40-character
commit SHA to Gitee `main` using a dedicated SSH key. Push is fast-forward-only:
the workflow never uses `--force` or `--mirror`. It reads Gitee `main` back and
fails closed when returned SHA differs from GitHub SHA. Manual dispatch also
requires an explicit full SHA.

Configure repository variable `GITEE_REPOSITORY` and optional `GITEE_HOST`;
keep `GITEE_DEPLOY_KEY` and `GITEE_KNOWN_HOSTS` in GitHub Secrets. Never commit
keys, known-host data, server addresses, or host `.env` values.

Gitee is source mirror and disaster-recovery copy. Tencent host services fetch
the approved exact SHA, use detached release directories, and verify
`git rev-parse HEAD` before any service change. Host release records must keep
current SHA, previous SHA, operator, build metadata, and smoke result.

## Host deploy commands

Install checked-in units as `talk-polish-api.service` and
`talk-polish-web.service` under existing unprivileged `kotoba` user. Keep
API-only credentials in `/opt/kotoba/shared/.env.api.production` (`0600`); Web
does not need that file. Confirm real Caddy topology and MinIO endpoint from
ignored Tencent runbook before enabling services. If Caddy remains a container,
set its production Compose service to exactly `network_mode: host` before proxying to
`127.0.0.1`; container-default networking cannot reach host-loopback services.

```sh
sudo install -m 0755 deploy/deploy-host.sh /opt/kotoba/deploy/deploy-host.sh
sudo systemctl enable talk-polish-infra.service talk-polish-api.service talk-polish-web.service
sudo systemctl start talk-polish-infra.service
GITEE_REMOTE='ssh://git@gitee.com/<owner>/<repository>.git' \
  /opt/kotoba/deploy/deploy-host.sh <full-tested-sha>
sudo systemctl start talk-polish-api.service talk-polish-web.service
sudo systemctl status talk-polish-api.service talk-polish-web.service
journalctl -u talk-polish-api.service -u talk-polish-web.service -n 100 --no-pager
```

Script locks full deploy with `flock`, fetches/verifies exact SHA, installs and
builds only affected apps, checks API/Web/MinIO health, and records
`current-sha`/`previous-sha`. It refuses unapproved migration files. Failure
restores previous release and restarts affected services; PostgreSQL/MinIO
containers and volumes are never removed. Use same script with a recorded
previous SHA for rollback, then rerun health and HTTPS smoke checks.

TCR runtime/dependency mirrors may support builds, but API/web app image tags or
digests are not canonical production release identity. Never deploy branch head,
short SHA, mutable tag, unverified source, or an unrecorded artifact. Details
for Tencent Cloud host operations remain in ignored
`docs/deploy-tencent-cloud.local.md`.

## Release checks

Before service cutover, confirm host release directory contains expected source
SHA and release manifest. Record current/previous release markers. Back up
active Caddyfile to a SHA-named server-local file, validate/reload only reviewed
header change, and verify live CSP/cache headers. On a Caddy validation, reload,
or header failure, restore/reload that backup before touching app services.

Restart only affected API/Web services. Do not use
`docker compose down -v`, alter PostgreSQL/MinIO volumes, change secrets, or
run an unplanned migration. Smoke HTTPS `/`, `/api/health/live`,
`/api/health/ready`, PWA manifest/shell, Daily-only UI, Settings gate, strict
CSP, and browser IndexedDB save/reload. The sentinel configuration value used
for browser verification must never be printed or sent upstream.

If app boot, readiness, proxy, or CSP fails, restore recorded Caddyfile and
previous source release, then restart affected services. Source rollback does
not imply database rollback; migration changes require separate backward-
compatibility review.
