import { useCallback, useEffect, useRef, useState } from "react";
import type { AppMode } from "./mode";

export type RecorderStatus = "idle" | "requesting" | "recording" | "recorded" | "denied";

export type RecorderState = {
  status: RecorderStatus;
  seconds: number;
  level: number;
  audioUrl: string | null;
  audioBlob: Blob | null;
  mocked: boolean;
  error: string | null;
};

/**
 * MediaRecorder wrapper. Demo mode may explicitly simulate a recording; API mode never does.
 */
export function useRecorder({ mode = "demo" }: { mode?: AppMode } = {}) {
  const [state, setState] = useState<RecorderState>({
    status: "idle",
    seconds: 0,
    level: 0,
    audioUrl: null,
    audioBlob: null,
    mocked: false,
    error: null,
  });

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    analyserRef.current = null;
    void ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cleanup();
      revokeAudioUrl();
    },
    [cleanup, revokeAudioUrl],
  );

  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setState((s) => ({ ...s, seconds: s.seconds + 1 }));
    }, 1000);
  }, []);

  const startMockLevels = useCallback(() => {
    let t = 0;
    const tick = () => {
      t += 1;
      setState((s) =>
        s.status === "recording"
          ? {
              ...s,
              level: 0.35 + 0.3 * Math.abs(Math.sin(t / 9)) + 0.15 * Math.abs(Math.sin(t / 3)),
            }
          : s,
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async () => {
    setState({
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
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window.MediaRecorder !== "undefined";

    if (!supported) {
      setState({
        status: mode === "api" ? "denied" : "recording",
        seconds: 0,
        level: 0,
        audioUrl: null,
        audioBlob: null,
        mocked: mode !== "api",
        error:
          mode === "api"
            ? "This browser cannot capture a microphone recording. Switch to demo mode to continue."
            : "This browser doesn't support microphone recording — running in demo mode.",
      });
      if (mode === "api") return;
      startTimer();
      startMockLevels();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();

      const AudioCtor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtor) {
        const ctx = new AudioCtor();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
          setState((s) => (s.status === "recording" ? { ...s, level: peak } : s));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }

      setState({
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
      setState({
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
  }, [cleanup, mode, startTimer, startMockLevels]);

  /** Continue without a microphone (demo mode). */
  const startDemo = useCallback(() => {
    setState({
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
  }, [startTimer, startMockLevels]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;

    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const url = blob.size > 0 ? URL.createObjectURL(blob) : null;
      revokeAudioUrl();
      audioUrlRef.current = url;
      recorderRef.current = null;
      cleanup();
      setState((s) => ({
        ...s,
        status: "recorded",
        level: 0,
        audioUrl: url,
        audioBlob: blob.size > 0 ? blob : null,
        mocked: url === null,
      }));
      return;
    }
    cleanup();
    setState((s) => ({ ...s, status: "recorded", level: 0, audioBlob: null, mocked: true }));
  }, [cleanup, revokeAudioUrl]);

  const reset = useCallback(() => {
    cleanup();
    revokeAudioUrl();
    recorderRef.current = null;
    setState({
      status: "idle",
      seconds: 0,
      level: 0,
      audioUrl: null,
      audioBlob: null,
      mocked: false,
      error: null,
    });
  }, [cleanup, revokeAudioUrl]);

  return { ...state, start, startDemo, stop, reset };
}
