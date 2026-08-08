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

## Image release identity

API and web Dockerfiles accept only TCR-mirrored Bun/Node runtime defaults and
use npm mirror during install. The image workflow runs only for `main` or
immutable `deploy/*` tag pushes:

1. Branch `codex/daily-story-conversation` full CI passes at exact 40-char
   head SHA. The publish workflow waits for and independently queries `ci.yml`;
   it refuses the tag unless both `checks` and `integration` succeeded for that
   SHA.
2. Operator pushes annotated `deploy/<that-sha>` tag at same commit.
3. Workflow peels and validates tag, downloads codeload source by verified
   commit SHA, then publishes `sha-<40-char-sha>` convenience tags.
4. Workflow summary records API/web immutable `repository@sha256:...` values.
5. Host sets only `API_IMAGE` and `WEB_IMAGE` to those exact digest values.

Do not deploy `latest`, a short SHA, mutable tag, local build, or a digest not
recorded by matching workflow/tag. Details for Tencent Cloud host operations
are intentionally in ignored `docs/deploy-tencent-cloud.local.md`.

## Release checks

Before app recreation, confirm host Compose resolves expected API/web images;
record current image values and container digests. Back up active Caddyfile to
a SHA-named server-local file, validate/reload only reviewed header change, and
verify live CSP/cache headers. On a Caddy validation, reload, or header failure,
restore/reload that backup before touching app containers.

Recreate only `api` and `web` with Compose `--force-recreate`. Do not use
`docker compose down -v`, alter PostgreSQL/MinIO volumes, change secrets, or
run an unplanned migration. Smoke HTTPS `/`, `/api/health/live`,
`/api/health/ready`, PWA manifest/shell, Daily-only UI, Settings gate, strict
CSP, and browser IndexedDB save/reload. The sentinel configuration value used
for browser verification must never be printed or sent upstream.

If app boot, readiness, proxy, or CSP fails, restore recorded Caddyfile and
API/web digest values, then recreate affected services. Image rollback does
not require database rollback because Daily Story adds no migration.
