# Daily Story Conversation plan

## Scope

- Replace all user-facing Practice entry points with one English-only Daily Story Conversation.
- Keep legacy persistence, migrations, provider interfaces, audio primitives, auth bootstrap, PWA, and durable recording code unmodified unless removing a UI mount requires it.
- Add browser-local provider settings, request-scoped provider factories, conversation/review policies, and a focused mobile-first UI.
- Deploy tested image SHA through existing GitHub Actions → TCR → Tencent Cloud Compose/Caddy topology.

## Non-goals

- No data migration, deletion of old tables/data/migrations, cloud story history, cross-device sync, realtime WebSocket, scoring, Japanese, social features, vector memory, or vendor-specific drivers.
- No provider credential stored in PostgreSQL, server environment, server file, server cache, logs, localStorage, Cache Storage, React-query persistence, or legacy recording outbox.

## UX state machine

```text
compose → starting → chatting → recording → transcribing → transcriptReady
                                  ↑              │               │
                                  └──── re-record ┘      send → waitingForAi → chatting
chatting → reviewing → review → readingAloudRecording → readingAloudTranscribing → review
any stable state → error(resumeState)
```

- `compose`: Chinese story textarea and primary `开始聊天`; only nonempty bounded story can start, otherwise keep/focus draft with Chinese validation. Chat missing blocks start and routes user to Settings; Chat configured + ASR missing starts explicitly **typed-only** with `语音聊天需配置 ASR`; Chat + ASR enables voice conversation.
- First Chat message selects one natural topic from story, in simple English. It must not translate story.
- Speaking is primary path. Reuse recorder interruption/permission handling; stopped audio transcribes first, then readonly faithful transcript has `发送此转写` and `重录`.
- Typed fallback is available only when Chat is configured, labelled `文字输入（备用，不是语音转写）`, and produces a separately sourced text turn; it cannot impersonate ASR speech.
- Conversation renders AI/user turns only. `understood=false` still renders friendly English clarification/retry—never a grammar error.
- `结束并复盘` enables only after at least one non-empty sent user turn and no request is pending. Review locks future conversation operations.
- Review lists zero to three high-value original/improved pairs. TTS missing hides/disables `听一遍`; ASR missing hides/disables `朗读` with a configuration explanation. Read-aloud is only enabled when ASR exists and remains unscored.
- Every async transition carries session/operation id/settings revision and AbortController. Reducer ignores stale completion, serializes commands, and disables duplicate controls. Ending a conversation aborts and invalidates outstanding work before freezing history.
- IndexedDB may retain only stable non-secret session snapshots. Reload demotes in-flight states to a recoverable stable state; recording must be redone.
- New Story/abandon after a start requires confirmation; Settings never clears a story session. A soft/hard story, transcript, history-character, turn, and request-cost cap ends gracefully with an invitation to review.

### Failure recovery matrix

| Condition | Recovery | Must not happen |
| --- | --- | --- |
| Chat/ASR missing | Keep Chinese draft; CTA opens Settings. Chat-only enables explicit typed fallback, not voice conversation. | Silently start a mock/demo flow. |
| Invalid config / 401 / 403 / 429 / timeout / incompatible upstream | Capability-specific Chinese action, preserve draft/session, offer retry or Settings. | Echo key/upstream body or discard story. |
| Mic denied/unsupported | Explain browser site permission in Chinese, retry, or labelled typed fallback. Recorder always uses API mode. | Create mock audio or switch to demo. |
| ASR failed | Keep Blob in memory for retry transcribe, re-record, or discard. Reload/background demotes to `chatting` and explains recording must be redone. | Persist audio/config to outbox/IDB/cache. |
| Review/TTS failed | Freeze reviewed history; retry same snapshot. TTS failure never blocks Review; Blob URLs revoke after play/unmount. | Reopen chat to a stale reply or store audio. |
| IndexedDB unavailable/blocked/quota | Explain that settings cannot be durable on this browser and block Daily Story start. | Fallback to localStorage or silently use a non-durable key. |

## Data flow

```text
Settings IndexedDB ── just-in-time per-capability config ──► same-origin Daily API
Chinese story ────────────────────────────────► start/reply/review policy
Microphone Blob ─► transcribe ─► immutable ASR transcript ─► reply/review
Daily API ─► request-scoped compatible provider ─► normalized response
TTS bytes ◄──────────────────────────────────── daily TTS endpoint (no storage)
```

- Browser maintains conversation/session only; Daily API does not write story/transcript/audio/credentials to PostgreSQL, object storage, files, server cache, process globals, or server environment. Existing learner bootstrap remains an auth dependency and may create/read its legacy learner row; it stores no Daily Story data.
- Each command reads configuration just-in-time from IndexedDB and never puts it in workflow/session/React-query/error state. Each request supplies only current capability configuration. Chat routes never receive ASR/TTS key; transcribe only receives ASR key; TTS only receives TTS key.
- Existing anonymous learner auth remains request authentication/rate-limit input only. Legacy static-env providers remain for legacy functionality.

## Provider config and IndexedDB

Database `kotoba-loop-settings`, versioned independently from recording outbox:

```text
providerSettings/current: {
  schemaVersion, updatedAt,
  chat?: { baseUrl, apiKey, model },
  asr?: { baseUrl, apiKey, model, responseFormat? },
  tts?: { baseUrl, apiKey, model, voice }
}
storySessions/current: {
  schemaVersion, phase: "chatting" | "transcriptReady" | "review",
  storyZh, messages, pendingAsrTranscript?, review?, updatedAt
}
```

- Validate reads/writes with Zod and perform explicit upgrade migrations.
- Key inputs are masked by default, toggleable, clearable per provider, with clear-all. Settings text says `API 配置保存在当前浏览器设备中。` Save/edit/clear increments configuration revision and immediately invalidates prior connection status; only matching-revision check completion may set connected/failed, and duplicate check/save submissions are disabled.
- Optional cross-tab notification has metadata only; keys always reload from IndexedDB and never cross BroadcastChannel. Stable session persistence uses an allowlist and excludes provider config/key/audio/pending operation. Completed ASR text may persist only as immutable `pendingAsrTranscript`; on reload it restores the readonly confirmation page, never an audio Blob or editable input.
- `storySessions` writes use monotonic revision/CAS and a lease for one active editor. A stale tab receives a metadata-only change notice, reloads newer IDB state, and cannot overwrite newer history/session with last-write-wins.
- Connection tests use same request-scoped endpoints and real minimal capability calls. TTS is optional; no configured TTS never blocks conversation.

## Contracts and routes

Add isolated `daily-story` contracts and module; do not mutate legacy language/session schemas.

```text
POST /api/daily-story/start              storyZh + chat → opening
POST /api/daily-story/transcribe         multipart audio + asr → faithful transcript
POST /api/daily-story/reply              story/history/transcript + chat → understanding/reply
POST /api/daily-story/review             story/history + chat → suggestions
POST /api/daily-story/tts                text + tts → private,no-store audio bytes
POST /api/daily-story/provider-check     capability + one provider config → status
```

- All routes require existing learner auth, validate bounded request shapes, use safe generic upstream errors, and are `Cache-Control: private, no-store`.
- User turns have `{id, source: "asr" | "typed", text}`. Start returns its own bounded `opening` schema; reply uses structured `understanding: understood | clarify | retry` and one short 1–3 sentence reply.
- Review validation enforces at most three suggestions; every `{sourceTurnId, original}` exactly matches its immutable submitted source text. Existing StructuredGenerator JSON/Zod/repair is reused.
- ASR output is sent and displayed verbatim except whitespace-only empty checking. No normalization/correction pass.
- Daily TTS returns in-memory bytes, never legacy TTS storage/cache references.
- Contracts are strict, discriminated per capability, and bound story/turn/history/model/voice/key/base URL/audio/request/response sizes. Multipart transcribe accepts exactly one allowed audio part plus one ASR JSON field; TTS verifies bounded `audio/*` upstream bytes before response. Every route uses existing auth plus learner/IP/capability rate, concurrent-request, input-body, turn and history limits; provider-check has a separate lower quota.

## Prompt policies

- `conversation-policy`: friend-like simple English, one main question, understand intent over surface form; understandable broken English continues naturally; ambiguity asks a semantic question; impossible input invites a simpler rephrase. It forbids corrections, grammar terminology, unsolicited translation, examiner, or teacher posture.
- `review-policy`: Chinese short explanations, exact source only, zero to three useful clarity/grammar/naturalness improvements, no padding/nitpicking, natural daily expressions.
- Chinese story, transcript, and history are untrusted delimited data, never policy instructions.

## Security boundaries and SSRF strategy

- Provider config travels only in HTTPS request body through relative same-origin Daily API URLs. Daily client rejects cross-origin `VITE_API_URL` for these calls. Route/schema/error/logger/telemetry paths redact or omit it. Return only capability/status/general HTTP category; never upstream body, request dump, headers, or Error cause.
- Preserve Pino `req.body`/credential redaction; add explicit tests that realistic keys cannot occur in logs, API errors, snapshots, localStorage, outbox, session data, or Cache Storage.
- Dynamic base URL parses once to canonical `https` with nonempty DNS hostname, no credentials/query/hash, omitted/443 port only, normalized case/trailing dot, no IP literal (including decimal/hex/mapped forms), localhost, or `.local`. URL joins use `new URL(path, baseUrl)` with base-path guard.
- Resolve all A/AAAA records on **every retry**. Require a nonempty all-public answer; reject any mixed answer containing loopback, unspecified, RFC1918, CGNAT, link-local, documentation/test, multicast/reserved, cloud-metadata, IPv6 ULA/link-local/loopback, or IPv4-mapped private address.
- DNS validation alone is insufficient. Dynamic OpenAI-compatible HTTP uses only a request-scoped `node:https.request` transport, never `fetch`: custom lookup returns a prevalidated numeric address, keeps original hostname in TLS SNI/Host, `rejectUnauthorized: true`, redirects/proxy disabled, keep-alive false, max sockets one. This pins each connection to approved DNS result.
- **Production gate:** an integration test runs inside Bun 1.2.17 Docker image and proves custom lookup dials selected address, preserves SNI/Host, rejects redirect, does not reuse socket, and re-resolves safely on retry. If this proof fails, production accepts only finite server-owned `DAILY_PROVIDER_ALLOWED_ORIGINS`; it rejects every other base URL before processing its key. Never ship lookup-then-fetch arbitrary hosts.
- No direct browser provider calls; no third-party scripts. Audit live built/server CSP, change `connect-src` to `'self'` (remove `wss:` while realtime hidden), and update tracked Caddy/nginx plus deployed Caddy. **Release gate:** remove `script-src 'unsafe-inline'`. First prove built production HTML uses only same-origin external scripts; if framework inline scripts are required, add per-response nonce/hash support through web server/proxy and test CSP enforcement before release. `style-src 'unsafe-inline'` remains only if the production shell needs it and is not treated as script/XSS protection. Daily source data renders as JSX text; no user-originated `dangerouslySetInnerHTML` mounts.
- Service worker treats all `/api/*`, authenticated calls, POST/multipart, audio/TTS, and Daily Story paths as NetworkOnly. Bump cache namespace and activate cleanup of legacy navigation/prompt caches so installed PWA cannot surface old dashboard. Add direct origin/method tests.
- Daily state machine drives existing `PwaProvider.setBusy`: starting, recording, transcribing, waiting-for-AI, reviewing, and read-aloud work remain busy, preventing PWA update activation; only stable compose/chat/transcript confirmation/review states can update.

## User-facing surface

- `/` becomes Daily Story compose/conversation/review page; root removes `PracticeStoreProvider` and old outbox sync.
- `/settings` holds compact Chat/ASR/TTS configuration.
- Header is brand plus `⚙ 设置` only. It has no language switch, streak, Progress, Saved, mode, or old Practice links.
- `/practice`, `/saved`, `/progress` use TanStack `beforeLoad` redirects to `/` before legacy components mount; no old Practice page renders.
- Update root metadata, offline page, and manifest wording/language to Chinese product copy; no Japanese user-facing UI or prompt remains.

## Expected files

```text
packages/contracts/src/{daily-story.ts,index.ts}
apps/api/src/modules/daily-story/*
apps/api/src/providers/{request-scoped,outbound-url-policy,safe-https-client}.ts
apps/api/src/{routes.ts,app.ts,runtime.ts} and focused tests
apps/web/src/{routes/index.tsx,routes/settings.tsx,routes/__root.tsx,sw*.ts}
apps/web/src/{features,components,lib}/daily-story/*
apps/web/src/routes/{practice,saved,progress}.tsx
README.md, apps/web/public/offline.html, apps/web/src/lib/{pwa,error-page,error-capture}.ts, generated route tree
.github/workflows/publish-tcr.yml, apps/web/Dockerfile (recovered verified production assets)
```

## Test plan

- IndexedDB settings persistence, upgrade, per/all clear, separation from localStorage/outbox/session, and no secret values in snapshots.
- Reducer: story validation, start, ASR confirmation/re-record, user send, understood/clarify/retry response, end/review, TTS/ASR capability gates, read aloud, double submit, stale results, persisted transcript-confirmation recovery, New Story confirmation, and every failure-matrix recovery.
- Deterministic text model: broken understandable English continues without correction; unclear sentence requests rephrase; review exact-source/max-three validation.
- API multipart handling, ASR fidelity, capability-minimal payloads, TTS `no-store`, sanitized errors/logs/telemetry, and no provider persistence/global/env mutation.
- Outbound URL unit + Bun 1.2.17 Docker integration tests for host spelling/port/protocol/credentials/private IPv4/IPv6/mixed DNS/redirect/retry/rebinding/SNI/Host/address pinning plus valid public HTTPS endpoint.
- Service worker Daily routes network-only and legacy cache cleanup; compatibility redirects do not mount; no legacy header/home language surface.
- IDB unavailable/private Safari, mic denied, ASR Blob retry/no-outbox, typed-source review invariant, rate/concurrency limits, CSP built/live header with no script `unsafe-inline`, and PWA busy update regressions.
- Full repository validation: frozen install, format, lint, typecheck, unit test, build, integration when PostgreSQL available, Docker build, production web and API health smoke.

## Deployment and rollback

1. `origin/main` lacks tracked TCR workflow, API Dockerfile, and web Dockerfile although private operational documentation refers to them. Before feature work, recover known production versions from `codex/finish-durable-ai-architecture`, compare to private runbook, and test them—do not invent a different topology. The recovered API Dockerfile must retain TCR Bun base/registry mirror behavior; no build may newly depend on Docker Hub. The private server Compose/Caddy remains server-managed; preflight confirms it via `docker compose config --images` without reading secrets.
2. Recover/update publish workflow so feature branch's **exact head SHA** gets full CI through an explicit, tightly scoped `push` trigger for `codex/daily-story-conversation` in addition to PR checks. Keep automatic image publish limited to `main` and immutable `deploy/*` tag pushes. This permits deployment of the unmerged Draft PR only after same-SHA branch CI is green; no auto-merge is used.
3. After branch-push CI records tested full commit SHA, create/push immutable annotated `deploy/<full-sha>` tag at exactly that commit. Tag workflow peels/validates the tag points to that named commit before codeload/build. It tags `sha-<40-char-sha>` for convenience but records and emits each TCR image's immutable digest. It never relies on a mutable tag as deployment identity.
4. Deployment preflight: use GitHub workflow/run evidence for the tag and SHA, inspect only `/opt/kotoba` resolved API/web image values and `docker compose ... config --images`, record old image digests/values, verify deployed Caddy/current public headers, and stop if expected images or Compose mapping differ. Update private local runbook to this branch-CI/tag/digest flow and browser-local Daily credential design; keep it untracked and add its explicit path to `.gitignore`.
5. Caddy is server configuration, not an application image. `deploy/Caddyfile` uses `example.com` and must never overwrite production site/TLS/upstream configuration. Before app recreation, back up `/opt/kotoba/Caddyfile` to a SHA-named local server copy; apply only an audited minimal CSP/cache header patch (or existing production fragment), retaining actual site address, TLS, reverse proxies, and body/timeout settings. Use deployed Caddy image to adapt/validate then atomically reload and verify live CSP. On validation/reload/header failure restore/reload backup. Do the same tracked Nginx policy update for parity, but do not alter production Nginx if Caddy is active.
6. Set only `API_IMAGE`/`WEB_IMAGE` to recorded immutable TCR digests (full SHA tag only locates them). Run documented Compose force recreation of `api web`; do not `down -v`, alter secrets, or touch PostgreSQL/MinIO volumes. No migration expected.
7. Smoke HTTPS `/`, `/api/health/live`, `/api/health/ready`, PWA shell/manifest, CSP/cache headers, Daily-only UI, Settings gate, and browser IndexedDB save/reload with a recognizable dummy sentinel key that is never printed or sent upstream.
8. If boot/readiness/proxy/CSP fails, restore recorded Caddy and image digests, then force recreate affected services. No database rollback needed.
