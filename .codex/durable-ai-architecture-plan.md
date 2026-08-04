# Durable AI architecture plan

## Actual starting state

- `origin/main` SHA: `e44c6e0c3e7b109e6dcf34f3bd56d347c0bb23f6`
- Lovable/current work SHA: same; working branch `codex/finish-durable-ai-architecture`
- Snapshot ref: `backup/lovable-partial-20260805-e44c6e0`
- Baseline at Lovable tip: frozen install pass; typecheck pass; unit tests pass; format/lint failed on queue whitespace; DB/S3 integration skipped. Local Bun is `1.1.34`; repository CI pins `1.2.17`.
- Audit: `.codex/lovable-takeover-audit.md`.

## Codex completion snapshot

- `bun run typecheck`: pass.
- `bun run test`: API 41 pass/5 skip, web 27 pass, contracts 6 pass.
- `bun run format:check`: pass.
- `bun run lint`: 0 errors, 10 existing Fast Refresh warnings.
- `bun run build`: pass with existing Vite/PWA chunk/glob warnings.
- `bun run test:integration`: attempted; migration failed because PostgreSQL is unavailable.
- `bun run build:docker`: attempted; Docker daemon unavailable.

## Current dependency graph

```text
practice route -> React store + recorder + API + IDB queue + mock services + PWA
API routes -> feature services -> Drizzle/global db + providers()
attempt service -> storage + transcription provider + assessment provider + progress writes
openai-assessment -> HTTP client + Feedback schema + speaking prompt + JSON repair
openai-transcription -> HTTP client + AudioStorageProvider + product attempt fields
openai-tts -> HTTP client + storage + cache/reference policy
```

## Target dependency graph

```text
contracts (schemas, DTOs, provider-neutral types, pure policies)
        ^                         ^
API HTTP adapters -> application use cases -> domain policies/events
                         |                 |
                    repositories      capability ports
                         |                 |
                    Drizzle/DB       provider infrastructure

Web routes -> practice controller/state machine -> browser ports
                                    |             |
                             workflow store     IDB/media/fetch

composition roots construct all concrete adapters and inject ports
```

## Migration order and file scope

1. **Audit/docs + baseline** — complete. Refs protected; audit includes twelve independent review roles.
2. **Durable recovery first** — complete for P1/P2 path: IndexedDB v5 workflow state, atomic feedback updates, revisions, migration normalization, stable recovery selection, consumed/abandoned, retry without upload, new-session start-over, ready-Blob discard, storage-event fallback.
3. **State-machine boundary** — complete for semantic transition guard; route now renders recording, recorded, feedback-recovery, and offline-recovery stages. Controller extraction remains follow-up.
4. **Capability ports** — complete initial ports for TextModel, StructuredGenerator, SpeechToText, TextToSpeech, SpeechMetrics; old adapters remain compatibility surface.
5. **LLM/speaking** — complete initial speaking module and transport facade; explicit output shape, bounded JSON repair, language/attempt behavior, metric/provenance assembly.
6. **Speech/TTS truthfulness** — complete initial pure ASR/TTS adapters, application-owned storage/cache, transcript/timestamp metrics, nullable pronunciation and provenance. Acoustic pronunciation scorer remains future work.
7. **Attempt application** — partial but safer: injected attempt application, pure ASR byte path, stale/idempotency/cleanup behavior preserved, explicit ready event/projector call, commit-aware reread. Full repository/HTTP inversion remains follow-up.
8. **Composition root** — complete for production route path via `buildRuntime`; compatibility entry points retain defaults.
9. **Outbox/contracts** — complete initial split/re-export surface; monolithic IDB implementation remains and split marker modules are intentionally incremental.
10. **Architecture/compatibility tests + verification** — complete available local gates; integration/Docker/real provider tests remain environment-gated.

## Compatibility strategy

- Keep every existing `/api` path, request field, response field and HTTP ownership rule.
- Preserve old `Feedback` fields; add optional source/unavailable metadata and map old numeric pronunciation conservatively.
- Keep migrations immutable; only add forward migrations if runtime schema requires them.
- IDB version upgrades normalize old rows; legacy learner rows stay isolated, never silently uploaded under a new learner.
- Keep demo mode deterministic and explicit; API mode never calls browser mock analysis.
- Preserve anonymous learner bootstrap, PWA shell/network-only auth policy, TTS endpoint, realtime endpoint and diagnostics.

## Test matrix

| Area          | Required coverage                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Recovery      | retry, reload, cold start, two tabs, consumed/abandoned, start-over, stale response, TTL, no upload on feedback retry  |
| State         | legal/illegal semantic events, generation guard, no arbitrary stage jump                                               |
| Text          | request mapping, timeout/retry, extraction, metadata                                                                   |
| Structured    | plain/fenced JSON, schema mismatch, one repair, exhaustion                                                             |
| Speaking      | English/Japanese behavior, attempts 1/2, fake TextModel, prompt snapshots                                              |
| Speech        | ASR bytes/mime/locale, metrics pauses/fillers/missing timestamps/zero duration, pronunciation unavailable              |
| TTS           | provider bytes, cache hit/miss, reference failure, cleanup                                                             |
| Attempt       | idempotency, slot order/conflict, stale/late workers, provider/storage failure, projection, no duplicate provider call |
| Boundaries    | import scans for adapter/domain/route/state/outbox policy restrictions                                                 |
| Compatibility | existing API/SW/mock/schema tests, PostgreSQL migration journey, S3/TTS integration when services available            |

## Rollback

Revert only new Codex commits, never historical migrations or Lovable refs. Restore by switching to `backup/lovable-partial-20260805-e44c6e0` or the prior origin SHA. IDB code must tolerate mixed old/new rows. Provider and API response adapters remain backward-compatible during migration.

## Explicitly not doing

- No UI redesign, framework replacement, managed backend, unrelated dependency upgrades, migration rewrite, history rewrite, force-push, automatic merge, or secret inspection.
- No fake pronunciation/acoustic facts from text models.
- No background recording guarantee on iOS.
- No claim of green PostgreSQL/S3/Docker verification until those services/commands actually run.
