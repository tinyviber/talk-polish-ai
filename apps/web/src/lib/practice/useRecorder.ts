import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMode } from "./mode";
import { normalizeRecordedAudio } from "./audio-format";

const MICROPHONE_REQUEST_TIMEOUT_MS = 10_000;
const INPUT_DEVICE_STORAGE_KEY = "kotoba-microphone-device-id";

function savedInputDeviceId() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(INPUT_DEVICE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveInputDeviceId(deviceId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (deviceId) window.localStorage.setItem(INPUT_DEVICE_STORAGE_KEY, deviceId);
    else window.localStorage.removeItem(INPUT_DEVICE_STORAGE_KEY);
  } catch {
    // Persisting the preference is optional.
  }
}

async function microphonePermissionState(): Promise<PermissionState | "unknown"> {
  if (!navigator.permissions?.query) return "unknown";
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return "unknown";
  }
}

export type RecorderStatus = "idle" | "requesting" | "recording" | "recorded" | "denied";
export type RecorderInputDevice = { deviceId: string; label: string };
export type MicrophoneTestStatus = "idle" | "requesting" | "active" | "denied";
export type RecorderDraft = { blob: Blob; durationSec: number; mimeType: string; reason: string };
export type RecorderState = {
  status: RecorderStatus;
  seconds: number;
  level: number;
  audioUrl: string | null;
  audioBlob: Blob | null;
  mocked: boolean;
  error: string | null;
};

type Options = {
  mode?: AppMode;
  onInterruptedRecording?: (draft: RecorderDraft) => void | Promise<void>;
};

type WakeLockSentinelLike = {
  released?: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

/** MediaRecorder wrapper with mobile interruption-safe finalization. */
export function useRecorder({ mode = "demo", onInterruptedRecording }: Options = {}) {
  /** iOS emits short mute/unmute pairs; wait before treating one as fatal. */
  const MUTE_GRACE_MS = 1500;

  const [state, setState] = useState<RecorderState>({
    status: "idle",
    seconds: 0,
    level: 0,
    audioUrl: null,
    audioBlob: null,
    mocked: false,
    error: null,
  });
  const [inputDevices, setInputDevices] = useState<RecorderInputDevice[]>([]);
  const initialInputDeviceId = savedInputDeviceId();
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(
    initialInputDeviceId,
  );
  const [microphoneTestStatus, setMicrophoneTestStatus] = useState<MicrophoneTestStatus>("idle");
  const [microphoneTestLevel, setMicrophoneTestLevel] = useState(0);
  const stateRef = useRef(state);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const stopRef = useRef<(reason: string, saveDraft: boolean) => Promise<void>>(async () => {});
  const stoppingRef = useRef(false);
  const trackCleanupRef = useRef<(() => void)[]>([]);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const selectedInputDeviceIdRef = useRef<string | null>(initialInputDeviceId);
  const microphoneTestStreamRef = useRef<MediaStream | null>(null);
  const microphoneTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const microphoneTestContextRef = useRef<AudioContext | null>(null);
  const microphoneTestRafRef = useRef<number | null>(null);
  const startRequestRef = useRef(0);
  const startPendingRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const update = useCallback(
    (next: RecorderState | ((current: RecorderState) => RecorderState)) => {
      setState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        stateRef.current = value;
        return value;
      });
    },
    [],
  );
  const refreshInputDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((device) => device.kind === "audioinput")
        .map((device) => ({ deviceId: device.deviceId, label: device.label }));
      setInputDevices(inputs);
      setSelectedInputDeviceId((current) => {
        // Before permission is granted, browsers may return empty/masked IDs.
        // Keep the saved choice until a real device list is available.
        if (
          !current ||
          inputs.length === 0 ||
          inputs.some((device) => device.deviceId === current) ||
          inputs.some((device) => !device.deviceId)
        )
          return current;
        selectedInputDeviceIdRef.current = null;
        saveInputDeviceId(null);
        return null;
      });
    } catch {
      // Device enumeration is optional; getUserMedia remains usable without it.
    }
  }, []);
  const selectInputDevice = useCallback((deviceId: string) => {
    const next = deviceId || null;
    selectedInputDeviceIdRef.current = next;
    setSelectedInputDeviceId(next);
    saveInputDeviceId(next);
  }, []);
  const stopMicrophoneTest = useCallback(() => {
    if (microphoneTestRafRef.current !== null) {
      cancelAnimationFrame(microphoneTestRafRef.current);
      microphoneTestRafRef.current = null;
    }
    microphoneTestStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneTestStreamRef.current = null;
    microphoneTestAnalyserRef.current = null;
    if (microphoneTestContextRef.current) {
      void microphoneTestContextRef.current.close().catch(() => {});
      microphoneTestContextRef.current = null;
    }
    setMicrophoneTestLevel(0);
    setMicrophoneTestStatus("idle");
  }, []);
  const startMicrophoneTest = useCallback(async () => {
    stopMicrophoneTest();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneTestStatus("denied");
      return;
    }
    setMicrophoneTestStatus("requesting");
    try {
      const selectedDeviceId = selectedInputDeviceIdRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
        },
      });
      microphoneTestStreamRef.current = stream;
      setMicrophoneTestStatus("active");
      const AudioCtor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      const context = new AudioCtor();
      microphoneTestContextRef.current = context;
      await context.resume().catch(() => {});
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      microphoneTestAnalyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (microphoneTestAnalyserRef.current !== analyser) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const sample = (value - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / data.length);
        setMicrophoneTestLevel((current) => current * 0.65 + Math.min(1, rms * 4) * 0.35);
        microphoneTestRafRef.current = requestAnimationFrame(tick);
      };
      microphoneTestRafRef.current = requestAnimationFrame(tick);
    } catch {
      stopMicrophoneTest();
      setMicrophoneTestStatus("denied");
    }
  }, [stopMicrophoneTest]);
  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);
  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    // Blob construction copies the recording payload. Drop chunk references
    // immediately so a submitted/reset take cannot pin its full audio buffer.
    chunksRef.current = [];
    trackCleanupRef.current.splice(0).forEach((dispose) => dispose());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    if (ctxRef.current) {
      ctxRef.current.onstatechange = null;
      void ctxRef.current.close().catch(() => {});
    }
    ctxRef.current = null;
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    startedAtRef.current = null;
  }, []);

  useEffect(
    () => () => {
      mountedRef.current = false;
      stopMicrophoneTest();
      // Route changes do not reliably emit pagehide. Give MediaRecorder one
      // last chance to emit its final chunk before tearing down the stream.
      if (recorderRef.current) void stopRef.current("component-unmount", true);
      else {
        startRequestRef.current += 1;
        startPendingRef.current = null;
        cleanup();
      }
      revokeAudioUrl();
    },
    [cleanup, revokeAudioUrl, stopMicrophoneTest],
  );

  useEffect(() => {
    void refreshInputDevices();
    const onDeviceChange = () => void refreshInputDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
  }, [refreshInputDevices]);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    startedAtRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (!startedAt) return;
      update((current) => ({ ...current, seconds: Math.floor((Date.now() - startedAt) / 1000) }));
    }, 250);
  }, [update]);
  const startMockLevels = useCallback(() => {
    let tickCount = 0;
    const tick = () => {
      tickCount += 1;
      update((current) =>
        current.status === "recording"
          ? {
              ...current,
              level:
                0.35 +
                0.3 * Math.abs(Math.sin(tickCount / 9)) +
                0.15 * Math.abs(Math.sin(tickCount / 3)),
            }
          : current,
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [update]);

  const requestWakeLock = useCallback(async () => {
    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    if (!wakeLock || (wakeLockRef.current && !wakeLockRef.current.released)) return;
    try {
      const lock = await wakeLock.request("screen");
      wakeLockRef.current = lock;
      lock.addEventListener?.("release", () => {
        if (wakeLockRef.current === lock) wakeLockRef.current = null;
      });
    } catch {
      // Screen Wake Lock is optional and inconsistent across iOS versions.
    }
  }, []);

  const stop = useCallback(
    async (reason = "manual", saveDraft = false) => {
      if (stoppingRef.current) return;
      stoppingRef.current = true;
      const recorder = recorderRef.current;
      // Do not turn an idle/requesting recorder into a fake completed take
      // when iOS sends a lifecycle event during the permission prompt.
      if (!recorder && startPendingRef.current !== null) {
        startRequestRef.current += 1;
        startPendingRef.current = null;
        cleanup();
        update((current) => ({
          ...current,
          status: "denied",
          seconds: 0,
          level: 0,
          audioUrl: null,
          audioBlob: null,
          mocked: false,
          error:
            "麦克风请求已取消。若没有弹出权限提示，请点击地址栏左侧的权限图标，允许此网站使用麦克风后重试。",
        }));
        stoppingRef.current = false;
        return;
      }
      if (!recorder && stateRef.current.status !== "recording") {
        stoppingRef.current = false;
        return;
      }
      const startedAt = startedAtRef.current;
      const seconds = Math.max(
        1,
        Math.floor((startedAt ? Date.now() - startedAt : stateRef.current.seconds * 1000) / 1000),
      );
      if (recorder) {
        const stopped = new Promise<void>((resolve) => {
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (timeout) clearTimeout(timeout);
            resolve();
          };
          if (recorder.state !== "inactive") {
            recorder.addEventListener("stop", finish, { once: true });
            // A broken recorder must not hold the UI forever, but MediaRecorder
            // errors do not themselves mean the final chunk is ready.
            timeout = setTimeout(finish, 1_500);
            try {
              // Ask for the current timeslice before stop. Some mobile
              // implementations deliver this final data event asynchronously.
              recorder.requestData();
            } catch {
              // requestData is optional after a MediaRecorder error.
            }
            try {
              recorder.stop();
            } catch {
              finish();
            }
          } else {
            // Let a queued dataavailable event run before composing the Blob.
            timeout = setTimeout(finish, 0);
          }
        });
        await stopped;
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const hasAudio = blob.size > 0;
        const normalized = hasAudio ? await normalizeRecordedAudio(blob) : { blob, mimeType };
        const uploadBlob = normalized.blob;
        const uploadMimeType = normalized.mimeType;
        const url = uploadBlob.size > 0 ? URL.createObjectURL(uploadBlob) : null;
        revokeAudioUrl();
        audioUrlRef.current = url;
        recorderRef.current = null;
        cleanup();
        update((current) => ({
          ...current,
          // The analyser powers the input meter only. Some browsers expose a
          // valid MediaRecorder payload while AudioContext remains suspended or
          // reports zero samples, so it must not reject the recording.
          status: hasAudio ? "recorded" : "denied",
          seconds,
          level: 0,
          audioUrl: url,
          audioBlob: hasAudio ? uploadBlob : null,
          mocked: false,
          error: hasAudio ? current.error : "没有录到音频数据。请检查麦克风权限后重试。",
        }));
        if (saveDraft && hasAudio) {
          try {
            await onInterruptedRecording?.({
              blob: uploadBlob,
              durationSec: Math.max(1, seconds),
              mimeType: uploadMimeType,
              reason,
            });
          } catch {
            update((current) => ({
              ...current,
              error: "The interrupted recording is still on this device, but could not be queued.",
            }));
          }
        }
      } else {
        cleanup();
        update((current) => ({
          ...current,
          status: "recorded",
          seconds,
          level: 0,
          audioBlob: null,
          mocked: true,
        }));
      }
      stoppingRef.current = false;
    },
    [cleanup, onInterruptedRecording, revokeAudioUrl, update],
  );
  stopRef.current = stop;

  const start = useCallback(async () => {
    stopMicrophoneTest();
    const startRequest = ++startRequestRef.current;
    startPendingRef.current = startRequest;
    update({
      status: "requesting",
      seconds: 0,
      level: 0,
      audioUrl: null,
      audioBlob: null,
      mocked: false,
      error: null,
    });
    const supported =
      typeof window !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window.MediaRecorder !== "undefined";
    if (mode === "api" && typeof window !== "undefined" && !window.isSecureContext) {
      startPendingRef.current = null;
      update({
        status: "denied",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: false,
        error: "麦克风只能在 localhost 或 HTTPS 页面中使用。请通过 http://localhost:8080 打开。",
      });
      return;
    }
    if (!supported) {
      startPendingRef.current = null;
      if (mode === "api") {
        update({
          status: "denied",
          seconds: 0,
          level: 0,
          audioUrl: null,
          audioBlob: null,
          mocked: false,
          error:
            "This browser cannot capture a microphone recording. Switch to demo mode to continue.",
        });
        return;
      }
      update({
        status: "recording",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: true,
        error: "This browser doesn't support microphone recording — running in demo mode.",
      });
      startTimer();
      startMockLevels();
      return;
    }
    try {
      if (!mountedRef.current || startRequest !== startRequestRef.current) return;
      // Call getUserMedia directly from the click's synchronous call chain so
      // browsers can show their native permission prompt.
      console.info("[mic] requesting microphone", {
        origin: window.location.origin,
        secureContext: window.isSecureContext,
        visibility: document.visibilityState,
        userActivation: navigator.userActivation?.isActive ?? false,
      });
      const selectedDeviceId = selectedInputDeviceIdRef.current;
      const audioConstraints: MediaTrackConstraints = {
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
      };
      const mediaRequest = navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const timeoutError = new Error("microphone-request-timeout");
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutRequest = new Promise<MediaStream>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError), MICROPHONE_REQUEST_TIMEOUT_MS);
      });
      let stream: MediaStream;
      try {
        stream = await Promise.race([mediaRequest, timeoutRequest]);
      } catch (error) {
        // getUserMedia cannot be aborted. If it resolves after the timeout or
        // after the user cancelled, immediately release the late stream.
        void mediaRequest
          .then((lateStream) => {
            lateStream.getTracks().forEach((track) => track.stop());
          })
          .catch(() => {});
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      const currentStart = startRequest === startRequestRef.current && mountedRef.current;
      if (startPendingRef.current === startRequest) startPendingRef.current = null;
      if (!currentStart || document.visibilityState === "hidden") {
        stream.getTracks().forEach((track) => track.stop());
        if (currentStart) {
          update((current) => ({ ...current, status: "idle" }));
        }
        return;
      }
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const trackSettings = track?.getSettings();
      const actualDeviceId = trackSettings?.deviceId || selectedDeviceId;
      if (actualDeviceId) {
        selectedInputDeviceIdRef.current = actualDeviceId;
        setSelectedInputDeviceId(actualDeviceId);
        saveInputDeviceId(actualDeviceId);
      }
      void refreshInputDevices();
      console.info("[mic] microphone acquired", {
        label: track?.label || "unknown",
        sampleRate: trackSettings?.sampleRate ?? null,
        channelCount: trackSettings?.channelCount ?? null,
        muted: track?.muted ?? null,
        readyState: track?.readyState ?? null,
      });
      const preferredMimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
      ].find(
        (mimeType) =>
          typeof MediaRecorder.isTypeSupported !== "function" ||
          MediaRecorder.isTypeSupported(mimeType),
      );
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        void stopRef.current("media-recorder-error", true);
      };
      // A 1s timeslice bounds data loss when iOS suspends the page mid-take.
      recorder.start(1000);
      // Wake Lock is an enhancement. A browser that leaves its request
      // pending must never keep the recorder in the permission-pending UI.
      void requestWakeLock();
      const interrupt = () => {
        if (recorderRef.current?.state === "recording")
          void stopRef.current("track-interrupted", true);
      };
      stream.getTracks().forEach((track) => {
        // iOS briefly mutes the track for notifications and route changes.
        // Only a mute that persists is a real interruption; ending the take on
        // the transient one truncated otherwise healthy recordings.
        let muteTimer: ReturnType<typeof setTimeout> | undefined;
        const onMute = () => {
          clearTimeout(muteTimer);
          muteTimer = setTimeout(() => {
            if (track.muted) interrupt();
          }, MUTE_GRACE_MS);
        };
        const onUnmute = () => clearTimeout(muteTimer);
        track.addEventListener("mute", onMute);
        track.addEventListener("unmute", onUnmute);
        track.addEventListener("ended", interrupt);
        trackCleanupRef.current.push(() => {
          clearTimeout(muteTimer);
          track.removeEventListener("mute", onMute);
          track.removeEventListener("unmute", onUnmute);
          track.removeEventListener("ended", interrupt);
        });
      });
      // Show active recording as soon as MediaRecorder starts. Optional wake
      // lock and level-meter setup must not delay the core interaction.
      update({
        status: "recording",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: false,
        error: null,
      });
      startTimer();
      const AudioCtor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtor) {
        try {
          const ctx = new AudioCtor();
          ctxRef.current = ctx;
          ctx.onstatechange = () => {
            const audioState = ctx.state as string;
            // `suspended` is a normal AudioContext state on mobile (autoplay
            // policy, backgrounding) and does not stop the MediaRecorder, so
            // it must not abort the take.
            if (audioState === "interrupted" || audioState === "closed") interrupt();
          };
          // Analyser setup is only a level-meter enhancement. A suspended or
          // unavailable AudioContext must never cancel a valid MediaRecorder.
          void ctx.resume().catch(() => {});
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          const data = new Uint8Array(analyser.frequencyBinCount);
          const levelTick = () => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
            update((current) =>
              current.status === "recording" ? { ...current, level: peak } : current,
            );
            rafRef.current = requestAnimationFrame(levelTick);
          };
          rafRef.current = requestAnimationFrame(levelTick);
        } catch {
          if (ctxRef.current) void ctxRef.current.close().catch(() => {});
          ctxRef.current = null;
          analyserRef.current = null;
        }
      }
    } catch (error) {
      if (startPendingRef.current === startRequest) startPendingRef.current = null;
      if (!mountedRef.current || startRequest !== startRequestRef.current) return;
      console.warn("[mic] microphone request failed", {
        name: error instanceof DOMException ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      cleanup();
      const permissionState = await microphonePermissionState();
      const timedOut = error instanceof Error && error.message === "microphone-request-timeout";
      const permissionDenied =
        permissionState === "denied" ||
        (error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "SecurityError"));
      const noMicrophone = error instanceof DOMException && error.name === "NotFoundError";
      update({
        status: "denied",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: false,
        error: timedOut
          ? "麦克风权限请求超时。请检查浏览器和系统麦克风权限后重试。"
          : permissionDenied
            ? "麦克风权限被阻止。请在浏览器和系统设置中允许 localhost 使用麦克风后重试。"
            : noMicrophone
              ? "没有检测到可用麦克风。请连接麦克风后重试。"
              : mode === "api"
                ? "无法打开麦克风。请检查浏览器权限后重试。"
                : "无法打开麦克风。",
      });
    }
  }, [
    cleanup,
    mode,
    refreshInputDevices,
    requestWakeLock,
    startMockLevels,
    startTimer,
    stopMicrophoneTest,
    update,
  ]);

  const startDemo = useCallback(() => {
    update({
      status: "recording",
      seconds: 0,
      level: 0,
      audioUrl: null,
      audioBlob: null,
      mocked: true,
      error: "Demo mode: your voice isn't being captured.",
    });
    startTimer();
    startMockLevels();
  }, [startMockLevels, startTimer, update]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void stopRef.current("visibilitychange", true);
      if (document.visibilityState === "visible" && recorderRef.current?.state === "recording") {
        void requestWakeLock();
      }
    };
    const onPageHide = () => {
      void stopRef.current("pagehide", true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [requestWakeLock]);

  const reset = useCallback(() => {
    startRequestRef.current += 1;
    startPendingRef.current = null;
    cleanup();
    revokeAudioUrl();
    recorderRef.current = null;
    stoppingRef.current = false;
    update({
      status: "idle",
      seconds: 0,
      level: 0,
      audioUrl: null,
      audioBlob: null,
      mocked: false,
      error: null,
    });
  }, [cleanup, revokeAudioUrl, update]);
  return {
    ...state,
    inputDevices,
    selectedInputDeviceId,
    selectInputDevice,
    refreshInputDevices,
    microphoneTestStatus,
    microphoneTestLevel,
    startMicrophoneTest,
    stopMicrophoneTest,
    start,
    startDemo,
    stop: () => stop(),
    reset,
  };
}
