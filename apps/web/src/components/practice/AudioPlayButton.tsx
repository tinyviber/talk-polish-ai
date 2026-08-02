import { Loader2, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchAuthenticatedAudioUrl, synthesizeSpeech } from "@/lib/practice/api";
import type { AppMode } from "@/lib/practice/mode";
import type { Lang } from "@/lib/practice/types";

export function AudioPlayButton({
  text,
  lang,
  mode,
  purpose,
}: {
  text: string;
  lang: Lang;
  mode: AppMode;
  purpose: "prompt" | "answer" | "expression";
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  const play = async () => {
    if (mode !== "api" || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await synthesizeSpeech({ text, lang, purpose });
      if (!result.playbackUrl) {
        throw new Error("Audio playback is unavailable in the configured provider mode.");
      }
      const url = await fetchAuthenticatedAudioUrl(result.playbackUrl);
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const audio = new Audio(url);
      audioRef.current = audio;
      objectUrlRef.current = url;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (objectUrlRef.current === url) objectUrlRef.current = null;
      };
      await audio.play();
    } catch (cause) {
      audioRef.current?.pause();
      audioRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setError(cause instanceof Error ? cause.message : "Audio playback failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void play()}
        disabled={loading}
        aria-label="Play audio"
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Volume2 className="size-4" aria-hidden />
        )}
        <span className="hidden sm:inline">{loading ? "Loading…" : "Listen"}</span>
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
