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

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成。请重试。";
}

export function isDailyStoryCachedAudioRetryCurrent(
  mounted: boolean,
  retryGeneration: number,
  currentGeneration: number,
) {
  return mounted && retryGeneration === currentGeneration;
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
  const generationRef = useRef(0);
  const retryRef = useRef<(() => void) | null>(null);
  const reviewInFlightRef = useRef(false);
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
        if (!alive) return;
        if (!session && !allowCompose) {
          setCanEdit(false);
          setConversationMissing(true);
          dispatch({ type: "ready", session: null, settingsRevision: settingsRevisionRef.current });
          return;
        }
        setConversationMissing(false);
        const lease = await claimStoryLease(conversationId, owner);
        if (!alive) return;
        leaseActive = lease;
        setCanEdit(lease);
        const settings = await readProviderSettings();
        if (!alive) return;
        settingsRevisionRef.current = settings.revision;
        setCapabilities({ chat: !!settings.chat, asr: !!settings.asr, tts: !!settings.tts });
        persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
        dispatch({ type: "ready", session, settingsRevision: settings.revision });
      } catch (error) {
        if (!alive) return;
        setStorageError(message(error));
        dispatch({ type: "ready", session: null, settingsRevision: settingsRevisionRef.current });
      }
    };
    void load();
    const renew = window.setInterval(() => {
      if (!leaseActive) return;
      void acquireStoryLease(conversationId, owner)
        .then((lease) => {
          if (alive) {
            setCanEdit(lease);
            leaseActive = lease;
          }
        })
        .catch((error: unknown) => {
          if (alive) setStorageError(message(error));
        });
    }, 8_000);
    const unsubscribe = subscribeDailyStorage((event) => {
      if (event.kind === "settings") {
        void readProviderSettings()
          .then((settings) => {
            if (!alive) return;
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
            if (!alive) return;
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
          if (!alive) return;
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
      window.clearInterval(renew);
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

  const guard = useCallback(() => canEdit && !isDailyBusy(stateRef.current.phase), [canEdit]);
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
    try {
      const settings = await currentSettings();
      if (!settings.chat) {
        setStorageError("开始聊天前，请先在设置中保存 Chat 配置。");
        return;
      }
      const operationId = createId("start");
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
      if (error instanceof DOMException && error.name === "AbortError") return;
      dispatch({ type: "failure", message: message(error), resumePhase: "chatting" });
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
    ) => {
      const target = readAloudTarget ?? stateRef.current.readAloudTarget ?? undefined;
      if (
        !canEdit ||
        !(
          ["recording", "readingAloudRecording", "error"].includes(stateRef.current.phase) ||
          (fromCache &&
            (stateRef.current.phase === "chatting" ||
              stateRef.current.phase === "review" ||
              stateRef.current.phase === "error"))
        )
      )
        return;
      blobRef.current = audio;
      const clientAttemptId = audioOutboxAttemptRef.current ?? createId("asr");
      audioOutboxAttemptRef.current = clientAttemptId;
      const controller = abortCurrent();
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
        if (controller.signal.aborted) {
          await updateDailyStoryAudio(clientAttemptId, { status: "queued", error: null }).catch(
            () => {},
          );
          return;
        }
        const settings = await currentSettings();
        if (!settings.asr) {
          await updateDailyStoryAudio(clientAttemptId, {
            status: "queued",
            error: "语音聊天需配置 ASR。",
          }).catch(() => {});
          await refreshCachedAudio();
          setStorageError("语音聊天需配置 ASR。可继续使用文字输入（备用，不是语音转写）。");
          dispatch({ type: readAloud ? "resetReadAloud" : "reRecord" });
          return;
        }
        const operationId = createId(readAloud ? "read" : "asr");
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
          transcript: { id: createId(readAloud ? "read" : "asr"), source: "asr", text },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          await updateDailyStoryAudio(clientAttemptId, { status: "queued", error: null }).catch(
            () => {},
          );
          return;
        }
        await updateDailyStoryAudio(clientAttemptId, {
          status: "failed",
          error: message(error),
        }).catch(() => {});
        await refreshCachedAudio();
        dispatch({
          type: "failure",
          message: message(error),
          resumePhase: readAloud ? "review" : "chatting",
        });
        retryRef.current = () => {
          if (blobRef.current)
            void transcribe(blobRef.current, readAloud, durationSec, false, target);
        };
      }
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
          )
        )
          setStorageError(message(error));
      });
  }, [cachedAudio, canEdit, transcribe]);

  const send = useCallback(
    async (source: TurnSource, rawText: string): Promise<boolean> => {
      if (!guard() && stateRef.current.phase !== "error") return false;
      const text = rawText.trim();
      if (!text) return false;
      if (text.length > DAILY_STORY_TURN_MAX) {
        setStorageError(`文字输入最多 ${DAILY_STORY_TURN_MAX} 个字符。请缩短后再发送。`);
        return false;
      }
      const turn = { id: stateRef.current.pendingTranscript?.id ?? createId(source), source, text };
      try {
        const settings = await currentSettings();
        if (!settings.chat) {
          setStorageError("请先在设置中保存 Chat 配置。");
          return false;
        }
        const operationId = createId("reply");
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
        if (error instanceof DOMException && error.name === "AbortError") return false;
        dispatch({ type: "failure", message: message(error), resumePhase: "chatting" });
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
    try {
      const settings = await currentSettings();
      if (!settings.chat) return;
      const operationId = createId("review");
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
      if (error instanceof DOMException && error.name === "AbortError") return;
      dispatch({ type: "failure", message: message(error), resumePhase: "chatting" });
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
        await checkDailyProvider({ capability, provider });
        setConnection((current) => ({ ...current, [capability]: "connected" }));
        return true;
      } catch {
        setConnection((current) => ({ ...current, [capability]: "failed" }));
        return false;
      }
    },
    [],
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
        if (!(error instanceof DOMException && error.name === "AbortError"))
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
