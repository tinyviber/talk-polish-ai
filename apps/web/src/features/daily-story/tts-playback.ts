export type TransientTtsPlayback = {
  audio: Pick<HTMLAudioElement, "pause" | "removeAttribute">;
  url: string;
};

/** Release audio bytes on completion, rejected playback, replacement, or unmount. */
export function releaseTransientTtsPlayback(playback: TransientTtsPlayback | null) {
  if (!playback) return;
  playback.audio.pause();
  playback.audio.removeAttribute("src");
  URL.revokeObjectURL(playback.url);
}
