# Main Architecture Refactor Plan

## Baseline and provenance

- Base branch: `origin/main`
- Base SHA: `1b675b070083618410da91d6c39c1b97642546ba`
- Working branch: `codex/refactor-main-architecture`
- PR #1 was not used as a starting point. Its visible remote branch is
  `origin/codex/establish-clean-build-baseline-and-test`; its three commits are
  `13d5c47`, `4c69805`, and `5bc5153`. It is read-only conflict context only.
- Existing migrations are immutable. New migrations require a concrete
  compatibility or integrity need.

## Current problems

1. `packages/contracts` is already a useful shared boundary, but API feature
   services still import Drizzle tables, the global DB client, HTTP errors, and
   other feature services directly. This hides persistence boundaries and makes
   service tests depend on process globals.
2. `apps/api/src/modules/attempts/service.ts` combines authorization-scoped
   loading, idempotency, audio storage, provider orchestration, result
   persistence, progress writes, compensating cleanup, and DTO composition.
   A failure can therefore be classified only after several side effects.
3. Route modules contain multipart parsing, provider selection, storage reads,
   rate-limit calls, and DB queries. Route code is not consistently limited to
   auth, validation, application-service calls, and response serialization.
4. `providers()` is a cached implicit singleton. It is the correct composition
   idea but is not injected into application services, and `process.env` and
   `env()` are still reachable from route/health/provider code.
5. `ApiError`, `ProviderRequestError`, and `StorageError` are separate error
   hierarchies. Some core control flow still uses concrete provider names and
   string-shaped status decisions instead of explicit classifications.
6. The practice route/store/recorder/offline queue owns too many concerns. The
   queue has useful durability behavior but its states and transitions are not
   expressed as one pure, testable state model.
7. Service-worker rules are pure and mostly safe, but the allow-list policy is
   spread across predicates and worker registration. Authenticated reads,
   mutations, audio, diagnostics, provider, and realtime traffic must remain
   explicit Network Only forever.
8. The current CI uses `bun-version: latest`, does not run Docker build, and
   integration tests are opt-in/skipped by the default test command. This is
   not reproducible enough for a refactor claim.

## Target architecture

```text
packages/contracts
  schemas, public types, constants, pure state/data functions only
        ^                         ^
apps/api                  apps/web
  routes/adapters          routes/composition
      |                          |
  application services     feature state + API client
      |                          |
  repositories       provider/storage/browser infrastructure ports
      |                          |
  db adapter          fetch, IndexedDB, MediaRecorder, SW
```

Dependency rules:

- Contracts depend only on Zod and pure standard-library-compatible code.
- API routes depend on contracts, auth boundary, application service ports,
  and serializers. Routes do not import Drizzle tables or provider drivers.
- Application services own workflows and invariants. They depend on narrow
  repository/provider/storage interfaces and configuration values passed from
  the composition root.
- Repositories own Drizzle queries and row-to-domain mapping. No route imports
  repository internals.
- Provider drivers implement narrow ports. Business code does not read env or
  construct a provider.
- `buildRuntime()` is the only production composition root: parse config once,
  create DB/repositories, storage, providers, auth, and application services.
- Web routes compose page UI. Practice state transitions, API transport,
  IndexedDB, media capture, wake lock, and service-worker policy are separate.

Feature boundaries:

- learner: anonymous bootstrap and token subject
- prompts: public prompt listing and prompt lookup
- session: session lifecycle and prompt/learner ownership
- attempt: ordered attempt lifecycle, idempotency, recording/result workflow
- progress: progress projection and score events
- saved-expression: saved-expression commands/queries
- audio/TTS: audio references, authenticated playback, synthesis
- provider diagnostics: capability checks only; no credential leakage

## Forbidden changes

- No merge, rebase, cherry-pick, force push, history rewrite, or PR #1 change.
- No UI redesign, product rename, new product behavior, or managed backend.
- No migration rewrite/deletion, lockfile duplication, Bun/framework major
  upgrade, or new heavyweight state library.
- No secrets in source, browser bundles, logs, caches, fixtures, or commits.
- No Cache Storage entry for auth, mutation, session, attempt, progress, saved,
  TTS/audio, diagnostics, provider, or realtime traffic.
- No `|| true`, widened ignore, skipped flaky test, or weaker CI check.

## Migration order

1. Plan and baseline (this file); record exact commands/results.
2. Contracts and test seams: explicit attempt/recording lifecycle types,
   classified errors, repository/provider ports, and pure state tests.
3. API infrastructure: immutable config snapshot, composition root, repository
   adapters, error mapping, then move feature services behind ports.
4. Backend features: learner/prompt/session/attempt/progress/saved/audio/TTS and
   diagnostics routes become thin adapters. Preserve every current path/shape.
5. Frontend: split API transport, practice domain state machine, browser
   adapters, and page composition. Preserve demo and API modes and UI markup.
6. Offline/PWA: make queue states and ordering explicit, serialize all
   metadata, keep Blob durability and strict SW policy tests.
7. Test/CI/Docker: enable deterministic Bun version, provider fixtures,
   PostgreSQL integration, production builds, API Docker build, and smoke checks.
8. Cleanup/docs: remove only proven dead code/duplicates, document file mapping,
   deployment assumptions, and PR #1 migration guide.

## Invariants and risks

- Anonymous learner remains device-scoped and bearer-token protected.
- Existing API paths and response schemas remain compatible.
- Attempt 2 requires ready attempt 1; same learner/clientAttemptId is idempotent;
  replay cannot duplicate progress, billing-like provider calls, or audio rows.
- Attempt processing must either atomically persist result + ready status +
  progress or leave a recoverable failed/processing record with compensating
  storage cleanup.
- Local draft, queued, uploading, processing, ready, and failed states are
  distinct. Learner, client session, client attempt, prompt, language, and
  attempt index stay attached to every transition.
- Refresh, pagehide, media interruption, PWA update, and multiple tabs cannot
  discard a Blob before durable save completes.
- Risk: moving a side-effectful service can change transaction timing. Add
  integration tests before each move and keep old migration-compatible row
  mappings until all callers switch.
- Risk: PR #1 overlaps offline queue, recorder, practice route, SW rules,
  provider contracts/config, and CI/lockfile. New stable ports are the merge
  seam; PR #1 behavior must be reimplemented/adapted, never cherry-picked.

## Acceptance criteria

- One lockfile; `bun install --frozen-lockfile` succeeds on pinned Bun.
- format check, lint, typecheck, unit tests, PostgreSQL integration tests,
  production web/API build, and API Docker build all pass without masking.
- Tests cover anonymous learner, prompts, session, attempt 1/2, idempotent
  replay, error recovery, TTS reference/playback, provider HTTP/WS fixtures,
  recorder transitions, offline queue ordering, SW boundaries, and production
  config validation.
- No production module reads `process.env` outside centralized config parsing.
- No route imports DB tables, DB client, provider constructors, or storage
  drivers.
- Final draft PR includes base SHA, architecture/file mapping, behavior and DB
  compatibility, exact command results, unverified real-device/provider/object
  storage items, and a dedicated PR #1 integration guide with overlap files,
  commits to redo, rebase order, interface adaptations, and conflict points.
