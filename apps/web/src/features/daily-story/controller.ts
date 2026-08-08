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

const MAX_STORY = 4_000;
export const DAILY_STORY_TURN_MAX = DAILY_STORY_LIMITS.turnChars;

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成。请重试。";
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

export function useDailyStoryController() {
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
  const stateRef = useRef(state);
  const ownerIdRef = useRef(createId("tab"));
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const ttsPlaybackRef = useRef<TransientTtsPlayback | null>(null);
  const persistenceSignatureRef = useRef<string | null>(null);
  const settingsRevisionRef = useRef(0);
  const { setBusy } = usePwa();
  const releaseTtsPlayback = useCallback(() => {
    const playback = ttsPlaybackRef.current;
    ttsPlaybackRef.current = null;
    releaseTransientTtsPlayback(playback);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    setBusy(isDailyBusy(state.phase), "daily-story");
  }, [setBusy, state]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseTtsPlayback();
      setBusy(false, "daily-story");
    },
    [releaseTtsPlayback, setBusy],
  );

  useEffect(() => {
    let alive = true;
    const owner = ownerIdRef.current;
    const load = async () => {
      try {
        await ensureDailyStorage();
        const lease = await acquireStoryLease(owner);
        if (!alive) return;
        setCanEdit(lease);
        if (!lease) setStorageError("此对话正在另一标签页编辑。此页仅显示最新内容。");
        const session = await readStorySession();
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
      void acquireStoryLease(owner)
        .then((lease) => {
          if (alive) setCanEdit(lease);
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
              abortRef.current?.abort();
              setStorageError("API 配置已在另一标签页更新。当前操作已取消，请按新配置重试。");
            }
            dispatch({ type: "settingsRevisionChanged", settingsRevision: settings.revision });
          })
          .catch((error: unknown) => alive && setStorageError(message(error)));
        return;
      }
      if (event.kind !== "session") return;
      // Metadata-only signal. Reload from IndexedDB; never trust cross-tab payloads.
      setCanEdit(false);
      void readStorySession()
        .then((session) => {
          if (!alive) return;
          persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
          dispatch({
            type: "ready",
            session,
            settingsRevision: settingsRevisionRef.current,
          });
          setStorageError("另一标签页已更新对话。此页已切换为只读，避免覆盖新内容。");
        })
        .catch((error: unknown) => alive && setStorageError(message(error)));
    });
    return () => {
      alive = false;
      window.clearInterval(renew);
      unsubscribe();
      void releaseStoryLease(owner);
    };
  }, []);

  useEffect(() => {
    const snapshot = snapshotDailyState(state);
    if (!snapshot || !canEdit) return;
    const signature = persistenceSignature({ ...snapshot, revision: state.revision });
    if (signature === persistenceSignatureRef.current) return;
    persistenceSignatureRef.current = signature;
    void writeStorySession(snapshot, state.revision)
      .then((session) => {
        persistenceSignatureRef.current = persistenceSignature(session);
        dispatch({ type: "persisted", session });
      })
      .catch((error: unknown) => {
        if (error instanceof SessionConflictError) {
          setCanEdit(false);
          void readStorySession().then((session) =>
            dispatch({ type: "ready", session, settingsRevision: settingsRevisionRef.current }),
          );
        }
        setStorageError(message(error));
      });
  }, [canEdit, state]);

  const guard = useCallback(() => canEdit && !isDailyBusy(stateRef.current.phase), [canEdit]);
  const abortCurrent = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);
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
    async (audio: Blob, readAloud = false) => {
      if (
        !canEdit ||
        !["recording", "readingAloudRecording", "error"].includes(stateRef.current.phase)
      )
        return;
      blobRef.current = audio;
      try {
        const settings = await currentSettings();
        if (!settings.asr) {
          setStorageError("语音聊天需配置 ASR。可继续使用文字输入（备用，不是语音转写）。");
          dispatch({ type: readAloud ? "resetReadAloud" : "reRecord" });
          return;
        }
        const operationId = createId(readAloud ? "read" : "asr");
        const controller = abortCurrent();
        dispatch({
          type: "transcribeRequest",
          operationId,
          settingsRevision: settings.revision,
          readAloud,
        });
        const result = await transcribeDailyStory({
          audio,
          asr: settings.asr,
          signal: controller.signal,
        });
        const text = result.transcript;
        if (!text.trim()) throw new Error("没有识别到语音。请重录后再试。");
        dispatch({
          type: "transcribeSuccess",
          operationId,
          settingsRevision: settings.revision,
          readAloud,
          transcript: { id: createId(readAloud ? "read" : "asr"), source: "asr", text },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        dispatch({
          type: "failure",
          message: message(error),
          resumePhase: readAloud ? "review" : "chatting",
        });
        retryRef.current = () => {
          if (blobRef.current) void transcribe(blobRef.current, readAloud);
        };
      }
    },
    [abortCurrent, canEdit, currentSettings],
  );

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
  const newStory = useCallback(async () => {
    if (stateRef.current.messages.length && !window.confirm("开始新故事会放弃当前对话。继续吗？"))
      return;
    abortRef.current?.abort();
    blobRef.current = null;
    persistenceSignatureRef.current = null;
    try {
      await deleteStorySession(stateRef.current.revision);
    } catch (error) {
      setStorageError(message(error));
      return;
    }
    dispatch({ type: "newStory" });
  }, []);

  return {
    state,
    canEdit,
    storageError,
    connection,
    capabilities,
    setDraft: (draft: string) => dispatch({ type: "draft", draft }),
    start,
    beginRecording: () => dispatch({ type: "recording" }),
    transcribe,
    cancelRecording: () => dispatch({ type: "recordingCancelled" }),
    sendAsr: (text: string) => void send("asr", text),
    sendTyped: (text: string) => send("typed", text),
    reRecord: () => dispatch({ type: "reRecord" }),
    finish,
    beginReadAloud: (target: string) => dispatch({ type: "readAloudRecording", target }),
    resetReadAloud: () => dispatch({ type: "resetReadAloud" }),
    playTts: (text: string) => void playTts(text),
    retry,
    newStory,
    checkProvider,
  };
}
