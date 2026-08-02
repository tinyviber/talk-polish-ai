# Kotoba Loop

Kotoba Loop is a speaking-practice MVP for English and Japanese. The existing calm, editorial UI keeps the short loop intact: prompt → record → focused feedback → second attempt → saved expressions.

## Modes

The web app has an explicit `VITE_APP_MODE`:

- `demo`: deterministic fixtures, browser microphone when available, and localStorage for the demo state.
- `api`: all learner, prompt, session, attempt, saved-expression, and progress state comes from the Fastify API. Real microphone audio is uploaded as multipart data; API mode never silently falls back to a fake recording.

If microphone access fails in API mode, the UI reports the error and offers an explicit switch to demo mode. The mode badge is visible in the header and on the main screens.

## Local development

Requirements: Bun 1.2+, Docker, and a browser with microphone support for the real recording path.

```sh
bun install
cp .env.example .env

# Start PostgreSQL 16, MinIO, and idempotent audio bucket initialization.
bun run db:up

# Apply the hand-written SQL migrations and seed prompts.
bun run db:migrate
bun run db:seed

# Terminal 1: API on http://localhost:3333
bun run dev:api

# Terminal 2: web app
bun run dev
```

Optional local cleanup worker (expires TTS playback references and retries failed object deletes):

```sh
docker compose --profile cleanup up -d storage-cleanup
```

For demo mode, keep `VITE_APP_MODE=demo`. For the full flow, set `VITE_APP_MODE=api` and `VITE_API_URL=http://localhost:3333` before starting the web dev server. Vite variables are build-time values, so restart Vite after changing them.

## API

The API is Fastify with one route registry in `apps/api/src/routes.ts`. All request and response shapes are Zod schemas from `packages/contracts`.

Routes:

- `GET /health` and `GET /api/health` (backwards-compatible summary)
- `GET /health/live` and `GET /api/health/live` (liveness; no database required)
- `GET /health/ready` and `GET /api/health/ready` (readiness; returns 503 until PostgreSQL is up)
- `POST /api/learners/anonymous`
- `GET /api/prompts?lang=en|ja`
- `POST /api/sessions`, `GET /api/sessions/:id`
- `POST /api/sessions/:sessionId/attempts` (multipart), `GET /api/attempts/:id`
- `GET /api/saved`, `POST /api/saved`, `DELETE /api/saved/:id`
- `GET /api/progress`
- `GET /api/providers/diagnostics` (authenticated; active upstream probes require server-side opt-in)
- `POST /api/tts` and `GET /api/audio/:opaqueReference` (authenticated)
- `POST /api/realtime/experimental/smoke` (authenticated, feature flag)

After anonymous bootstrap, learner-scoped routes require an HMAC-signed `Authorization: Bearer ...` token with `scope=learner`. Client-supplied learner IDs are not accepted for those routes; ownership mismatches return a safe 404.

Audio bytes use `DATA_DIR` with `AUDIO_STORAGE_DRIVER=local`, or AWS SDK S3-compatible storage with `AUDIO_STORAGE_DRIVER=s3`. Local development provides MinIO at `http://127.0.0.1:9000` and console at `http://127.0.0.1:9001`; `minio-init` creates `S3_BUCKET` idempotently. Cloudflare R2 uses its account endpoint, `S3_REGION=auto`, and normally `S3_FORCE_PATH_STYLE=false`. Single-node MinIO is for development/evaluation.

ASR, assessment, and TTS remain deterministic mocks by default. Real mode uses independent OpenAI-compatible configuration: `CHAT_*`, `TRANSCRIPTION_*`, and `TTS_*` each have their own URL, key, model, and timeout. Backend reads untracked `llm_config.json` only for local model-name hints when environment overrides are absent; endpoints and credentials always come from server environment. It never exposes credentials from that file. Rotate any credentials ever stored there, keep it ignored and excluded from Docker context, and put current keys only in server environment or secret manager. Never use `VITE_*` for provider keys.

Attempt pipeline stores file first, lets ASR re-read it through `AudioStorageProvider`, validates feedback against shared contract, then commits result, transcription metadata, ready status, and progress in one database transaction. Audio and TTS bytes never enter PostgreSQL. Failed deletes enter `storage_cleanup_jobs` for later retry. TTS uses authenticated `POST /api/tts` and `GET /api/audio/:opaqueReference`; mock TTS returns no playable object by design. Realtime smoke only tests WebSocket session protocol; no media relay or UI rewrite.

## Build and validation

```sh
bun run format
bun run lint
bun run typecheck
bun run build
bun run test
```

Database migrations are intentionally hand-written in `apps/api/src/db/migrations`; `db:migrate` is the only migration command. `bun run test` runs unit and boundary tests. `bun run test:integration` runs the persisted full journey after PostgreSQL is available.

## Container API

Build from the repository root so the workspace contracts are available:

```sh
docker build -f apps/api/Dockerfile -t kotoba-api .
docker run --rm --network host \
  -e DATABASE_URL=postgres://kotoba:kotoba@localhost:5432/kotoba \
  -e ANON_TOKEN_SECRET=replace-with-a-long-random-secret \
  -e CORS_ORIGIN=http://localhost:5173 \
  -v "$(pwd)/data:/app/data" \
  kotoba-api
```

Run migrations and seed from the host before starting the container, or run the same Bun commands in a one-off container. Do not use force-push or rewrite commits on the Lovable-connected branch.
