import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMode } from "./mode";

export type RecorderStatus = "idle" | "requesting" | "recording" | "recorded" | "denied";
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
  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);
  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
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
      // Route changes do not reliably emit pagehide. Give MediaRecorder one
      // last chance to emit its final chunk before tearing down the stream.
      if (recorderRef.current) void stopRef.current("component-unmount", true);
      else cleanup();
      revokeAudioUrl();
    },
    [cleanup, revokeAudioUrl],
  );

  const startTimer = useCallback(() => {
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
        const url = blob.size > 0 ? URL.createObjectURL(blob) : null;
        revokeAudioUrl();
        audioUrlRef.current = url;
        recorderRef.current = null;
        cleanup();
        update((current) => ({
          ...current,
          status: "recorded",
          seconds,
          level: 0,
          audioUrl: url,
          audioBlob: blob.size ? blob : null,
          mocked: !blob.size,
          error:
            blob.size || !saveDraft
              ? current.error
              : "The recording was interrupted before audio data was available.",
        }));
        if (saveDraft && blob.size > 0) {
          try {
            await onInterruptedRecording?.({
              blob,
              durationSec: Math.max(1, seconds),
              mimeType,
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
    if (!supported) {
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || document.visibilityState === "hidden") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const preferredMimeType = [
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/webm;codecs=opus",
        "audio/webm",
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
      await requestWakeLock();
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
          await ctx.resume().catch(() => {});
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
    } catch {
      cleanup();
      update({
        status: "denied",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: false,
        error:
          mode === "api"
            ? "Microphone access was blocked. Allow it or switch to demo mode explicitly."
            : "Microphone access was blocked.",
      });
    }
  }, [cleanup, mode, requestWakeLock, startMockLevels, startTimer, update]);

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
  return { ...state, start, startDemo, stop: () => stop(), reset };
}
