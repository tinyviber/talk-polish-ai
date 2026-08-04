# Main architecture refactor (draft / WIP)

## Scope and lineage

- Repository: `tinyviber/talk-polish-ai`
- Base: `origin/main` at `1b675b070083618410da91d6c39c1b97642546ba`
- Head: `codex/refactor-main-architecture`
- This branch was created directly from the fetched `origin/main` SHA.
- PR #1 was not merged, and no PR #1 head, merge commit, cherry-pick, rebase, or implementation copy was used. PR #1 was inspected read-only only for conflict planning.

## What changed

This is a maintainability refactor, not a UI or product redesign.

- Added `.codex/refactor-plan.md` before broad implementation.
- Centralized startup configuration parsing and production safety checks.
- Added explicit application boundaries for provider diagnostics, TTS/audio, realtime, and attempt processing.
- Added repositories for learners, prompts, expressions, progress, sessions, attempts, and provider persistence. Routes now focus on auth, validation, service calls, and response serialization.
- Kept provider and storage behavior behind narrow interfaces and removed business-layer environment reads/direct provider construction.
- Made attempt persistence and result/progress updates transaction-aware; preserved idempotent replay and attempt ordering.
- Extracted a pure practice state reducer and made the practice route use it for stage transitions.
- Made recording enqueue durable before API mutations; added stable cold-start queue ownership, ordered attempt gating, durable cross-tab leases with heartbeat renewal, and explicit queue states.
- Kept authenticated/mutation/audio/diagnostics/realtime requests out of Cache Storage and added cross-origin navigation coverage for the Service Worker rules.
- Stopped persisting bearer tokens in localStorage; device identity remains local-only for offline queue ownership.
- Added regression coverage for duplicate processing recovery, audio metadata cleanup, queue ordering/cold start, reducer transitions, provider fixtures, safe configuration, and schema/database-width boundaries.
- Removed unused Fastify Swagger packages. No database migration was deleted or rewritten.
- Pinned Bun `1.2.17`, added `.bun-version`, refreshed the single `bun.lock`, and made Docker validation a CI step. Added direct web Rollup dependency because `workbox-build` requires it for a clean PWA build.

## Behavior and compatibility

- Existing API paths, demo/mock mode, API mode, database schema/data shape, installable PWA flow, and primary UI remain intended-compatible.
- Bug fixes called out separately: stale `processing` recovery no longer risks duplicate provider billing; failed storage cleanup preserves the audio reference for retry; recordings are queued before session/attempt mutations; offline cold start no longer loses queue ownership before anonymous learner bootstrap.
- Existing migration files remain unchanged. Repositories target the existing tables and constraints; no migration is required by this refactor.

## Review follow-up fixes

- Fixed integration CI to invoke the root `bun run test:integration` entry point.
- Added stale `processing` recovery with an atomic conditional transition to `failed`; the server never silently replays provider work from a possibly live worker.
- Added queue-change notifications, trailing sync passes, persisted `nextPollAt`, one controlled processing timer, and a stable pre-bootstrap lease namespace.
- Restored active diagnostics rate limiting with learner ID and client IP, only when an active probe is requested and enabled.
- Added explicit TTS cache disposition. Cache hits are never deleted on reference-write failure; newly created objects use delayed, reference-aware cleanup.
- Made IndexedDB queue writes resolve only after transaction completion and added abort-after-request-success coverage.
- Tightened new regression fixtures to repository-derived types; no production behavior is hidden behind `any`.

## File mapping / boundaries

| Existing responsibility                                                 | New boundary                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api/src/routes.ts` feature persistence and provider orchestration | thin routes plus `apps/api/src/modules/*/{service,repository}.ts`                  |
| direct provider route logic                                             | `apps/api/src/modules/providers/service.ts` and narrow provider/storage interfaces |
| attempt insert/result/progress/audio cleanup                            | `apps/api/src/modules/attempts/repository.ts` + `service.ts`                       |
| practice route transition logic                                         | `apps/web/src/features/practice/state-machine.ts`                                  |
| recording queue and recovery                                            | `apps/web/src/lib/practice/offlineQueue.ts`                                        |
| cache policy                                                            | `apps/web/src/sw-rules.ts`, `sw.ts`, and tests                                     |
| scattered startup env reads                                             | `apps/api/src/env.ts` and composition in `apps/api/src/index.ts`                   |

Contracts stay schema/types/pure functions only. Web and API do not become dependencies of contracts. Composition remains simple and occurs at API startup.

## Commands and results

All code checks below used fixed Bun `1.2.17` via `PATH=/tmp/kotoba-bun-1.2.17/bin:$PATH`.

- `git fetch origin` — pass; base SHA recorded above.
- `bun install --lockfile-only` — pass; one text lockfile (`bun.lock`) retained.
- `bun install --frozen-lockfile` — attempted; local Bun resolver remained at `Resolving...` and was interrupted after a bounded wait. This is not claimed as a pass.
- `bun run format:check` — pass.
- `bun run lint` — pass, 0 errors and 10 existing Fast Refresh warnings.
- `bun run typecheck` — pass for contracts, API, and web.
- `bun run test` — pass: contracts 6, web 18, API 30; 4 integration/storage tests skipped by their existing environment gates.
- `bun run build` — pass: contracts, production web/PWA, and API build.
- `bun run test:integration` — blocked: PostgreSQL was not available; migration connection failed before integration tests.
- `bun run build:docker` — blocked: Docker daemon unavailable at `unix:///Users/wj/.orbstack/run/docker.sock`.
- `git diff --check` — pass.

Therefore this remains a draft/WIP PR. It must not be called fully verified until frozen install, PostgreSQL integration, and Docker build pass in CI or a supplied environment.

Not verified here: real iPhone MediaRecorder/Wake Lock/PWA update behavior, real OpenAI-compatible provider, real WebSocket provider, real object storage, multi-device browser smoke flow, and production secret injection.

## PR #1 integration guide

PR #1 current remote head is `5bc5153fb5db2a345fea1eb2688ab5e7aba9ae5d`. Its relevant commits are:

- `13d5c4726dc00e99c149e05ff917c44c06bd3077` — recording drafts/offline PWA sync
- `4c698056a018aeee6497a4bee55104150357c1ed` — offline recovery/provider contracts
- `5bc5153fb5db2a345fea1eb2688ab5e7aba9ae5d` — integration CI/deployment secrets

Overlapping files/areas: `apps/web/src/lib/practice/offlineQueue.ts`, `offlineQueue.test.ts`, `apps/web/src/routes/practice.tsx`, `apps/web/src/routes/__root.tsx`, `apps/web/src/lib/practice/useRecorder.ts`, `apps/web/src/sw.ts`, `sw-rules.ts` and tests, `apps/api/src/env.ts`, provider routes/contracts, `packages/contracts/src/schemas.ts`, `.github/workflows/ci.yml`, `package.json`, and `bun.lock`.

Do not cherry-pick those implementation commits. Redo their intent on this branch after the refactor:

1. Rebase/merge this branch onto the eventual PR #1 integration branch only after CI has validated this draft; resolve from `origin/main` plus this architecture branch, not from PR #1's head.
2. Re-implement PR #1 recording persistence against `offlineQueue.ts`'s explicit `local-draft -> queued -> uploading -> processing -> ready/failed` model, stable learner/session/attempt IDs, ordered attempt gate, and durable lease. Preserve the queue-first mutation rule.
3. Re-implement PR #1 provider contract changes through `modules/providers/service.ts`, provider interfaces, and contracts; keep routes thin and do not reintroduce env/provider construction in business code.
4. Re-implement PR #1 CI/secrets documentation against pinned Bun, the single lockfile, current `build:docker`, and centralized `env.ts`; never copy secrets or weaken checks.
5. Run the full validation matrix again, then resolve likely conflicts in the practice route, queue tests, Service Worker policy, provider route/config files, CI, lockfile, and contract schemas.

Expected conflict hotspots are queue record shape/status/lease fields, practice mutation ordering, Service Worker cache predicates, provider route signatures, environment validation, package lock ownership, and any PR #1 tests that assume direct repository/provider access. Prefer adapting tests and call sites to the new interfaces over preserving either branch's internal implementation.
