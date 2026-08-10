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
server-owned OpenAI/DeepSeek/SiliconFlow/DashScope origins by default; development
still uses HTTPS-only, public-DNS, address-pinned transport. Failures return
safe generic categories and never expose keys or upstream response bodies.

The Settings page uses three provider presets: OpenAI Compatible, DeepSeek, and
阿里百炼. Every saved Base URL is canonicalized to end in `/v1`; users may
still edit the endpoint and model for compatible gateways. DeepSeek supports
Chat only. 阿里百炼 supports Chat and Qwen3-ASR; its TTS option is not enabled
yet. Existing browser settings without a preset are inferred and normalized on
read/save, without moving keys out of IndexedDB.

Recommended preset endpoints:

```text
OpenAI Compatible: https://api.openai.com/v1
DeepSeek:          https://api.deepseek.com/v1
阿里百炼:          https://dashscope.aliyuncs.com/compatible-mode/v1
```

For Alibaba Cloud Model Studio (DashScope) ASR, use its OpenAI-compatible
endpoint and a Qwen3-ASR-Flash model:

```text
Base URL: https://dashscope.aliyuncs.com/compatible-mode/v1
Model: qwen3-asr-flash
```

For a Beijing workspace-dedicated endpoint, replace the shared hostname with
`https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
Production accepts only this exact DashScope workspace hostname shape.

This adapter sends audio as a Base64 Data URL in `chat/completions`, matching
DashScope's OpenAI-compatible ASR API. It is distinct from the multipart
`audio/transcriptions` adapter used by ordinary OpenAI-compatible providers.
DashScope's compatible mode currently supports Qwen3-ASR-Flash models and does
not use Paraformer through this endpoint.

## Production build and proxy

Dockerfiles remain optional local portability paths. Build from repository root
only when container packaging is explicitly needed:

```sh
docker build -f apps/api/Dockerfile -t kotoba-api:local .
docker build -f apps/web/Dockerfile -t kotoba-web:local .
```

Tencent production does not build or upload Web/API application images. Host
release directories build the affected application from the exact Gitee SHA.

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

## Source mirror and host release identity

GitHub is canonical source, CI, and release identity. After `main` CI succeeds,
`sync-gitee.yml` checks out the exact full 40-character commit SHA and pushes it
to Gitee `main` over a dedicated SSH key. It uses fast-forward-only Git push,
never `--force` or `--mirror`, then reads Gitee `main` back and fails unless its
SHA exactly matches. Manual runs must provide the same full lowercase SHA.

Configure repository variable `GITEE_REPOSITORY` (`owner/repository`) and,
when needed, `GITEE_HOST`; store `GITEE_DEPLOY_KEY` and `GITEE_KNOWN_HOSTS` as
GitHub secrets. Workflow logs never print either secret.

Canonical service path:

```text
GitHub source + CI → Gitee source mirror → Tencent host services
                                           ├─ API/Web release
                                           ├─ Caddy HTTPS proxy
                                           └─ PostgreSQL/MinIO state
```

Gitee is source mirror and disaster-recovery copy, not production authority.
Tencent host services pull the approved exact SHA from Gitee, verify it before
release, and keep current/previous host release records. Host deployment must
not use branch head, short SHA, mutable image tag, or unverified source.

TCR is not part of the canonical Web/API production deployment. Production
release identity is verified source SHA plus host release manifest.

The host-specific Tencent Cloud procedure is deliberately untracked at
`docs/deploy-tencent-cloud.local.md`. It covers host preflight, source checkout,
Caddy backup/reload, service rollout, smoke tests, and rollback. Do not add
server addresses, Gitee private keys, API keys, `.env` values, or Docker
credentials to this repository.

## Validation

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:integration
```

CI also validates both example proxy configs, PWA release artifacts, deployment
shell syntax, and production shell script tags before strict CSP is released.
