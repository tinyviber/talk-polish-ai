export type SpeechMetricStatus = "available" | "degraded" | "unavailable";

export type SpeechMetrics = {
  status: SpeechMetricStatus;
  source: "timestamps" | "transcript" | "client-duration" | "unavailable";
  words?: number;
  wpm?: number;
  pauseCount?: number;
  longestPauseSec?: number;
  fillers?: number;
  speechDurationSec?: number;
  silenceDurationSec?: number;
};

export type SpeechMetricsInput = {
  text: string;
  locale?: string;
  durationSec?: number;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
  words?: Array<{ word: string; start?: number; end?: number }>;
};

export function computeSpeechMetrics(input: SpeechMetricsInput): SpeechMetrics {
  const japanese = input.locale?.toLowerCase().startsWith("ja") === true;
  const fillers = countFillers(input.text, input.locale);
  // Japanese has no whitespace word boundary. Until a real morphological
  // tokenizer is part of the runtime, exposing character runs as "words" (and
  // deriving WPM from them) creates confidently wrong feedback.
  if (japanese) {
    return {
      status: "unavailable",
      source: "unavailable",
      ...(fillers ? { fillers } : {}),
    };
  }
  const words = tokenize(input.text, input.locale);
  const timed = input.words?.filter(hasTime) ?? input.segments?.filter(hasTime) ?? [];
  const hasTimestamps = timed.length > 0;
  const pauses = hasTimestamps ? pauseMetrics(timed) : null;
  const durationSec = input.durationSec && input.durationSec > 0 ? input.durationSec : undefined;
  const wpm = durationSec ? Math.round((words.length / durationSec) * 60) : undefined;
  const hasTranscriptEvidence = words.length > 0;
  return {
    status: hasTimestamps
      ? "available"
      : durationSec || hasTranscriptEvidence
        ? "degraded"
        : "unavailable",
    source: hasTimestamps
      ? "timestamps"
      : durationSec
        ? "client-duration"
        : hasTranscriptEvidence
          ? "transcript"
          : "unavailable",
    words: words.length,
    ...(wpm ? { wpm } : {}),
    ...(pauses ? pauses : {}),
    fillers,
    ...(durationSec ? { speechDurationSec: durationSec } : {}),
  };
}

function tokenize(text: string, locale?: string) {
  if (locale?.toLowerCase().startsWith("ja"))
    return text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{L}\p{N}]+/gu) ?? [];
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
}

function countFillers(text: string, locale?: string) {
  const pattern = locale?.toLowerCase().startsWith("ja")
    ? /(?<![\p{L}\p{N}])(えーと|あの|その|まあ)(?![\p{L}\p{N}])/giu
    : /(?<![\p{L}\p{N}])(um|uh|er|like|you know)(?![\p{L}\p{N}])/giu;
  return text.match(pattern)?.length ?? 0;
}

function hasTime(item: { start?: number; end?: number }): item is { start: number; end: number } {
  return (
    typeof item.start === "number" &&
    Number.isFinite(item.start) &&
    typeof item.end === "number" &&
    Number.isFinite(item.end) &&
    item.end >= item.start
  );
}

function pauseMetrics(items: Array<{ start?: number; end?: number }>) {
  const ordered = items.filter(hasTime).sort((a, b) => a.start - b.start);
  const gaps = ordered.slice(1).map((item, index) => Math.max(0, item.start - ordered[index]!.end));
  const meaningful = gaps.filter((gap) => gap >= 0.5);
  return {
    pauseCount: meaningful.length,
    longestPauseSec: meaningful.length ? Math.max(...meaningful) : 0,
    silenceDurationSec: gaps.reduce((sum, gap) => sum + gap, 0),
  };
}
