# Lovable takeover audit

## Provenance and protection

- Repository: `tinyviber/talk-polish-ai`
- Working branch: `codex/finish-durable-ai-architecture`
- Lovable tip: `e44c6e0c3e7b109e6dcf34f3bd56d347c0bb23f6` (`origin/main`)
- Lovable work is in committed history; initial worktree was clean.
- Safe snapshot: `backup/lovable-partial-20260805-e44c6e0` pointing at Lovable tip.
- Prior refactor branch reviewed read-only: `codex/refactor-main-architecture` at `82def8a73fafc2cb7ce59834fabd3e5818ddb2b7`.
- No reset, clean, checkout, restore, rebase, amend, squash, or force-push performed.
- Twelve independent review roles were launched across two pools. First pool reports covered recovery, frontend, architecture, LLM, speech, and adversarial risks; second pool covered takeover, attempt, outbox, contracts, compatibility, and tests. Reports were read-only; Codex integrated fixes selectively.

## Baseline at Lovable tip

| Command                         | Result                                                          |
| ------------------------------- | --------------------------------------------------------------- |
| `bun install --frozen-lockfile` | pass; Bun `1.1.34`                                              |
| `bun run format:check`          | fail: `apps/web/src/lib/practice/offlineQueue.ts` whitespace    |
| `bun run lint`                  | fail: same 3 Prettier errors; 10 existing Fast Refresh warnings |
| `bun run typecheck`             | pass: contracts, web, API                                       |
| `bun run test`                  | pass: API 30 pass/5 skip, web 25 pass, contracts 6 pass         |
| PostgreSQL/S3 integration tests | skipped by environment; not claimed green                       |

## Current verification after Codex changes

| Command                    | Result                                                          |
| -------------------------- | --------------------------------------------------------------- |
| `bun run typecheck`        | pass: contracts, web, API                                       |
| `bun run test`             | pass: API 41, web 27, contracts 6; API integration/S3 5 skipped |
| `bun run format:check`     | pass                                                            |
| `bun run lint`             | pass: 0 errors, 10 pre-existing Fast Refresh warnings           |
| `bun run build`            | pass; Vite/PWA warnings only                                    |
| `git diff --check`         | pass                                                            |
| `bun run test:integration` | attempted; failed at migration because PostgreSQL unavailable   |
| `bun run build:docker`     | attempted; failed because Docker daemon unavailable             |

## Classification table

| Scope                  | Lovable implemented                                                              | Completeness | Correctness |                      Tests | Decision                                      |
| ---------------------- | -------------------------------------------------------------------------------- | -----------: | ----------: | -------------------------: | --------------------------------------------- |
| Feature repositories   | Learner/prompt/session/attempt/progress/expression/provider repositories added   |       medium |      medium |                    partial | keep, then narrow interfaces                  |
| Feedback recovery      | Queue `ready` + `feedbackState`, ready-attempt loader, retry banner              |       medium |         low |                    partial | rewrite workflow state; preserve queue data   |
| TextModel              | No generic capability; OpenAI assessment calls HTTP directly                     |          low |         low |     provider fixtures only | rewrite                                       |
| StructuredGenerator    | JSON fence/parse/Zod/repair embedded in `openai-assessment.ts`                   |          low |      medium |            repair fixtures | extract                                       |
| Speaking assessment    | Provider owns speaking prompt, rubric, schema and result shape                   |          low |         low |        mock/provider tests | rewrite into module                           |
| ASR                    | Provider accepts storage key and product `Lang`/attempt fields                   |          low |      medium |               HTTP fixture | rewrite boundary; keep adapter transport      |
| SpeechMetrics          | No pure module; mock/LLM feedback supplies stats                                 |          low |         low |                       none | add                                           |
| Pronunciation          | Numeric feedback field and deterministic mock score                              |          low |         low |                schema only | fix truthfulness; optional/unavailable source |
| TTS                    | OpenAI TTS adapter reads storage and owns cache/reference behavior               |          low |      medium |    fixture + cleanup tests | rewrite boundary; keep behavior               |
| Attempt workflow       | Service + repository cover idempotency, stale recovery, processing and cleanup   |       medium |      medium | unit + skipped integration | split application/domain/persistence          |
| Progress projection    | Attempt path writes progress directly                                            |          low |      medium |           integration skip | extract event/projector seam                  |
| Composition root       | `providers()` cached singleton; services call it directly                        |          low |         low |         reset-global tests | rewrite injection                             |
| Frontend state machine | Reducer added, but generic `{type: "stage"}` remains; route still owns workflow  |       medium |         low |            4 reducer tests | rewrite events/controller                     |
| Offline outbox         | Durable IDB, migration, queue retry, lease, BroadcastChannel, ready Blob discard |       medium |      medium |             15 queue tests | split incrementally; preserve schema/version  |
| Durable workflow       | Ready queue row can be found only via in-memory refs in practice route           |          low |         low |        ready fixture tests | add durable workflow store                    |
| Contracts              | Shared schemas/types work and preserve public exports, one large file            |       medium |      medium |                    6 tests | split with re-exports                         |
| API/PWA compatibility  | Existing routes, demo mode, SW network-only rules retained                       |       medium |      medium |             route/SW tests | keep; add boundary tests                      |
| Build/CI/docs          | Bun pin, Docker CI, refactor docs added                                          |       medium |      medium |     command baseline above | fix formatting and verification claims        |

## Evidence and key failures

- Snapshot evidence below refers to Lovable tip. Current state machine removes generic stage events and rejects illegal semantic transitions.
- `apps/web/src/routes/practice.tsx:152-594` still combines UI, recorder, API, queue sync, recovery, generation guards and demo branching.
- `apps/web/src/routes/practice.tsx:249-266` changes feedback failure to `record`/`record2`, clearing the interrupted target; this permits duplicate slot recording.
- `apps/web/src/routes/practice.tsx:399-400` reuses `clientSessionIdRef` across prompt changes unless explicitly reset.
- `apps/web/src/lib/practice/offlineQueue.ts:4-56` stores queue metadata but no learner-scoped durable workflow record or consumed/abandoned state.
- `apps/web/src/lib/practice/offlineQueue.ts:301-313` only reconciles the currently held in-memory attempt refs; refresh/cold start has no stable recovery target selection.
- `apps/api/src/providers/index.ts:25-32,74-102` hides provider construction behind a process singleton and `resetProvidersForTests()`.
- `apps/api/src/providers/openai-assessment.ts:1-140` imports `Feedback`, embeds speaking prompt/rubric/schema, parses JSON and repairs it in one provider adapter.
- `apps/api/src/providers/transcription.ts:3-9` accepts `lang`, `promptId`, `attemptIndex`, `durationSec`, and `storageKey`; provider boundary is product/storage-aware.
- `apps/api/src/providers/openai-transcription.ts` reads storage itself; object-store access belongs in audio ingest/application layer.
- `apps/api/src/providers/tts.ts:3-40` includes purpose/scope/storage key/cache disposition; `openai-tts.ts` performs storage/cache/reference work.
- `apps/api/src/modules/attempts/service.ts:82-277` owns authorization-scoped loading, idempotency, storage, provider calls, persistence, feedback validation and cleanup.
- `packages/contracts/src/schemas.ts` keeps feedback stats/pronunciation as ordinary numeric fields; no source/unavailable representation exists.
- `apps/web/src/lib/practice/mockServices.ts:333-371` fabricates pronunciation and objective audio stats in demo feedback.

## Independent review conclusions integrated

- Recovery reviewers identified unused feedback transitions, cold-start loss, cross-tab regression, canonical enqueue IDs, and TTL gaps. Current queue uses IndexedDB v6 workflow state, conservative v3/v4 migration, atomic feedback updates, revisions, stable selection, explicit abandon, and canonical ID adoption.
- Speech/LLM reviewers identified product-aware ASR, provider-owned TTS cache, missing metrics provenance, and transcript-only pronunciation risk. Current pure ports, metrics provenance, nullable pronunciation, speaking module, and application-owned TTS service address these boundaries.
- Compatibility/test reviewers found historical provenance ambiguity, missing contract subpath exports, direct route-stage rendering gaps, progress projection scaffolding, ambiguous commit cleanup, and skipped environment-backed tests. Current changes normalize historical feedback, export split contracts, render recording/offline stages, wire progress event projection, re-read committed attempts before cleanup, and document skipped tests.

## Remaining risks accepted for this PR

- API still exposes compatibility fallbacks (`createAttempt`, provider diagnostics, cleanup defaults); production routes use injected runtime, but full global-removal migration remains follow-up.
- `practice.tsx` remains large; behavior is guarded and recovery UI exists, but controller extraction is incomplete.
- IndexedDB rows are structurally normalized during migration, not fully schema-validated at every read.
- Browser lease expiry can still allow duplicate network POSTs; server/client idempotency prevents duplicate attempt records, not duplicate bytes on wire.
- PostgreSQL/S3 integration, Docker, and real provider adapters remain environment-gated and are not claimed green.

## Decisions

Keep proven persistence constraints, API paths, PWA cache boundary, provider HTTP retry mechanics, queue lease primitives, and existing UI components. Fix whitespace, state transitions, learner/prompt/session scoping, and recovery semantics. Rewrite fake capability boundaries and move business policy out of adapters. Do not rewrite historical migrations or remove old IndexedDB rows; migrate them in place.
