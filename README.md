# Daily Story Conversation

Daily Story Conversation turns a short Chinese story into a private English
conversation. Start with story context, speak or use the explicit typed
fallback, then end with up to three focused review suggestions.

## Privacy boundary

Chat, ASR, and optional TTS settings live only in browser IndexedDB on current
device. Daily Story sends only capability-specific settings with each
same-origin request; it does not put provider keys in server environment,
database, logs, browser localStorage, Cache Storage, React Query state, or
recording outbox. A server never receives another capability's key.

The API is behind one HTTPS origin:

```text
https://app.example.com/
  /                    -> web :3000
  /api/daily-story/*   -> API :3333
```

Daily Story routes require anonymous learner authentication and use
`Cache-Control: private, no-store`. Browser service worker policy keeps every
`/api/*` request, POST/multipart upload, and TTS audio network-only.

## Local development

Requirements: Bun 1.2.17, Docker, and a browser with microphone support.

```sh
bun install
cp .env.example .env
bun run db:up
bun run db:migrate

# terminal 1: API on http://localhost:3333
bun run dev:api

# terminal 2: web app
bun run dev
```

For production-like same-origin development, use `VITE_APP_MODE=api` and leave
`VITE_API_URL` empty. Daily Story rejects cross-origin API use; provider calls
always go through its same-origin API routes.

## Daily Story API

- `POST /api/daily-story/start`
- `POST /api/daily-story/transcribe` (one audio part and ASR config)
- `POST /api/daily-story/reply`
- `POST /api/daily-story/review`
- `POST /api/daily-story/tts`
- `POST /api/daily-story/provider-check`

Provider configuration is validated per capability. Production accepts only
server-owned DeepSeek/SiliconFlow origins by default; development still uses
HTTPS-only, public-DNS, address-pinned transport. Failures return safe generic
categories and never expose keys or upstream response bodies.

## Production build and proxy

Both Dockerfiles build from Tencent Container Registry (TCR) base images, not
Docker Hub. Build from repository root:

```sh
docker build -f apps/api/Dockerfile -t kotoba-api:local .
docker build -f apps/web/Dockerfile -t kotoba-web:local .
```

Use [deploy/Caddyfile](deploy/Caddyfile) or
[deploy/nginx.conf](deploy/nginx.conf) only as reviewed examples. They use
`example.com`; never overwrite server Caddy/Nginx configuration, site address,
TLS, reverse-proxy targets, or timeout/body settings. Web emits exactly one
per-response CSP, including a fresh nonce for TanStack's streamed bootstrap
script:

```text
connect-src 'self'; script-src 'self' 'nonce-<fresh-value>'
```

Dynamic inline scripts must carry that exact nonce; third-party scripts remain
forbidden. Caddy/Nginx forward this web response header and must not append a
second static CSP, because policies intersect and would block nonce-bound
scripts. `style-src 'unsafe-inline'` remains only for shell styling
compatibility and does not permit scripts. Caddy uses
`request_body { max_size 30MiB }`: keep that complete multipart request limit
at 30 MiB while individual audio file limit is 25 MiB; adjust proxy timeout
and body limits together when API limits change.

See [docs/deployment-pwa.md](docs/deployment-pwa.md) for release safeguards.

## CI, TCR, and rollout identity

`codex/daily-story-conversation` has a dedicated full-CI push trigger in
addition to pull-request checks. It does not publish images. After that exact
head SHA is green, an operator creates an annotated
`deploy/<40-character-commit-sha>` tag at that commit. The TCR workflow rejects
lightweight, malformed, mismatched, or ungreen tags: it verifies successful
`checks` and `integration` jobs from `ci.yml` for that exact commit (waiting
for concurrent main CI when needed), builds source downloaded by that commit
SHA, and emits immutable API and web `repository@sha256:...` references.

`sha-<40-character-commit-sha>` is only a convenience locator. Deployment and
rollback must set `API_IMAGE` and `WEB_IMAGE` to recorded digest references,
never `latest` or an unverified tag. Main may update `latest`; deploy tags do
not.

The host-specific Tencent Cloud procedure is deliberately untracked at
`docs/deploy-tencent-cloud.local.md`. It covers preflight, Caddy backup/reload,
digest rollout, smoke tests, and rollback. Do not add server addresses, TCR
passwords, API keys, `.env` values, or Docker credentials to this repository.

## Validation

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:integration
```

CI also validates both example proxy configs, API/web Docker builds, PWA release
artifacts, and production shell script tags before strict CSP is released.
