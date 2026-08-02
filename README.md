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

# Start PostgreSQL 16 with a persistent Docker volume.
bun run db:up

# Apply the hand-written SQL migrations and seed prompts.
bun run db:migrate
bun run db:seed

# Terminal 1: API on http://localhost:3333
bun run dev:api

# Terminal 2: web app
bun run dev
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

After anonymous bootstrap, learner-scoped routes require an HMAC-signed `Authorization: Bearer ...` token with `scope=learner`. Client-supplied learner IDs are not accepted for those routes; ownership mismatches return a safe 404.

Audio bytes are stored under `DATA_DIR` (mount `/app/data` in a container). This MVP is intentionally mock-only for ASR, assessment, and TTS, and local-storage-only for audio; production must explicitly add and configure real provider/storage implementations rather than treating these mocks as production speech analysis. The attempt pipeline stores the file first, passes the actual `storageKey` to ASR, validates provider feedback with the shared contract, then commits result, ready status, and progress in one database transaction. Failed processing removes provisional data; if PostgreSQL is temporarily unavailable, the attempt is marked/reclaimed as failed on recovery so its unique slot does not remain permanently blocked.

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
