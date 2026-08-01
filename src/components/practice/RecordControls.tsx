import { Mic, Square, RotateCcw, Play, Pause } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RecorderState } from "@/lib/practice/useRecorder";
import { cn } from "@/lib/utils";

function fmt(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 24;
  return (
    <div className="flex h-12 items-end justify-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }).map((_, i) => {
        const wave = Math.sin((i / bars) * Math.PI);
        const h = active ? 8 + level * 40 * (0.4 + wave) : 6;
        return (
          <span
            key={i}
            className={cn(
              "w-[4px] rounded-full transition-[height] duration-100",
              active ? "bg-primary" : "bg-border",
            )}
            style={{ height: `${Math.min(48, h)}px` }}
          />
        );
      })}
    </div>
  );
}

export function RecordControls({
  recorder,
  targetSeconds,
  onSubmit,
  submitLabel,
}: {
  recorder: RecorderState & {
    start: () => Promise<void>;
    startDemo: () => void;
    stop: () => Promise<void>;
    reset: () => void;
  };
  targetSeconds: number;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const { status, seconds, level, audioUrl, mocked, error } = recorder;

  return (
    <div className="rounded-3xl border border-border bg-card p-5 shadow-lift sm:p-6">
      {status === "denied" ? (
        <div className="space-y-3 text-center">
          <p className="font-display text-lg">Microphone blocked</p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            We couldn't access your mic. Allow it in your browser settings, or keep going in demo
            mode — the coaching flow works either way.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => void recorder.start()}>Try again</Button>
            <Button variant="outline" onClick={recorder.startDemo}>
              Continue in demo mode
            </Button>
          </div>
        </div>
      ) : (
        <>
          <LevelMeter level={level} active={status === "recording"} />

          <p className="mt-3 text-center font-mono text-2xl tabular-nums" aria-live="polite">
            {fmt(seconds)}
            <span className="ml-1 text-sm text-muted-foreground">/ {fmt(targetSeconds)}</span>
          </p>

          <div className="mt-4 flex flex-col items-center gap-3">
            {status === "idle" || status === "requesting" ? (
              <Button
                size="lg"
                className="h-16 rounded-full px-8 text-base shadow-tactile"
                onClick={() => void recorder.start()}
                disabled={status === "requesting"}
              >
                <Mic className="size-5" aria-hidden />
                {status === "requesting" ? "Waiting for mic…" : "Start recording"}
              </Button>
            ) : null}

            {status === "recording" ? (
              <Button
                size="lg"
                variant="destructive"
                className="recording-ring h-16 rounded-full px-8 text-base"
                onClick={() => void recorder.stop()}
              >
                <Square className="size-5" aria-hidden />
                Stop &amp; get feedback
              </Button>
            ) : null}

            {status === "recorded" ? (
              <div className="flex w-full flex-col items-center gap-3">
                <AudioPreview url={audioUrl} seconds={seconds} />
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={recorder.reset}>
                    <RotateCcw className="size-4" aria-hidden />
                    Record again
                  </Button>
                  <Button className="shadow-tactile" onClick={onSubmit}>
                    {submitLabel}
                  </Button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="max-w-sm text-center text-xs text-muted-foreground">{error}</p>
            ) : null}
            {mocked && status === "recording" ? (
              <p className="text-xs text-muted-foreground">
                Demo mode — sample audio will be used.
              </p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function AudioPreview({ url, seconds }: { url: string | null; seconds: number }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);

  useEffect(() => {
    if (url || !playing) return;
    const id = setInterval(() => {
      setT((v) => {
        if (v + 1 >= Math.max(1, seconds)) {
          setPlaying(false);
          return 0;
        }
        return v + 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [playing, url, seconds]);

  const toggle = () => {
    if (url && ref.current) {
      if (playing) ref.current.pause();
      else void ref.current.play();
      return;
    }
    setPlaying((p) => !p);
  };

  const pct = Math.min(100, ((url ? t : t) / Math.max(1, seconds)) * 100);

  return (
    <div className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-border bg-secondary/50 px-3 py-2">
      <Button
        variant="secondary"
        size="icon"
        className="size-10 rounded-full"
        onClick={toggle}
        aria-label={playing ? "Pause your recording" : "Play your recording"}
      >
        {playing ? (
          <Pause className="size-4" aria-hidden />
        ) : (
          <Play className="size-4" aria-hidden />
        )}
      </Button>
      <div className="flex-1">
        <div className="h-2 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {url ? "Your recording" : "Simulated playback (no audio captured)"}
        </p>
      </div>
      {url ? (
        <audio
          ref={ref}
          src={url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setT(Math.floor(e.currentTarget.currentTime))}
          onEnded={() => {
            setPlaying(false);
            setT(0);
          }}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
