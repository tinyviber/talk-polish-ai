# Deployment guide

## CI: no LLM key required

GitHub Actions does not need `CHAT_API_KEY`, `TRANSCRIPTION_API_KEY`, or
`TTS_API_KEY`. The integration job uses deterministic mock providers and local
audio storage. It needs only Bun 1.2.17, the PostgreSQL 16 service container,
`DATABASE_URL`, `ANON_TOKEN_SECRET`, and `DATA_DIR`.

The checks job builds the API image but does not start it. No LLM, MinIO, or
other external provider is needed. Do not add provider secrets to CI. The
PostgreSQL service is intentional: migrations and PostgreSQL-specific queries
are part of the integration contract. A free-tier hosted database would add
network, quota, and cleanup flakiness.

## Local setup

Requirements: Bun 1.2.17, Docker, and an HTTPS-capable browser for microphone
testing.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run db:up
bun run db:migrate
bun run db:seed
bun run dev:api
# second terminal
bun run dev
```

For demo mode, leave `VITE_APP_MODE=demo`. For the API flow, set
`VITE_APP_MODE=api` and `VITE_API_URL=http://localhost:3333`, then restart the
web dev server.

## Real LLM providers

Real providers are optional. Enable them only in the server environment:

```dotenv
ASSESSMENT_PROVIDER=openai-compatible
TRANSCRIPTION_PROVIDER=openai-compatible
TTS_PROVIDER=openai-compatible
```

Keep provider URLs and keys server-side. Never use `VITE_*` for secrets and
never commit `.env` or `llm_config.json`.

The local `llm_config.json` format can be converted into a templated `.env`:

```sh
bun run llm:env -- --input llm_config.json --output .env --enable-providers
```

The command refuses to overwrite an existing `.env`; add `--force` only when
you intentionally want to update its provider values. With `--force`, the
existing file is used as the template, so database, storage, auth, and custom
settings are preserved. New files start from `.env.example`. It writes mode,
URL, key, and first model values for complete chat, transcription, and TTS
sections, forces transcription capability detection back to `auto`, sets mode
only when all three provider values are present, and never prints secret
values. Output permissions are forced to `0600`.

For production, prefer a secret manager or deployment-platform environment
variables over a file. Rotate any key that was ever committed or shared.

## Production topology

Use PostgreSQL, S3-compatible audio storage (Cloudflare R2 or MinIO), the API,
and the web server. Real provider keys are needed only when the corresponding
provider mode is `openai-compatible`; database and storage credentials are
always needed by the API. Build the web app with `VITE_APP_MODE=api` and an
empty `VITE_API_URL` for same-origin `/api` routing.

```sh
export NODE_ENV=production
bun install --frozen-lockfile
bun run db:migrate
bun run db:seed
bun run build
```

Run the API on `:3333` and the TanStack Start Node server on `:3000`.
Reverse-proxy both behind one HTTPS origin using [`deploy/Caddyfile`](../deploy/Caddyfile)
or [`deploy/nginx.conf`](../deploy/nginx.conf). HTTPS is required for
microphone access, service workers, and iPhone PWA installation.

Set at minimum: `NODE_ENV=production`, a strong `ANON_TOKEN_SECRET`, explicit
`CORS_ORIGIN`, a production `DATABASE_URL`, and `AUDIO_STORAGE_DRIVER=s3` with
S3/R2 credentials. Add provider settings only when real ASR/assessment/TTS is
enabled. Do not use the example token or MinIO development credentials in
production. Verify `/health/live` and `/health/ready` before sending traffic.

Deploy the web output atomically and keep the previous release until the new
service worker activates. Run `bun run db:migrate` before sending API traffic.
See [`deployment-pwa.md`](./deployment-pwa.md) for cache and iPhone recovery
details.

## Container choice

Docker Compose is local infrastructure only: it starts PostgreSQL and MinIO,
but does not deploy the API/web app or run migrations and seed. CI uses only a
PostgreSQL service container; this is smaller and deterministic. The API image
build is separate and does not require a running database or provider. Avoid
calling online free-tier LLMs from CI: tests should stay deterministic, fast,
and secret-free.
