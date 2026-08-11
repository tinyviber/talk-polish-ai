import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { DAILY_STORY_LIMITS } from "@kotoba/contracts";
import { usePwa } from "@/lib/pwa";
import {
  checkDailyProvider,
  replyDailyStory,
  reviewDailyStory,
  startDailyStory,
  synthesizeDailyStory,
  transcribeDailyStory,
  isDailyStoryAbortError,
} from "./api";
import {
  SessionConflictError,
  acquireStoryLease,
  claimStoryLease,
  deleteStorySession,
  ensureDailyStorage,
  readProviderSettings,
  readStorySession,
  releaseStoryLease,
  subscribeDailyStorage,
  writeStorySession,
} from "./settings-repository";
import { dailyReducer, initialDailyState, isDailyBusy, snapshotDailyState } from "./state-machine";
import { releaseTransientTtsPlayback, type TransientTtsPlayback } from "./tts-playback";
import type { ConnectionState, DailyCapability, ProviderSettings, TurnSource } from "./types";
import { createId, trimBounded } from "./types";
import {
  get as getDailyStoryAudio,
  list as listDailyStoryAudio,
  put as putDailyStoryAudio,
  update as updateDailyStoryAudio,
  type DailyStoryAudioPurpose,
} from "./audio-outbox";
import { runSingleFlight } from "./single-flight";

const MAX_STORY = 4_000;
export const DAILY_STORY_TURN_MAX = DAILY_STORY_LIMITS.turnChars;

export type DailyStoryCachedAudio = {
  clientAttemptId: string;
  blob: Blob;
  mimeType: string;
  durationSec: number;
  createdAt: number;
  status: "queued" | "uploading" | "failed" | "completed";
  purpose: DailyStoryAudioPurpose;
  readAloudTarget?: string;
  error?: string;
};

export type DailyStoryTranscribeResult =
  | {
      succeeded: true;
      clientAttemptId: string;
      transcript: string;
      transcriptId: string;
    }
  | {
      succeeded: false;
      clientAttemptId: string;
      error?: string;
    };

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成。请重试。";
}

export function isDailyStoryCachedAudioRetryCurrent(
  mounted: boolean,
  retryGeneration: number,
  currentGeneration: number,
  pageActive = true,
) {
  return isDailyStoryPageActive(mounted, pageActive) && retryGeneration === currentGeneration;
}

export function isDailyStoryPageActive(mounted: boolean, pageActive: boolean) {
  return mounted && pageActive;
}

function persistenceSignature(session: {
  phase: string;
  storyZh: string;
  messages: unknown;
  revision: number | null;
  pendingAsrTranscript?: unknown;
  review?: unknown;
}) {
  return JSON.stringify({
    phase: session.phase,
    storyZh: session.storyZh,
    messages: session.messages,
    ...(session.pendingAsrTranscript ? { pendingAsrTranscript: session.pendingAsrTranscript } : {}),
    ...(session.review ? { review: session.review } : {}),
    revision: session.revision,
  });
}

export function useDailyStoryController(conversationId: string, allowCompose = false) {
  const [state, dispatch] = useReducer(dailyReducer, initialDailyState);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [connection, setConnection] = useState<Record<DailyCapability, ConnectionState>>({
    chat: "idle",
    asr: "idle",
    tts: "idle",
  });
  const [capabilities, setCapabilities] = useState<Record<DailyCapability, boolean>>({
    chat: false,
    asr: false,
    tts: false,
  });
  const [conversationMissing, setConversationMissing] = useState(false);
  const [cachedAudio, setCachedAudio] = useState<DailyStoryCachedAudio | null>(null);
  const stateRef = useRef(state);
  const ownerIdRef = useRef(createId("tab"));
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const pageActiveRef = useRef(true);
  const generationRef = useRef(0);
  const retryRef = useRef<(() => void) | null>(null);
  const reviewInFlightRef = useRef(false);
  const transcribeInFlightRef = useRef<Promise<DailyStoryTranscribeResult> | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const audioOutboxAttemptRef = useRef<string | null>(null);
  const ttsPlaybackRef = useRef<TransientTtsPlayback | null>(null);
  const persistenceSignatureRef = useRef<string | null>(null);
  const settingsRevisionRef = useRef(0);
  const { setBusy } = usePwa();
  const releaseTtsPlayback = useCallback(() => {
    const playback = ttsPlaybackRef.current;
    ttsPlaybackRef.current = null;
    releaseTransientTtsPlayback(playback);
  }, []);
  const invalidateCurrent = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
  }, []);

  const refreshCachedAudio = useCallback(async () => {
    try {
      const items = await listDailyStoryAudio({ conversationId });
      const item = items.at(-1);
      setCachedAudio(
        item
          ? {
              clientAttemptId: item.clientAttemptId,
              blob: item.blob,
              mimeType: item.mimeType,
              durationSec: item.durationSec,
              createdAt: item.createdAt,
              status: item.status,
              purpose: item.purpose,
              ...(item.readAloudTarget ? { readAloudTarget: item.readAloudTarget } : {}),
              ...(item.error ? { error: item.error } : {}),
            }
          : null,
      );
    } catch {
      // Cache inspection must never block the conversation UI.
    }
  }, [conversationId]);

  useEffect(() => {
    void refreshCachedAudio();
  }, [refreshCachedAudio]);

  useEffect(() => {
    stateRef.current = state;
    setBusy(isDailyBusy(state.phase), "daily-story");
  }, [setBusy, state]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pageActiveRef.current = false;
      invalidateCurrent();
      releaseTtsPlayback();
      setBusy(false, "daily-story");
    };
  }, [invalidateCurrent, releaseTtsPlayback, setBusy]);

  useEffect(() => {
    let alive = true;
    let leaseActive = false;
    const owner = ownerIdRef.current;
    const load = async () => {
      try {
        await ensureDailyStorage();
        const session = await readStorySession(conversationId);
        if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
        if (!session && !allowCompose) {
          setCanEdit(false);
          setConversationMissing(true);
          setStorageError(null);
          dispatch({ type: "ready", session: null, settingsRevision: settingsRevisionRef.current });
          return;
        }
        setConversationMissing(false);
        const lease = await claimStoryLease(conversationId, owner);
        if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
        leaseActive = lease;
        setCanEdit(lease);
        const settings = await readProviderSettings();
        if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
        settingsRevisionRef.current = settings.revision;
        setCapabilities({ chat: !!settings.chat, asr: !!settings.asr, tts: !!settings.tts });
        persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
        setStorageError(null);
        dispatch({ type: "ready", session, settingsRevision: settings.revision });
      } catch (error) {
        if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
        setStorageError(message(error));
        dispatch({ type: "ready", session: null, settingsRevision: settingsRevisionRef.current });
      }
    };
    void load();
    const onPageHide = () => {
      if (stateRef.current.phase === "reviewing") {
        dispatch({ type: "reviewCancelled" });
      }
      pageActiveRef.current = false;
      mountedRef.current = false;
      leaseActive = false;
      setCanEdit(false);
      invalidateCurrent();
    };
    const onPageShow = () => {
      pageActiveRef.current = true;
      mountedRef.current = true;
      void load();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    const renew = window.setInterval(() => {
      if (!leaseActive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current))
        return;
      void acquireStoryLease(conversationId, owner)
        .then((lease) => {
          if (alive && isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) {
            setCanEdit(lease);
            leaseActive = lease;
          }
        })
        .catch((error: unknown) => {
          if (alive && isDailyStoryPageActive(mountedRef.current, pageActiveRef.current))
            setStorageError(message(error));
        });
    }, 8_000);
    const unsubscribe = subscribeDailyStorage((event) => {
      if (event.kind === "settings") {
        void readProviderSettings()
          .then((settings) => {
            if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current))
              return;
            setCapabilities({ chat: !!settings.chat, asr: !!settings.asr, tts: !!settings.tts });
            if (settings.revision <= settingsRevisionRef.current) return;
            const hadActiveOperation = stateRef.current.operation !== null;
            settingsRevisionRef.current = settings.revision;
            if (hadActiveOperation) {
              invalidateCurrent();
              setStorageError("API 配置已在另一标签页更新。当前操作已取消，请按新配置重试。");
            }
            dispatch({ type: "settingsRevisionChanged", settingsRevision: settings.revision });
          })
          .catch((error: unknown) => alive && setStorageError(message(error)));
        return;
      }
      if (event.kind === "lease") {
        if (event.conversationId !== conversationId || event.ownerId === owner) return;
        leaseActive = false;
        setCanEdit(false);
        invalidateCurrent();
        void readStorySession(conversationId)
          .then((session) => {
            if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current))
              return;
            persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
            dispatch({
              type: "ready",
              session,
              settingsRevision: settingsRevisionRef.current,
            });
          })
          .catch((error: unknown) => alive && setStorageError(message(error)));
        return;
      }
      if (event.kind !== "session" || event.conversationId !== conversationId) return;
      // Metadata-only signal. Reload from IndexedDB; never trust cross-tab payloads.
      setCanEdit(false);
      leaseActive = false;
      invalidateCurrent();
      void readStorySession(conversationId)
        .then((session) => {
          if (!alive || !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
          persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
          dispatch({
            type: "ready",
            session,
            settingsRevision: settingsRevisionRef.current,
          });
        })
        .catch((error: unknown) => alive && setStorageError(message(error)));
    });
    return () => {
      alive = false;
      pageActiveRef.current = false;
      mountedRef.current = false;
      window.clearInterval(renew);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      unsubscribe();
      void releaseStoryLease(conversationId, owner);
    };
  }, [allowCompose, conversationId, invalidateCurrent]);

  useEffect(() => {
    const snapshot = snapshotDailyState(state);
    if (!snapshot || !canEdit) return;
    const signature = persistenceSignature({ ...snapshot, revision: state.revision });
    if (signature === persistenceSignatureRef.current) return;
    persistenceSignatureRef.current = signature;
    void writeStorySession(conversationId, snapshot, state.revision, ownerIdRef.current)
      .then((session) => {
        persistenceSignatureRef.current = persistenceSignature(session);
        setStorageError(null);
        dispatch({ type: "persisted", session });
      })
      .catch((error: unknown) => {
        if (error instanceof SessionConflictError) {
          setCanEdit(false);
          void readStorySession(conversationId).then((session) =>
            dispatch({ type: "ready", session, settingsRevision: settingsRevisionRef.current }),
          );
        }
        setStorageError(message(error));
      });
  }, [canEdit, conversationId, state]);

  const guard = useCallback(
    () =>
      isDailyStoryPageActive(mountedRef.current, pageActiveRef.current) &&
      canEdit &&
      !isDailyBusy(stateRef.current.phase),
    [canEdit],
  );
  const abortCurrent = useCallback(() => {
    invalidateCurrent();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, [invalidateCurrent]);
  const currentSettings = useCallback(async () => {
    try {
      const settings = await readProviderSettings();
      if (settings.revision > settingsRevisionRef.current) {
        settingsRevisionRef.current = settings.revision;
        dispatch({ type: "settingsRevisionChanged", settingsRevision: settings.revision });
      }
      setStorageError(null);
      return settings;
    } catch (error) {
      setStorageError(message(error));
      throw error;
    }
  }, []);

  const start = useCallback(async () => {
    if (!guard()) return;
    const storyZh = trimBounded(stateRef.current.draft, MAX_STORY);
    if (!storyZh) {
      dispatch({
        type: "failure",
        message: "请先写下今天想聊的中文故事。",
        resumePhase: "chatting",
      });
      return;
    }
    let operationId: string | undefined;
    let operationSettingsRevision: number | undefined;
    try {
      const settings = await currentSettings();
      if (!isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
      if (!settings.chat) {
        setStorageError("开始聊天前，请先在设置中保存 Chat 配置。");
        return;
      }
      operationId = createId("start");
      operationSettingsRevision = settings.revision;
      const controller = abortCurrent();
      dispatch({ type: "startRequest", operationId, settingsRevision: settings.revision, storyZh });
      const result = await startDailyStory({
        storyZh,
        chat: settings.chat,
        signal: controller.signal,
      });
      dispatch({
        type: "startSuccess",
        operationId,
        settingsRevision: settings.revision,
        opening: { id: result.opening.id, role: "assistant", text: result.opening.text },
      });
    } catch (error) {
      if (
        isDailyStoryAbortError(error) ||
        !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
      )
        return;
      dispatch({
        type: "failure",
        message: message(error),
        resumePhase: "chatting",
        kind: "start",
        ...(operationId && operationSettingsRevision !== undefined
          ? { operationId, settingsRevision: operationSettingsRevision }
          : {}),
      });
      retryRef.current = () => void start();
    }
  }, [abortCurrent, currentSettings, guard]);

  const transcribe = useCallback(
    async (
      audio: Blob,
      readAloud = false,
      durationSec = 0,
      fromCache = false,
      readAloudTarget?: string,
      clientAttemptIdOverride?: string,
    ): Promise<DailyStoryTranscribeResult> => {
      return runSingleFlight(transcribeInFlightRef, async () => {
        const target = readAloudTarget ?? stateRef.current.readAloudTarget ?? undefined;
        if (
          !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current) ||
          !canEdit ||
          !(
            [
              "recording",
              "recordingDraftReady",
              "readingAloudRecording",
              "readingAloudDraftReady",
              "error",
            ].includes(stateRef.current.phase) ||
            (fromCache &&
              (stateRef.current.phase === "chatting" ||
                stateRef.current.phase === "review" ||
                stateRef.current.phase === "error"))
          )
        )
          return {
            succeeded: false,
            clientAttemptId:
              clientAttemptIdOverride ?? audioOutboxAttemptRef.current ?? createId("asr"),
          };
        blobRef.current = audio;
        const clientAttemptId =
          clientAttemptIdOverride ?? audioOutboxAttemptRef.current ?? createId("asr");
        audioOutboxAttemptRef.current = clientAttemptId;
        const controller = abortCurrent();
        let operationId: string | undefined;
        let operationSettingsRevision: number | undefined;
        let transcriptId: string | undefined;
        try {
          try {
            await putDailyStoryAudio({
              clientAttemptId,
              conversationId,
              blob: audio,
              mimeType: audio.type || "application/octet-stream",
              durationSec: Math.max(0, durationSec),
              createdAt: Date.now(),
              purpose: readAloud ? "readAloud" : "conversation",
              ...(readAloud && target ? { readAloudTarget: target } : {}),
            });
            await updateDailyStoryAudio(clientAttemptId, { status: "uploading", error: null });
            await refreshCachedAudio();
          } catch (error) {
            // IndexedDB is a reliability enhancement. If browser storage is
            // unavailable, keep the direct upload path usable.
            setStorageError(`录音未能写入本地缓存，将直接上传：${message(error)}`);
          }
          if (
            controller.signal.aborted ||
            !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
          ) {
            await updateDailyStoryAudio(clientAttemptId, { status: "queued", error: null }).catch(
              () => {},
            );
            return { succeeded: false, clientAttemptId };
          }
          const settings = await currentSettings();
          if (!isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) {
            await updateDailyStoryAudio(clientAttemptId, { status: "queued", error: null }).catch(
              () => {},
            );
            return { succeeded: false, clientAttemptId };
          }
          if (!settings.asr) {
            await updateDailyStoryAudio(clientAttemptId, {
              status: "queued",
              error: "语音聊天需配置 ASR。",
            }).catch(() => {});
            await refreshCachedAudio();
            setStorageError("语音聊天需配置 ASR。可继续使用文字输入（备用，不是语音转写）。");
            dispatch({ type: readAloud ? "resetReadAloud" : "reRecord" });
            return {
              succeeded: false,
              clientAttemptId,
              error: "语音聊天需配置 ASR。",
            };
          }
          operationId = createId(readAloud ? "read" : "asr");
          operationSettingsRevision = settings.revision;
          transcriptId = createId(readAloud ? "read" : "asr");
          dispatch({
            type: "transcribeRequest",
            operationId,
            settingsRevision: settings.revision,
            readAloud,
            cached: fromCache,
            ...(target ? { readAloudTarget: target } : {}),
          });
          const result = await transcribeDailyStory({
            audio,
            asr: settings.asr,
            directAsr: settings.local?.asrDirect ?? false,
            signal: controller.signal,
          });
          const text = result.transcript;
          if (!text.trim()) throw new Error("没有识别到语音。请重录后再试。");
          // Keep the successful recording in the seven-day outbox as well. This
          // lets us inspect/retry the exact bytes when an upstream ASR model
          // returns a clearly wrong language instead of deleting the evidence.
          await updateDailyStoryAudio(clientAttemptId, {
            status: "completed",
            error: null,
          }).catch(() => {});
          await refreshCachedAudio();
          audioOutboxAttemptRef.current = null;
          dispatch({
            type: "transcribeSuccess",
            operationId,
            settingsRevision: settings.revision,
            readAloud,
            transcript: { id: transcriptId, source: "asr", text },
          });
          return { succeeded: true, clientAttemptId, transcript: text, transcriptId };
        } catch (error) {
          if (
            isDailyStoryAbortError(error) ||
            !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
          ) {
            await updateDailyStoryAudio(clientAttemptId, { status: "queued", error: null }).catch(
              () => {},
            );
            return { succeeded: false, clientAttemptId };
          }
          const errorMessage = message(error);
          await updateDailyStoryAudio(clientAttemptId, {
            status: "failed",
            error: errorMessage,
          }).catch(() => {});
          await refreshCachedAudio();
          dispatch({
            type: "failure",
            message: errorMessage,
            resumePhase: readAloud ? "review" : "chatting",
            kind: "transcribe",
            ...(operationId && operationSettingsRevision !== undefined
              ? { operationId, settingsRevision: operationSettingsRevision }
              : {}),
          });
          retryRef.current = () => {
            if (blobRef.current)
              void transcribe(
                blobRef.current,
                readAloud,
                durationSec,
                false,
                target,
                clientAttemptId,
              );
          };
          return { succeeded: false, clientAttemptId, error: errorMessage };
        }
      });
    },
    [abortCurrent, canEdit, conversationId, currentSettings, refreshCachedAudio],
  );

  const retryCachedAudio = useCallback(() => {
    const attemptId = cachedAudio?.clientAttemptId;
    if (!canEdit || !attemptId) return;
    const retryGeneration = generationRef.current;
    void getDailyStoryAudio(attemptId)
      .then((item) => {
        if (
          !isDailyStoryCachedAudioRetryCurrent(
            mountedRef.current,
            retryGeneration,
            generationRef.current,
            pageActiveRef.current,
          )
        )
          return;
        if (!item) throw new Error("找不到缓存录音。录音可能已超过 7 天或已被清理。");
        blobRef.current = item.blob;
        audioOutboxAttemptRef.current = item.clientAttemptId;
        const readAloud = item.purpose === "readAloud";
        return transcribe(item.blob, readAloud, item.durationSec, true, item.readAloudTarget);
      })
      .catch((error: unknown) => {
        if (
          isDailyStoryCachedAudioRetryCurrent(
            mountedRef.current,
            retryGeneration,
            generationRef.current,
            pageActiveRef.current,
          )
        )
          setStorageError(message(error));
      });
  }, [cachedAudio, canEdit, transcribe]);

  const send = useCallback(
    async (source: TurnSource, rawText: string): Promise<boolean> => {
      if (
        (!guard() && stateRef.current.phase !== "error") ||
        !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
      )
        return false;
      const text = rawText.trim();
      if (!text) return false;
      if (text.length > DAILY_STORY_TURN_MAX) {
        setStorageError(`文字输入最多 ${DAILY_STORY_TURN_MAX} 个字符。请缩短后再发送。`);
        return false;
      }
      const turn = { id: stateRef.current.pendingTranscript?.id ?? createId(source), source, text };
      let operationId: string | undefined;
      let operationSettingsRevision: number | undefined;
      try {
        const settings = await currentSettings();
        if (!isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return false;
        if (!settings.chat) {
          setStorageError("请先在设置中保存 Chat 配置。");
          return false;
        }
        operationId = createId("reply");
        operationSettingsRevision = settings.revision;
        const controller = abortCurrent();
        dispatch({ type: "sendRequest", operationId, settingsRevision: settings.revision, turn });
        const result = await replyDailyStory({
          storyZh: stateRef.current.storyZh,
          history: stateRef.current.messages,
          turn,
          chat: settings.chat,
          signal: controller.signal,
        });
        dispatch({
          type: "replySuccess",
          operationId,
          settingsRevision: settings.revision,
          turn,
          assistant: { id: createId("ai"), role: "assistant", text: result.reply },
        });
        return true;
      } catch (error) {
        if (
          isDailyStoryAbortError(error) ||
          !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
        )
          return false;
        dispatch({
          type: "failure",
          message: message(error),
          resumePhase: "chatting",
          kind: "reply",
          ...(operationId && operationSettingsRevision !== undefined
            ? { operationId, settingsRevision: operationSettingsRevision }
            : {}),
        });
        retryRef.current = () => void send(source, rawText);
        return false;
      }
    },
    [abortCurrent, currentSettings, guard],
  );

  const finish = useCallback(async () => {
    if (!guard()) return;
    const current = stateRef.current;
    if (!current.messages.some((item) => item.role === "user" && item.text.trim())) return;
    if (reviewInFlightRef.current) return;
    reviewInFlightRef.current = true;
    let operationId: string | undefined;
    let operationSettingsRevision: number | undefined;
    try {
      const settings = await currentSettings();
      if (!isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)) return;
      if (!settings.chat) return;
      operationId = createId("review");
      operationSettingsRevision = settings.revision;
      const controller = abortCurrent();
      dispatch({ type: "reviewRequest", operationId, settingsRevision: settings.revision });
      const review = await reviewDailyStory({
        storyZh: current.storyZh,
        history: current.messages,
        chat: settings.chat,
        signal: controller.signal,
      });
      dispatch({ type: "reviewSuccess", operationId, settingsRevision: settings.revision, review });
    } catch (error) {
      if (
        isDailyStoryAbortError(error) ||
        !isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
      )
        return;
      dispatch({
        type: "failure",
        message: message(error),
        resumePhase: "chatting",
        kind: "review",
        ...(operationId && operationSettingsRevision !== undefined
          ? { operationId, settingsRevision: operationSettingsRevision }
          : {}),
      });
      retryRef.current = () => void finish();
    } finally {
      reviewInFlightRef.current = false;
    }
  }, [abortCurrent, currentSettings, guard]);

  const checkProvider = useCallback(
    async (
      capability: DailyCapability,
      provider: NonNullable<ProviderSettings[DailyCapability]>,
    ) => {
      setConnection((current) => ({ ...current, [capability]: "checking" }));
      try {
        const settings = await currentSettings();
        await checkDailyProvider({
          capability,
          provider,
          ...(capability === "asr" ? { directAsr: settings.local?.asrDirect ?? false } : {}),
        });
        setConnection((current) => ({ ...current, [capability]: "connected" }));
        return true;
      } catch {
        setConnection((current) => ({ ...current, [capability]: "failed" }));
        return false;
      }
    },
    [currentSettings],
  );

  const playTts = useCallback(
    async (text: string) => {
      try {
        const settings = await currentSettings();
        if (!settings.tts) {
          setStorageError("未配置 TTS，无法朗读。");
          return;
        }
        releaseTtsPlayback();
        const controller = abortCurrent();
        const blob = await synthesizeDailyStory({
          text,
          tts: settings.tts,
          signal: controller.signal,
        });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const playback = { audio, url };
        ttsPlaybackRef.current = playback;
        const revoke = () => {
          if (ttsPlaybackRef.current === playback) ttsPlaybackRef.current = null;
          releaseTransientTtsPlayback(playback);
        };
        audio.addEventListener("ended", revoke, { once: true });
        audio.addEventListener("error", revoke, { once: true });
        try {
          await audio.play();
        } catch (error) {
          revoke();
          throw error;
        }
      } catch (error) {
        if (
          !isDailyStoryAbortError(error) &&
          isDailyStoryPageActive(mountedRef.current, pageActiveRef.current)
        )
          setStorageError(message(error));
      }
    },
    [abortCurrent, currentSettings, releaseTtsPlayback],
  );

  const retry = useCallback(() => retryRef.current?.(), []);
  const beginRecording = useCallback(() => {
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    dispatch({ type: "recording" });
  }, []);
  const recordingDraftReady = useCallback((readAloud = false) => {
    dispatch({ type: "recordingDraftReady", readAloud });
  }, []);
  const continueRecording = useCallback((readAloud = false) => {
    dispatch({ type: "continueRecording", readAloud });
  }, []);
  const cancelRecording = useCallback(() => dispatch({ type: "recordingCancelled" }), []);
  const saveAsrDraft = useCallback(
    (rawText: string) => {
      if (!canEdit) return false;
      const text = trimBounded(rawText, DAILY_STORY_TURN_MAX);
      if (!text || stateRef.current.pendingTranscript?.source !== "asr") return false;
      dispatch({ type: "editTranscript", text });
      return true;
    },
    [canEdit],
  );
  const beginReadAloud = useCallback((target: string) => {
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    dispatch({ type: "readAloudRecording", target });
  }, []);
  const newStory = useCallback(async () => {
    if (stateRef.current.messages.length && !window.confirm("开始新故事会放弃当前对话。继续吗？"))
      return;
    invalidateCurrent();
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    persistenceSignatureRef.current = null;
    try {
      await deleteStorySession(conversationId, stateRef.current.revision);
    } catch (error) {
      setStorageError(message(error));
      return;
    }
    dispatch({ type: "newStory" });
  }, [conversationId, invalidateCurrent]);

  return {
    state,
    canEdit,
    storageError,
    connection,
    capabilities,
    conversationMissing,
    cachedAudio,
    setDraft: (draft: string) => dispatch({ type: "draft", draft }),
    start,
    beginRecording,
    recordingDraftReady,
    continueRecording,
    transcribe,
    cancelRecording,
    saveAsrDraft,
    retryCachedAudio,
    sendAsr: (text: string) => void send("asr", text),
    sendTyped: (text: string) => send("typed", text),
    reRecord: () => dispatch({ type: "reRecord" }),
    finish,
    beginReadAloud,
    resetReadAloud: () => dispatch({ type: "resetReadAloud" }),
    playTts: (text: string) => void playTts(text),
    retry,
    newStory,
    checkProvider,
  };
}
