import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
  readProviderSettings,
  deleteStorySession,
  ensureDailyStorage,
  readStorySession,
  writeStorySession,
  claimStoryLeaseToken,
  LEASE_RETRY_DELAY_MS,
  renewStoryLeaseToken,
  releaseStoryLeaseToken,
  SessionConflictError,
  StorySidecarPersistenceError,
  subscribeDailyStorage,
} from "./persistence";
import { dailyReducer, initialDailyState, isDailyBusy, snapshotDailyState } from "./state-machine";
import { releaseTransientTtsPlayback, type TransientTtsPlayback } from "./tts-playback";
import type {
  ConnectionState,
  DailyCapability,
  ProviderSettings,
  StorySession,
  TurnSource,
} from "./types";
import { createId, trimBounded } from "./types";
import {
  get as getDailyStoryAudio,
  list as listDailyStoryAudio,
  put as putDailyStoryAudio,
  update as updateDailyStoryAudio,
} from "./audio-outbox";
import { runSingleFlight } from "./single-flight";
import { isDailyStoryCachedAudioRetryCurrent, splitDailyStoryAudio } from "./controller-helpers";
import {
  DAILY_STORY_TURN_MAX,
  type DailyStoryCachedAudio,
  type DailyStoryTranscribeResult,
} from "./shared-types";
import { DailyStoryCoordinator, type OperationToken } from "./coordinator";

export {
  isDailyStoryCachedAudioRetryCurrent,
  isDailyStoryPageActive,
  splitDailyStoryAudio,
} from "./controller-helpers";
export { DAILY_STORY_TURN_MAX } from "./shared-types";
export type { DailyStoryCachedAudio, DailyStoryTranscribeResult } from "./shared-types";

const MAX_STORY = 4_000;

type AudioOutboxUploadingAttempt = { clientAttemptId: string; updatedAt: number };

function message(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成。请重试。";
}

export function getLeaseProtectedMutationToken(
  canEdit: boolean,
  pageActive: boolean,
  claimToken: string | null,
) {
  return canEdit && pageActive ? claimToken : null;
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

type StorySessionReader = (conversationId: string) => Promise<StorySession | null>;

type CommittedStoryDeleteRecovery = {
  readSession: StorySessionReader;
  isCurrent: () => boolean;
  clearPersistenceSignature: () => void;
  dispatchNewStory: () => void;
  setStorageError: (message: string) => void;
  warn?: (...args: unknown[]) => void;
};

const STORY_SIDECAR_CLEANUP_WARNING = "故事已删除，但复核缓存清理失败。系统会在后台继续清理。";

/** Advance the UI after the primary session delete committed but sidecar cleanup did not. */
export async function recoverCommittedStoryDeletion(
  conversationId: string,
  error: unknown,
  dependencies: CommittedStoryDeleteRecovery,
) {
  if (!(error instanceof StorySidecarPersistenceError) || error.operation !== "delete")
    return false;

  let remaining: StorySession | null;
  try {
    remaining = await dependencies.readSession(conversationId);
  } catch {
    return false;
  }
  if (remaining !== null || !dependencies.isCurrent()) return false;

  (dependencies.warn ?? ((...args: unknown[]) => console.warn(...args)))(
    "[daily-story sidecar cleanup pending]",
    { conversationId, operation: error.operation },
  );
  dependencies.setStorageError(STORY_SIDECAR_CLEANUP_WARNING);
  dependencies.clearPersistenceSignature();
  dependencies.dispatchNewStory();
  return true;
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
  const [conversationAudios, setConversationAudios] = useState<DailyStoryCachedAudio[]>([]);
  const [conversationAudiosLoading, setConversationAudiosLoading] = useState(true);
  const stateRef = useRef(state);
  const aliveRef = useRef(true);
  const ownerIdRef = useRef(createId("tab"));
  const leaseClaimTokenRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const coordinatorRef = useRef(new DailyStoryCoordinator());
  const retryRef = useRef<(() => void) | null>(null);
  const reviewInFlightRef = useRef(false);
  const transcribeInFlightRef = useRef<Promise<DailyStoryTranscribeResult> | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const audioOutboxAttemptRef = useRef<string | null>(null);
  const audioOutboxUploadingRef = useRef<AudioOutboxUploadingAttempt | null>(null);
  const ttsPlaybackRef = useRef<TransientTtsPlayback | null>(null);
  const pendingWritesRef = useRef<Set<Promise<unknown>>>(new Set());
  const persistenceSignatureRef = useRef<string | null>(null);
  const { setBusy } = usePwa();
  const setCoordinatorCanEdit = useCallback((value: boolean) => {
    coordinatorRef.current.setCanEdit(value);
    setCanEdit(value);
  }, []);
  const releaseTtsPlayback = useCallback(() => {
    const playback = ttsPlaybackRef.current;
    ttsPlaybackRef.current = null;
    releaseTransientTtsPlayback(playback);
  }, []);
  const invalidateCurrent = useCallback(() => {
    coordinatorRef.current.invalidate();
    abortRef.current?.abort();
  }, []);
  const isOperationCurrent = useCallback((token: OperationToken) => {
    return coordinatorRef.current.isOperationCurrent(token);
  }, []);

  const refreshCachedAudio = useCallback(async () => {
    if (!aliveRef.current || !coordinatorRef.current.isPageActive()) return;
    const refreshSequence = coordinatorRef.current.beginAudioRefresh();
    const refreshGeneration = coordinatorRef.current.generation();
    const isRefreshCurrent = () =>
      aliveRef.current &&
      coordinatorRef.current.isAudioRefreshCurrent(refreshSequence) &&
      coordinatorRef.current.generation() === refreshGeneration;
    setConversationAudiosLoading(true);
    try {
      const items = await listDailyStoryAudio({ conversationId });
      if (!isRefreshCurrent()) return;
      const audio = splitDailyStoryAudio(items);
      setCachedAudio(audio.cachedAudio);
      setConversationAudios(audio.conversationAudios);
    } catch {
      // Cache inspection must never block the conversation UI.
    } finally {
      if (isRefreshCurrent()) setConversationAudiosLoading(false);
    }
  }, [conversationId]);

  const rollbackUploadingAudio = useCallback(
    async (attempt: AudioOutboxUploadingAttempt | null = audioOutboxUploadingRef.current) => {
      if (!attempt) return;
      try {
        await updateDailyStoryAudio(attempt.clientAttemptId, {
          status: "queued",
          error: null,
          expectedUpdatedAt: attempt.updatedAt,
        });
      } catch {
        // Outbox recovery is best effort and must not block page lifecycle work.
      } finally {
        if (audioOutboxUploadingRef.current === attempt) {
          audioOutboxUploadingRef.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    void refreshCachedAudio();
  }, [refreshCachedAudio]);

  useEffect(() => {
    stateRef.current = state;
    setBusy(isDailyBusy(state.phase), "daily-story");
  }, [setBusy, state]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    coordinator.activate();
    void refreshCachedAudio();
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      coordinator.deactivate();
      abortRef.current?.abort();
      transcribeInFlightRef.current = null;
      void rollbackUploadingAudio();
      releaseTtsPlayback();
      setBusy(false, "daily-story");
    };
  }, [releaseTtsPlayback, rollbackUploadingAudio, setBusy]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    coordinator.activate();
    let alive = true;
    let leaseActive = false;
    let renewSequence = 0;
    let leaseRetryTimer: number | undefined;
    const owner = ownerIdRef.current;
    const clearLeaseRetry = () => {
      if (leaseRetryTimer === undefined) return;
      window.clearTimeout(leaseRetryTimer);
      leaseRetryTimer = undefined;
    };
    const load = async (claimLease: boolean) => {
      const loadToken = coordinatorRef.current.beginLoad(claimLease);
      coordinatorRef.current.beginWrite();
      invalidateCurrent();
      clearLeaseRetry();
      const scheduleLeaseRetry = () => {
        if (
          leaseRetryTimer !== undefined ||
          !alive ||
          !coordinatorRef.current.isLoadCurrent(loadToken) ||
          !coordinatorRef.current.isPageActive()
        )
          return;
        leaseRetryTimer = window.setTimeout(() => {
          leaseRetryTimer = undefined;
          if (
            !alive ||
            !coordinatorRef.current.isLoadCurrent(loadToken) ||
            !coordinatorRef.current.isPageActive()
          )
            return;
          void load(true);
        }, LEASE_RETRY_DELAY_MS);
      };
      let loadedLeaseToken: string | null = null;
      const releaseLoadedLease = () => {
        if (!loadedLeaseToken) return;
        const token = loadedLeaseToken;
        loadedLeaseToken = null;
        if (leaseClaimTokenRef.current === token) {
          leaseActive = false;
          leaseClaimTokenRef.current = null;
          setCoordinatorCanEdit(false);
        }
        void releaseStoryLeaseToken(conversationId, owner, token);
      };
      const isLoadCurrent = () => alive && coordinatorRef.current.isLoadCurrent(loadToken);
      try {
        await ensureDailyStorage();
        if (loadToken.claimLease) {
          // Claim before the session read. Otherwise an obsolete load can
          // arrive late and overwrite a newer tab/page-show claim.
          if (!alive || !coordinatorRef.current.isLoadCurrent(loadToken)) return;
          loadedLeaseToken = await claimStoryLeaseToken(conversationId, owner, loadToken.sequence);
          if (!isLoadCurrent()) {
            releaseLoadedLease();
            return;
          }
          leaseActive = loadedLeaseToken !== null;
          leaseClaimTokenRef.current = loadedLeaseToken;
          setCoordinatorCanEdit(leaseActive);
          if (!leaseActive) scheduleLeaseRetry();
        }
        const session = await readStorySession(conversationId);
        if (!isLoadCurrent()) {
          releaseLoadedLease();
          return;
        }
        if (!session && !allowCompose) {
          releaseLoadedLease();
          setCoordinatorCanEdit(false);
          setConversationMissing(true);
          setStorageError(null);
          persistenceSignatureRef.current = null;
          dispatch({
            type: "ready",
            session: null,
            settingsRevision: coordinatorRef.current.settingsRevision,
          });
          return;
        }
        setConversationMissing(false);
        const settingsReadSequence = coordinatorRef.current.beginSettingsRead();
        const settings = await readProviderSettings();
        if (!isLoadCurrent()) {
          releaseLoadedLease();
          return;
        }
        if (
          coordinatorRef.current.isSettingsReadCurrent(settingsReadSequence) &&
          settings.revision >= coordinatorRef.current.settingsRevision
        ) {
          coordinatorRef.current.setSettingsRevision(settings.revision);
          setCapabilities({ chat: !!settings.chat, asr: !!settings.asr, tts: !!settings.tts });
        }
        persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
        setStorageError(null);
        dispatch({
          type: "ready",
          session,
          settingsRevision: Math.max(settings.revision, coordinatorRef.current.settingsRevision),
        });
        if (!leaseActive) scheduleLeaseRetry();
      } catch (error) {
        if (!isLoadCurrent()) {
          releaseLoadedLease();
          return;
        }
        setStorageError(message(error));
        dispatch({
          type: "ready",
          session: null,
          settingsRevision: coordinatorRef.current.settingsRevision,
        });
      }
    };
    void load(true);
    const onPageHide = () => {
      if (stateRef.current.phase === "reviewing") {
        dispatch({ type: "reviewCancelled" });
      }
      coordinatorRef.current.deactivate();
      renewSequence += 1;
      clearLeaseRetry();
      const token = leaseClaimTokenRef.current;
      leaseActive = false;
      leaseClaimTokenRef.current = null;
      setCoordinatorCanEdit(false);
      if (token) void releaseStoryLeaseToken(conversationId, owner, token);
      abortRef.current?.abort();
      transcribeInFlightRef.current = null;
      void rollbackUploadingAudio();
      releaseTtsPlayback();
    };
    const onPageShow = () => {
      coordinatorRef.current.activate();
      renewSequence += 1;
      void load(true);
      void refreshCachedAudio();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    const renew = window.setInterval(() => {
      if (!leaseActive || !coordinatorRef.current.isPageActive()) return;
      const sequence = ++renewSequence;
      const generation = coordinatorRef.current.generation();
      const expectedClaimToken = leaseClaimTokenRef.current;
      if (!expectedClaimToken) return;
      void renewStoryLeaseToken(conversationId, owner, expectedClaimToken)
        .then((renewed) => {
          if (
            alive &&
            sequence === renewSequence &&
            coordinatorRef.current.isPageActive() &&
            coordinatorRef.current.generation() === generation
          ) {
            setCoordinatorCanEdit(renewed);
            leaseActive = renewed;
            if (!renewed) {
              leaseClaimTokenRef.current = null;
              coordinatorRef.current.beginWrite();
              invalidateCurrent();
            }
          }
        })
        .catch((error: unknown) => {
          if (
            alive &&
            sequence === renewSequence &&
            coordinatorRef.current.isPageActive() &&
            coordinatorRef.current.generation() === generation
          )
            setStorageError(message(error));
        });
    }, 8_000);
    const unsubscribe = subscribeDailyStorage((event) => {
      if (event.kind === "settings") {
        const settingsReadSequence = coordinatorRef.current.beginSettingsRead();
        const settingsGeneration = coordinatorRef.current.generation();
        void readProviderSettings()
          .then((settings) => {
            if (
              !alive ||
              !coordinatorRef.current.isSettingsReadCurrent(settingsReadSequence) ||
              coordinatorRef.current.generation() !== settingsGeneration ||
              settings.revision <= coordinatorRef.current.settingsRevision
            )
              return;
            setCapabilities({ chat: !!settings.chat, asr: !!settings.asr, tts: !!settings.tts });
            const hadActiveOperation = stateRef.current.operation !== null;
            coordinatorRef.current.setSettingsRevision(settings.revision);
            if (hadActiveOperation) {
              invalidateCurrent();
              setStorageError("API 配置已在另一标签页更新。当前操作已取消，请按新配置重试。");
            }
            dispatch({ type: "settingsRevisionChanged", settingsRevision: settings.revision });
          })
          .catch(
            (error: unknown) =>
              alive &&
              coordinatorRef.current.isSettingsReadCurrent(settingsReadSequence) &&
              coordinatorRef.current.generation() === settingsGeneration &&
              setStorageError(message(error)),
          );
        return;
      }
      if (event.kind === "lease") {
        if (event.conversationId !== conversationId || event.ownerId === owner) return;
        renewSequence += 1;
        leaseActive = false;
        leaseClaimTokenRef.current = null;
        setCoordinatorCanEdit(false);
        invalidateCurrent();
        void load(false);
        return;
      }
      if (event.kind === "leaseReleased") {
        if (
          event.conversationId !== conversationId ||
          leaseActive ||
          !coordinatorRef.current.isPageActive()
        )
          return;
        void load(true);
        return;
      }
      if (event.kind !== "session" || event.conversationId !== conversationId) return;
      // Metadata-only signal. Reload from IndexedDB; never trust cross-tab payloads.
      invalidateCurrent();
      void load(false);
    });
    return () => {
      alive = false;
      coordinator.deactivate();
      renewSequence += 1;
      clearLeaseRetry();
      transcribeInFlightRef.current = null;
      window.clearInterval(renew);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      unsubscribe();
      const token = leaseClaimTokenRef.current;
      leaseClaimTokenRef.current = null;
      if (token) void releaseStoryLeaseToken(conversationId, owner, token);
    };
  }, [
    allowCompose,
    conversationId,
    invalidateCurrent,
    refreshCachedAudio,
    releaseTtsPlayback,
    rollbackUploadingAudio,
    setCoordinatorCanEdit,
  ]);

  useEffect(() => {
    const snapshot = snapshotDailyState(state);
    const claimToken = getLeaseProtectedMutationToken(
      coordinatorRef.current.canEdit,
      coordinatorRef.current.isPageActive(),
      leaseClaimTokenRef.current,
    );
    if (!snapshot || !claimToken) return;
    const signature = persistenceSignature({ ...snapshot, revision: state.revision });
    if (signature === persistenceSignatureRef.current) return;
    const writeSequence = coordinatorRef.current.beginWrite();
    const isWriteSequenceCurrent = () =>
      coordinatorRef.current.isWriteSequenceCurrent(writeSequence);
    const isWriteCurrent = () => coordinatorRef.current.isWriteCurrent(writeSequence);
    persistenceSignatureRef.current = signature;
    const writePromise = writeStorySession(
      conversationId,
      snapshot,
      state.revision,
      ownerIdRef.current,
      claimToken,
    );
    pendingWritesRef.current.add(writePromise);
    void writePromise
      .then((session) => {
        if (!isWriteCurrent()) return;
        persistenceSignatureRef.current = persistenceSignature(session);
        setStorageError(null);
        dispatch({ type: "persisted", session });
      })
      .catch((error: unknown) => {
        if (!isWriteCurrent()) return;
        if (error instanceof SessionConflictError) {
          setCoordinatorCanEdit(false);
          void readStorySession(conversationId)
            .then((session) => {
              if (!isWriteSequenceCurrent()) return;
              persistenceSignatureRef.current = session ? persistenceSignature(session) : null;
              dispatch({
                session,
                settingsRevision: coordinatorRef.current.settingsRevision,
                type: "ready",
              });
            })
            .catch((reloadError: unknown) => {
              if (isWriteSequenceCurrent()) setStorageError(message(reloadError));
            });
        }
        setStorageError(message(error));
      })
      .finally(() => {
        pendingWritesRef.current.delete(writePromise);
      });
  }, [canEdit, conversationId, setCoordinatorCanEdit, state]);

  const guard = useCallback(
    () =>
      coordinatorRef.current.isPageActive() &&
      coordinatorRef.current.canEdit &&
      !isDailyBusy(stateRef.current.phase),
    [],
  );
  const abortCurrent = useCallback(() => {
    invalidateCurrent();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, [invalidateCurrent]);
  const currentSettings = useCallback(async (): Promise<ProviderSettings | null> => {
    const settingsReadSequence = coordinatorRef.current.beginSettingsRead();
    const settingsGeneration = coordinatorRef.current.generation();
    try {
      const settings = await readProviderSettings();
      if (
        !aliveRef.current ||
        !coordinatorRef.current.isSettingsReadCurrent(settingsReadSequence) ||
        coordinatorRef.current.generation() !== settingsGeneration
      )
        return null;
      if (settings.revision > coordinatorRef.current.settingsRevision) {
        coordinatorRef.current.setSettingsRevision(settings.revision);
        dispatch({ type: "settingsRevisionChanged", settingsRevision: settings.revision });
      }
      setStorageError(null);
      return settings;
    } catch (error) {
      if (
        aliveRef.current &&
        coordinatorRef.current.isSettingsReadCurrent(settingsReadSequence) &&
        coordinatorRef.current.generation() === settingsGeneration
      )
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
    let operationToken: OperationToken | undefined;
    try {
      const settings = await currentSettings();
      if (!settings) return;
      if (!coordinatorRef.current.isPageActive() || !coordinatorRef.current.canEdit) return;
      if (!settings.chat) {
        setStorageError("开始聊天前，请先在设置中保存 Chat 配置。");
        return;
      }
      operationId = createId("start");
      operationSettingsRevision = settings.revision;
      const controller = abortCurrent();
      operationToken = coordinatorRef.current.beginOperation(settings.revision);
      if (!operationToken) return;
      dispatch({ type: "startRequest", operationId, settingsRevision: settings.revision, storyZh });
      const result = await startDailyStory({
        storyZh,
        chat: settings.chat,
        signal: controller.signal,
      });
      if (!operationToken || !isOperationCurrent(operationToken)) return;
      dispatch({
        type: "startSuccess",
        operationId,
        settingsRevision: settings.revision,
        ...(result.title ? { title: result.title } : {}),
        opening: { id: result.opening.id, role: "assistant", text: result.opening.text },
      });
    } catch (error) {
      if (isDailyStoryAbortError(error) || !operationToken || !isOperationCurrent(operationToken))
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
  }, [abortCurrent, currentSettings, guard, isOperationCurrent]);

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
          !coordinatorRef.current.isPageActive() ||
          !coordinatorRef.current.canEdit ||
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
        const transcribeGeneration = coordinatorRef.current.generation();
        const isTranscribeCurrent = () =>
          aliveRef.current &&
          coordinatorRef.current.isPageActive() &&
          coordinatorRef.current.canEdit &&
          coordinatorRef.current.generation() === transcribeGeneration;
        let operationId: string | undefined;
        let operationSettingsRevision: number | undefined;
        let transcriptId: string | undefined;
        let operationToken: OperationToken | undefined;
        let uploadingAttempt: AudioOutboxUploadingAttempt | null = null;
        try {
          try {
            if (!isTranscribeCurrent()) return { succeeded: false, clientAttemptId };
            const persisted = await putDailyStoryAudio({
              clientAttemptId,
              conversationId,
              blob: audio,
              mimeType: audio.type || "application/octet-stream",
              durationSec: Math.max(0, durationSec),
              createdAt: Date.now(),
              purpose: readAloud ? "readAloud" : "conversation",
              ...(readAloud && target ? { readAloudTarget: target } : {}),
            });
            if (!isTranscribeCurrent()) return { succeeded: false, clientAttemptId };
            const uploading = await updateDailyStoryAudio(
              clientAttemptId,
              { status: "uploading", error: null },
              { expectedUpdatedAt: persisted.updatedAt },
            );
            if (!uploading) return { succeeded: false, clientAttemptId };
            uploadingAttempt = {
              clientAttemptId: uploading.clientAttemptId,
              updatedAt: uploading.updatedAt,
            };
            audioOutboxUploadingRef.current = uploadingAttempt;
            if (!isTranscribeCurrent()) {
              await rollbackUploadingAudio(uploadingAttempt);
              return { succeeded: false, clientAttemptId };
            }
            await refreshCachedAudio();
          } catch (error) {
            // IndexedDB is a reliability enhancement. If browser storage is
            // unavailable, keep the direct upload path usable.
            if (isTranscribeCurrent())
              setStorageError(`录音未能写入本地缓存，将直接上传：${message(error)}`);
          }
          if (controller.signal.aborted || !isTranscribeCurrent()) {
            await rollbackUploadingAudio(uploadingAttempt);
            return { succeeded: false, clientAttemptId };
          }
          const settings = await currentSettings();
          if (!settings) {
            await rollbackUploadingAudio(uploadingAttempt);
            return { succeeded: false, clientAttemptId };
          }
          if (!isTranscribeCurrent()) {
            await rollbackUploadingAudio(uploadingAttempt);
            return { succeeded: false, clientAttemptId };
          }
          if (!settings.asr) {
            if (uploadingAttempt) {
              await updateDailyStoryAudio(
                clientAttemptId,
                { status: "queued", error: "语音聊天需配置 ASR。" },
                { expectedUpdatedAt: uploadingAttempt.updatedAt },
              ).catch(() => {});
            }
            if (audioOutboxUploadingRef.current === uploadingAttempt) {
              audioOutboxUploadingRef.current = null;
            }
            if (!isTranscribeCurrent()) return { succeeded: false, clientAttemptId };
            await refreshCachedAudio();
            if (!isTranscribeCurrent()) return { succeeded: false, clientAttemptId };
            setStorageError("语音聊天需配置 ASR。可继续使用文字输入（备用，不是语音转写）。");
            if (
              isTranscribeCurrent() &&
              coordinatorRef.current.settingsRevision === settings.revision
            )
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
          operationToken = coordinatorRef.current.beginOperation(settings.revision);
          if (!operationToken) return { succeeded: false, clientAttemptId };
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
            ...(settings.chat ? { chat: settings.chat } : {}),
            storyZh: stateRef.current.storyZh,
            history: stateRef.current.messages,
            directAsr: settings.local?.asrDirect ?? false,
            signal: controller.signal,
          });
          const text = result.normalizedTranscript ?? result.transcript;
          const rawTranscript = result.rawTranscript ?? result.transcript;
          if (!text.trim()) throw new Error("没有识别到语音。请重录后再试。");
          if (!operationToken || !isOperationCurrent(operationToken)) {
            await rollbackUploadingAudio(uploadingAttempt);
            return { succeeded: false, clientAttemptId };
          }
          // Keep the successful recording in the seven-day outbox as well. This
          // lets us inspect/retry the exact bytes when an upstream ASR model
          // returns a clearly wrong language instead of deleting the evidence.
          if (uploadingAttempt) {
            const completed = await updateDailyStoryAudio(
              clientAttemptId,
              { status: "completed", error: null },
              { expectedUpdatedAt: uploadingAttempt.updatedAt },
            ).catch(() => undefined);
            if (!completed) return { succeeded: false, clientAttemptId };
          }
          if (audioOutboxUploadingRef.current === uploadingAttempt) {
            audioOutboxUploadingRef.current = null;
          }
          if (!operationToken || !isOperationCurrent(operationToken)) {
            return { succeeded: false, clientAttemptId };
          }
          await refreshCachedAudio();
          audioOutboxAttemptRef.current = null;
          if (!operationToken || !isOperationCurrent(operationToken)) {
            return { succeeded: false, clientAttemptId };
          }
          if (!isTranscribeCurrent()) return { succeeded: false, clientAttemptId };
          dispatch({
            type: "transcribeSuccess",
            operationId,
            settingsRevision: settings.revision,
            readAloud,
            transcript: { id: transcriptId, source: "asr", text, rawText: rawTranscript },
          });
          return {
            succeeded: true,
            clientAttemptId,
            transcript: text,
            transcriptId,
            ...(rawTranscript !== text ? { rawTranscript } : {}),
          };
        } catch (error) {
          if (
            isDailyStoryAbortError(error) ||
            !operationToken ||
            !isOperationCurrent(operationToken)
          ) {
            await rollbackUploadingAudio(uploadingAttempt);
            return { succeeded: false, clientAttemptId };
          }
          const errorMessage = message(error);
          if (uploadingAttempt) {
            const failed = await updateDailyStoryAudio(
              clientAttemptId,
              { status: "failed", error: errorMessage },
              { expectedUpdatedAt: uploadingAttempt.updatedAt },
            ).catch(() => undefined);
            if (!failed) return { succeeded: false, clientAttemptId };
          }
          if (audioOutboxUploadingRef.current === uploadingAttempt) {
            audioOutboxUploadingRef.current = null;
          }
          if (!isOperationCurrent(operationToken)) {
            return { succeeded: false, clientAttemptId };
          }
          await refreshCachedAudio();
          if (!isOperationCurrent(operationToken)) {
            return { succeeded: false, clientAttemptId };
          }
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
    [
      abortCurrent,
      conversationId,
      currentSettings,
      isOperationCurrent,
      refreshCachedAudio,
      rollbackUploadingAudio,
    ],
  );

  const retryCachedAudio = useCallback(() => {
    const attemptId = cachedAudio?.clientAttemptId;
    if (!coordinatorRef.current.canEdit || !attemptId) return;
    const retryGeneration = coordinatorRef.current.generation();
    void getDailyStoryAudio(attemptId)
      .then((item) => {
        if (
          !coordinatorRef.current.isPageActive() ||
          retryGeneration !== coordinatorRef.current.generation()
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
          coordinatorRef.current.isPageActive() &&
          retryGeneration === coordinatorRef.current.generation()
        )
          setStorageError(message(error));
      });
  }, [cachedAudio, transcribe]);

  const send = useCallback(
    async (source: TurnSource, rawText: string): Promise<boolean> => {
      if (
        (!guard() && stateRef.current.phase !== "error") ||
        !coordinatorRef.current.isPageActive()
      )
        return false;
      const text = rawText.trim();
      if (!text) return false;
      if (text.length > DAILY_STORY_TURN_MAX) {
        setStorageError(`文字输入最多 ${DAILY_STORY_TURN_MAX} 个字符。请缩短后再发送。`);
        return false;
      }
      const pending = stateRef.current.pendingTranscript;
      const turn = {
        id: pending?.id ?? createId(source),
        source,
        text,
        ...(source === "asr" && pending?.rawText ? { rawText: pending.rawText } : {}),
      };
      let operationId: string | undefined;
      let operationSettingsRevision: number | undefined;
      let operationToken: OperationToken | undefined;
      try {
        const settings = await currentSettings();
        if (!settings) return false;
        if (!coordinatorRef.current.isPageActive() || !coordinatorRef.current.canEdit) return false;
        if (!settings.chat) {
          setStorageError("请先在设置中保存 Chat 配置。");
          return false;
        }
        operationId = createId("reply");
        operationSettingsRevision = settings.revision;
        const controller = abortCurrent();
        operationToken = coordinatorRef.current.beginOperation(settings.revision);
        if (!operationToken) return false;
        dispatch({ type: "sendRequest", operationId, settingsRevision: settings.revision, turn });
        const result = await replyDailyStory({
          storyZh: stateRef.current.storyZh,
          history: stateRef.current.messages,
          turn,
          chat: settings.chat,
          signal: controller.signal,
        });
        if (!operationToken || !isOperationCurrent(operationToken)) return false;
        dispatch({
          type: "replySuccess",
          operationId,
          settingsRevision: settings.revision,
          turn,
          assistant: { id: createId("ai"), role: "assistant", text: result.reply },
        });
        return true;
      } catch (error) {
        if (isDailyStoryAbortError(error) || !operationToken || !isOperationCurrent(operationToken))
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
    [abortCurrent, currentSettings, guard, isOperationCurrent],
  );

  const finish = useCallback(async () => {
    if (!guard()) return;
    const current = stateRef.current;
    if (!current.messages.some((item) => item.role === "user" && item.text.trim())) return;
    if (reviewInFlightRef.current) return;
    reviewInFlightRef.current = true;
    let operationId: string | undefined;
    let operationSettingsRevision: number | undefined;
    let operationToken: OperationToken | undefined;
    try {
      const settings = await currentSettings();
      if (!settings) return;
      if (!coordinatorRef.current.isPageActive() || !coordinatorRef.current.canEdit) return;
      if (!settings.chat) return;
      operationId = createId("review");
      operationSettingsRevision = settings.revision;
      const controller = abortCurrent();
      operationToken = coordinatorRef.current.beginOperation(settings.revision);
      if (!operationToken) return;
      dispatch({ type: "reviewRequest", operationId, settingsRevision: settings.revision });
      const review = await reviewDailyStory({
        storyZh: current.storyZh,
        history: current.messages,
        chat: settings.chat,
        signal: controller.signal,
      });
      if (!operationToken || !isOperationCurrent(operationToken)) return;
      dispatch({ type: "reviewSuccess", operationId, settingsRevision: settings.revision, review });
    } catch (error) {
      if (isDailyStoryAbortError(error) || !operationToken || !isOperationCurrent(operationToken))
        return;
      dispatch({
        type: "failure",
        message: message(error),
        resumePhase: current.review ? "review" : "chatting",
        kind: "review",
        ...(operationId && operationSettingsRevision !== undefined
          ? { operationId, settingsRevision: operationSettingsRevision }
          : {}),
      });
      retryRef.current = () => void finish();
    } finally {
      reviewInFlightRef.current = false;
    }
  }, [abortCurrent, currentSettings, guard, isOperationCurrent]);

  const cancelReview = useCallback(() => {
    if (stateRef.current.phase !== "reviewing") return;
    invalidateCurrent();
    dispatch({ type: "reviewCancelled" });
  }, [invalidateCurrent]);

  const checkProvider = useCallback(
    async (
      capability: DailyCapability,
      provider: NonNullable<ProviderSettings[DailyCapability]>,
    ) => {
      let providerCheckToken: OperationToken | undefined;
      try {
        const settings = await currentSettings();
        if (!settings || !coordinatorRef.current.isPageActive() || !coordinatorRef.current.canEdit)
          return false;
        providerCheckToken = coordinatorRef.current.beginProviderCheck(settings.revision);
        const isProviderCheckCurrent = () =>
          coordinatorRef.current.isProviderCheckCurrent(providerCheckToken!);
        if (!isProviderCheckCurrent()) return false;
        setConnection((current) =>
          isProviderCheckCurrent() ? { ...current, [capability]: "checking" } : current,
        );
        await checkDailyProvider({
          capability,
          provider,
          ...(capability === "asr" ? { directAsr: settings.local?.asrDirect ?? false } : {}),
        });
        if (!isProviderCheckCurrent()) return false;
        setConnection((current) =>
          isProviderCheckCurrent() ? { ...current, [capability]: "connected" } : current,
        );
        return true;
      } catch {
        // A superseded check must not overwrite the result of the latest check.
        // The provider lane is independent, so chat/TTS operations remain intact.
        if (
          providerCheckToken &&
          coordinatorRef.current.isProviderCheckCurrent(providerCheckToken)
        ) {
          setConnection((current) =>
            coordinatorRef.current.isProviderCheckCurrent(providerCheckToken!)
              ? { ...current, [capability]: "failed" }
              : current,
          );
        }
        return false;
      }
    },
    [currentSettings],
  );

  const playTts = useCallback(
    async (text: string) => {
      let operationToken: OperationToken | undefined;
      try {
        const settings = await currentSettings();
        if (!settings) return;
        if (!coordinatorRef.current.isPageActive() || !coordinatorRef.current.canEdit) return;
        if (!settings.tts) {
          setStorageError("未配置 TTS，无法朗读。");
          return;
        }
        releaseTtsPlayback();
        const controller = abortCurrent();
        operationToken = coordinatorRef.current.beginOperation(settings.revision);
        if (!operationToken) return;
        const blob = await synthesizeDailyStory({
          text,
          tts: settings.tts,
          signal: controller.signal,
        });
        if (!operationToken || !isOperationCurrent(operationToken)) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const playback = { audio, url };
        if (!isOperationCurrent(operationToken)) {
          releaseTransientTtsPlayback(playback);
          return;
        }
        ttsPlaybackRef.current = playback;
        const revoke = () => {
          if (ttsPlaybackRef.current === playback) ttsPlaybackRef.current = null;
          releaseTransientTtsPlayback(playback);
        };
        audio.addEventListener("ended", revoke, { once: true });
        audio.addEventListener("error", revoke, { once: true });
        try {
          await audio.play();
          if (!operationToken || !isOperationCurrent(operationToken)) revoke();
        } catch (error) {
          revoke();
          throw error;
        }
      } catch (error) {
        if (!isDailyStoryAbortError(error) && operationToken && isOperationCurrent(operationToken))
          setStorageError(message(error));
      }
    },
    [abortCurrent, currentSettings, isOperationCurrent, releaseTtsPlayback],
  );

  const retry = useCallback(() => retryRef.current?.(), []);
  const beginRecording = useCallback(() => {
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    audioOutboxUploadingRef.current = null;
    dispatch({ type: "recording" });
  }, []);
  const recordingDraftReady = useCallback((readAloud = false) => {
    dispatch({ type: "recordingDraftReady", readAloud });
  }, []);
  const continueRecording = useCallback((readAloud = false) => {
    dispatch({ type: "continueRecording", readAloud });
  }, []);
  const cancelRecording = useCallback(() => dispatch({ type: "recordingCancelled" }), []);
  const saveAsrDraft = useCallback((rawText: string) => {
    if (!coordinatorRef.current.canEdit) return false;
    const text = trimBounded(rawText, DAILY_STORY_TURN_MAX);
    if (!text || stateRef.current.pendingTranscript?.source !== "asr") return false;
    dispatch({ type: "editTranscript", text });
    return true;
  }, []);
  const beginReadAloud = useCallback((target: string) => {
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    audioOutboxUploadingRef.current = null;
    dispatch({ type: "readAloudRecording", target });
  }, []);
  const newStory = useCallback(async () => {
    if (
      !getLeaseProtectedMutationToken(
        coordinatorRef.current.canEdit,
        coordinatorRef.current.isPageActive(),
        leaseClaimTokenRef.current,
      )
    )
      return;
    if (stateRef.current.messages.length && !window.confirm("开始新故事会放弃当前对话。继续吗？"))
      return;
    invalidateCurrent();
    coordinatorRef.current.beginWrite();
    const operationToken = coordinatorRef.current.beginOperation(
      coordinatorRef.current.settingsRevision,
    );
    if (!operationToken || !coordinatorRef.current.canEdit || !isOperationCurrent(operationToken))
      return;
    blobRef.current = null;
    audioOutboxAttemptRef.current = null;
    audioOutboxUploadingRef.current = null;
    await Promise.all([...pendingWritesRef.current].map((write) => write.catch(() => {})));
    if (!coordinatorRef.current.canEdit || !isOperationCurrent(operationToken)) return;
    try {
      const latest = await readStorySession(conversationId);
      if (!coordinatorRef.current.canEdit || !isOperationCurrent(operationToken)) return;
      const claimToken = getLeaseProtectedMutationToken(
        coordinatorRef.current.canEdit,
        coordinatorRef.current.isPageActive(),
        leaseClaimTokenRef.current,
      );
      if (!claimToken) return;
      await deleteStorySession(
        conversationId,
        latest?.revision ?? stateRef.current.revision,
        ownerIdRef.current,
        claimToken,
      );
      if (!coordinatorRef.current.canEdit || !isOperationCurrent(operationToken)) return;
      persistenceSignatureRef.current = null;
    } catch (error) {
      if (!coordinatorRef.current.canEdit || !isOperationCurrent(operationToken)) return;
      const recovered = await recoverCommittedStoryDeletion(conversationId, error, {
        readSession: readStorySession,
        isCurrent: () => coordinatorRef.current.canEdit && isOperationCurrent(operationToken),
        clearPersistenceSignature: () => {
          persistenceSignatureRef.current = null;
        },
        setStorageError,
        dispatchNewStory: () => dispatch({ type: "newStory" }),
      });
      if (recovered) return;
      if (error instanceof StorySidecarPersistenceError) {
        setStorageError(message(error));
        return;
      }
      try {
        // Session deletion commits before review-sidecar cleanup. If the
        // second physical store fails, do not strand the UI on the old story.
        const remaining = await readStorySession(conversationId);
        if (remaining === null) {
          persistenceSignatureRef.current = null;
          dispatch({ type: "newStory" });
          return;
        }
      } catch {
        // Preserve the original storage error when the verification read fails.
      }
      setStorageError(message(error));
      return;
    }
    dispatch({ type: "newStory" });
  }, [conversationId, invalidateCurrent, isOperationCurrent]);

  return {
    state,
    canEdit,
    storageError,
    connection,
    capabilities,
    conversationMissing,
    cachedAudio,
    conversationAudios,
    conversationAudiosLoading,
    setDraft: (draft: string) => dispatch({ type: "draft", draft }),
    start,
    beginRecording,
    recordingDraftReady,
    continueRecording,
    transcribe,
    cancelRecording,
    saveAsrDraft,
    retryCachedAudio,
    sendAsr: (text: string) => send("asr", text),
    sendTyped: (text: string) => send("typed", text),
    reRecord: () => dispatch({ type: "reRecord" }),
    finish,
    cancelReview,
    beginReadAloud,
    resetReadAloud: () => dispatch({ type: "resetReadAloud" }),
    playTts: (text: string) => void playTts(text),
    retry,
    newStory,
    checkProvider,
  };
}
