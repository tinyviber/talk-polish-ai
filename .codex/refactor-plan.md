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

## Independent repository, security, frontend, and offline audit

### Repository and delivery drift

- `bun install --frozen-lockfile` has been verified locally on the baseline;
  this is a useful integrity result, not proof that all runtimes are aligned.
  Manifests express ranges while `bun.lock` records concrete resolutions, so
  future dependency changes must update both intentionally and report the
  resolved-version diff. Do not regenerate or deduplicate the lockfile as a
  side effect of architecture work.
- The local Bun runtime is `1.1.34`; the API Dockerfile pins `oven/bun:1.2.17`,
  while both CI jobs use `bun-version: latest`. This is a three-runtime drift.
  Pin CI and document the supported version before claiming reproducibility;
  verify local, CI, and Docker builds with the same version.
- `@fastify/swagger` and `@fastify/swagger-ui` are present in the API manifest
  but no active registration/use was found. Treat them as unused dependencies:
  remove only in a dedicated dependency-cleanup change after confirming that
  no generated/openapi workflow relies on them.
- README deployment guidance says to apply migration `0006_client_attempt_idempotency.sql`,
  but the repository also contains `0007_client_session_idempotency.sql`.
  Documentation must describe the complete ordered migration set and the
  actual `db:migrate` entrypoint. Never rewrite already-applied migrations.

### Security findings

- Production configuration is not sufficiently fail-closed for placeholder
  secrets: checking one known development default is weaker than rejecting
  known placeholders, low-entropy values, and missing production secrets.
  Production startup must fail before serving traffic when the token secret or
  provider credentials are absent, default-like, or invalid.
- A local `llm_config.json` is known to contain secret-like local material.
  Do not read, print, copy, commit, link, or expose its contents during this
  refactor. The architecture must keep local model discovery separate from
  credentials and should prefer an explicit secret-manager/environment path.
- Mock attempts currently have an attempt-rate-limit gap because rate limiting
  is tied to whether the selected provider is mock. Abuse protection for the
  learner-scoped attempt endpoint must apply regardless of provider cost;
  provider-cost limits may be a separate policy.
- The web API client persists a bearer token in `localStorage`. This enlarges
  the XSS blast radius. Prefer an HttpOnly, Secure, same-origin session cookie
  or explicitly document a temporary threat-model exception with short TTL,
  rotation, logout clearing, and no token exposure to unrelated origins.

### Frontend findings

- `clientSessionId` can survive a prompt change in the practice flow. A client
  idempotency key must be scoped to one learner + prompt + logical session;
  reset it on prompt/session change or reject the transition before recording.
- `practice.tsx` is approximately 751 lines and combines presentation, state
  transitions, demo/API branching, recorder orchestration, upload fallback,
  queue reconciliation, and feedback rendering. It is the first frontend
  extraction target, but its behavior must be preserved while moving code.
- Demo and API modes are coupled through route/store conditionals and direct
  imports of mock services. Select a `PracticeApplication` adapter in the web
  composition root so the UI consumes one capability surface.
- The processing DTO is nullable-by-convention: `Attempt` can be processing,
  but the UI then narrows it through `toReadyAttempt`. Introduce a discriminated
  `ProcessingAttempt | ReadyAttempt | FailedAttempt` contract/application model;
  polling and result rendering should not rely on nullable fields.
- Runtime validation must exist at every untrusted boundary: HTTP responses,
  provider responses, environment/configuration, IndexedDB records after
  upgrade, queue metadata, and any persisted browser state. TypeScript types
  alone are not an acceptance boundary.

### Offline findings

- Online submission currently attempts the network before durably enqueueing
  the recording. A crash between capture and the fallback enqueue can lose the
  Blob. The durable outbox must be the first commit; upload is a later state
  transition, including when the device is online.
- Queue processing must order candidates by `createdAt` with a stable
  `clientAttemptId` tie-breaker. Object-store enumeration order is not a
  scheduling policy.
- Attempt 2 has no explicit client-side dependency on a ready attempt 1. Add a
  dependency key and do not release attempt 2 until its prerequisite is ready;
  the server invariant remains authoritative.
- Baseline queue coordination has no cross-tab lease and no BroadcastChannel.
  Add an expiring durable lease with owner/renewal/recovery semantics. A
  BroadcastChannel may wake other tabs and refresh views, but must not replace
  the lease or be treated as durable coordination.
- The Service Worker boundary is mostly safe: public prompt GETs and the
  navigation shell may use bounded caches, while authenticated reads,
  mutations, audio, diagnostics, providers, and realtime stay Network Only.
  Preserve this policy and test origin, cookie, authorization, method, and
  path combinations explicitly.

## Target architecture

```text
packages/contracts
  schemas, public types, constants, pure state/data functions only
        ^                         ^
apps/api                  apps/web
  HTTP adapters             page/presentation adapters
      |                          |
  application/use cases    web application/use cases
      |                          |
  repository/provider      browser ports
  ports                    |
      |                    |
  DB/provider adapters     fetch, IndexedDB, MediaRecorder
        \                  /
          explicit composition roots
                 |
          runtime config + wiring
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
- `buildRuntime()` is the only production API composition root: parse config once,
  create DB/repositories, storage, providers, auth, and application services.
- The web runtime has one analogous composition root: choose demo/API
  adapters, create the API client, durable queue repository, sync use case,
  recorder/browser adapters, and expose them through the app provider.
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
- Never inspect, display, copy, or commit the contents of local
  `llm_config.json`; treat it as sensitive opaque local state.
- No production placeholder/default secret may pass configuration validation;
  configuration must fail closed before binding a public listener.
- No Cache Storage entry for auth, mutation, session, attempt, progress, saved,
  TTS/audio, diagnostics, provider, or realtime traffic.
- No browser upload path may send an uncopied Blob directly to the network;
  durable enqueue precedes every upload attempt.
- No attempt-2 queue item may upload without an explicit ready dependency on
  attempt 1.
- No `|| true`, widened ignore, skipped flaky test, or weaker CI check.

## Migration order

1. Plan and baseline (this file); record exact commands/results, the frozen
   install result, Bun version matrix, current migration/documentation drift,
   and all pre-existing worktree changes without overwriting them.
2. Contracts and test seams: split fixtures from the public contract surface;
   introduce explicit processing/ready/failed DTOs, classified errors,
   repository/provider ports, idempotency dependencies, and pure state tests.
3. API infrastructure: validate an immutable config snapshot fail-closed,
   remove secret-like local config from the credential path, create
   `buildRuntime()`, then inject auth, repositories, providers, and use cases.
4. Repository adapters: extract learners, prompts, saved expressions, and
   progress first; then sessions, attempts, audio references, and cleanup jobs.
   Keep all Drizzle tables and row mapping inside adapters.
5. Backend application: extract learner/prompt/session/attempt/progress/saved/
   audio/TTS/diagnostics use cases. Move attempt orchestration last and preserve
   transaction, idempotency, storage compensation, and attempt-2 invariants.
6. HTTP adapters: make routes thin and preserve every current path, status,
   request schema, response schema, auth ownership rule, and cache header.
7. Frontend application: separate API transport, demo/API adapters, practice
   state machine, processing DTO handling, and page composition. Fix
   clientSessionId scoping before durable queue integration.
8. Offline/PWA: enqueue durably before online/offline upload, sort by createdAt,
   add attempt-2 dependency gating, add cross-tab lease plus BroadcastChannel
   wakeups, and retain strict SW boundary tests.
9. Test/CI/Docker: pin one Bun version across local documentation, CI, and
   Docker; verify frozen install, format, lint, typecheck, unit/integration
   tests, production builds, Docker build, and security/config checks.
10. Cleanup/docs: remove only proven unused dependencies such as Swagger,
    correct README migration guidance through 0007, document file mapping and
    deployment assumptions, then apply the PR #1 integration guide below.

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
- Online and offline submission use the same durable outbox path; the network
  is never the first owner of a captured Blob.
- Queue scheduling is deterministic (`createdAt`, then client id), and attempt 2
  remains blocked until its declared attempt-1 dependency is ready.
- Cross-tab upload ownership is represented by a renewable, expiring lease;
  BroadcastChannel only provides best-effort wakeups/view invalidation.
- Production config rejects missing/default/placeholder secrets and never uses
  local secret-like files as a credential source.
- Risk: moving a side-effectful service can change transaction timing. Add
  integration tests before each move and keep old migration-compatible row
  mappings until all callers switch.
- Risk: token storage changes can strand anonymous learners or queued data.
  Define migration/logout/expiry behavior before replacing localStorage.
- Risk: PR #1 overlaps offline queue, recorder, practice route, SW rules,
  provider routes/config/contracts, and CI/lockfile. New stable ports are the
  merge seam; PR #1 behavior must be reimplemented/adapted, never cherry-picked.

## PR #1 integration guide

PR #1 is conflict context only. Do not copy, cherry-pick, merge, or treat its
commits as implementation input for this refactor. Preserve the baseline
`1b675b070083618410da91d6c39c1b97642546ba` and the branch
`codex/refactor-main-architecture`.

### Overlap files

The explicit conflict set is:

- `apps/web/src/lib/practice/offlineQueue.ts`
- `apps/web/src/routes/practice.tsx`
- `apps/web/src/routes/__root.tsx`
- `apps/web/src/lib/practice/useRecorder.ts`
- `apps/web/src/sw.ts`
- API provider routes and provider configuration
- `packages/contracts/src/schemas.ts`
- `.github/workflows/ci.yml` and `bun.lock`

README/deployment files and any new scripts are secondary review points. The
largest semantic conflicts are queue durability, practice state transitions,
recorder interruption recovery, provider metadata/configuration, contract
evolution, and CI dependency resolution.

### Reconciliation order

1. Keep this branch on the stated base until the target ports, DTOs, queue
   invariants, config validation, and tests are defined.
2. If PR #1 is merged elsewhere, update the integration checkout to that
   resulting commit without rewriting published history; do not transplant its
   commits into this branch.
3. Reconcile `packages/contracts/src/schemas.ts` first, preserving compatible
   processing/provider metadata and adding tests for both old and new valid
   payloads where required.
4. Reconcile provider routes/configuration next through the provider and
   application ports. Reapply behavior as adapters, not as route-level or
   singleton coupling.
5. Reconcile `offlineQueue.ts`, `useRecorder.ts`, `practice.tsx`, and
   `__root__.tsx` only after the web application boundary exists. Port over
   durable draft/recovery behavior while enforcing enqueue-first, ordering,
   attempt-2 dependency, and lease invariants.
6. Reconcile `sw.ts` last among runtime files. Preserve its mostly-safe cache
   boundary and expand pure rule tests rather than broadening caches.
7. Resolve CI/lockfile only after the Bun pin is chosen; run frozen install on
   the same version used by CI and Docker, then report every resolved-version
   change.

### Behavior to reimplement, not copy

- interrupted recording finalization and durable draft recovery
- queue persistence, retry classification, processing polling, and cleanup
- provider capability/configuration hardening and metadata parsing
- realtime protocol smoke behavior
- PWA update/cache deployment guidance

Each behavior must be expressed through the target ports/use cases and covered
by tests. No PR #1 file should dictate the final module boundary.

## Acceptance criteria

- One lockfile; `bun install --frozen-lockfile` succeeds on pinned Bun.
- The exact Bun version is identical in local documentation, both CI jobs, and
  Docker; the version matrix and lockfile/manifest resolution diff are recorded.
- format check, lint, typecheck, unit tests, PostgreSQL integration tests,
  production web/API build, API Docker build, and frozen install all pass
  without masking.
- Tests cover anonymous learner, prompts, session, attempt 1/2, idempotent
  replay, error recovery, TTS reference/playback, provider HTTP/WS fixtures,
  recorder transitions, offline queue ordering, SW boundaries, and production
  config validation.
- No production module reads `process.env` outside centralized config parsing.
- Production config rejects missing, default, placeholder, and
  secret-like-invalid values before serving; no local `llm_config.json` content
  appears in logs, artifacts, diffs, or commits.
- Attempt rate limiting applies to mock and real provider paths, while any
  provider-cost limit is separately observable and testable.
- Bearer-token storage has an explicit secure migration or an approved,
  documented temporary exception with TTL/rotation/logout tests.
- No route imports DB tables, DB client, provider constructors, or storage
  drivers.
- Online capture durably enqueues before upload; queue order, attempt-2
  dependency gating, cross-tab lease recovery, and SW cache boundaries have
  deterministic tests.
- README migration instructions match all committed migrations through 0007;
  unused Swagger dependencies are either removed intentionally or justified.
- Final draft PR includes base SHA, architecture/file mapping, behavior and DB
  compatibility, exact command results, unverified real-device/provider/object
  storage items, and a dedicated PR #1 integration guide with overlap files,
  commits to redo, rebase order, interface adaptations, and conflict points.
