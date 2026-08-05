import type { Lang, Progress, SessionRecord } from "@kotoba/contracts";
import { progressRepository } from "./repository";

/** Consecutive days (ending today or yesterday) with at least one session. */
export function computeStreak(days: Set<string>): number {
  if (days.size === 0) return 0;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const cursor = new Date();
  if (!days.has(iso(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!days.has(iso(cursor))) return 0;
  }
  let n = 0;
  while (days.has(iso(cursor))) {
    n += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

export async function getProgress(learnerId: string): Promise<Progress> {
  const rows = await progressRepository.listSessions(learnerId);

  const byId = new Map<string, SessionRecord>();
  for (const row of rows) {
    if (row.score === null || row.attemptIndex === null) continue;
    const date = row.day;
    const existing = byId.get(row.sessionId) ?? {
      id: row.sessionId,
      lang: row.lang as Lang,
      promptId: row.promptId,
      date,
      first: row.score,
      second: null,
    };
    if (row.attemptIndex === 1) existing.first = row.score;
    if (row.attemptIndex === 2) existing.second = row.score;
    byId.set(row.sessionId, existing);
  }

  const sessions = [...byId.values()].reverse();
  const improved = sessions.filter((s) => s.second !== null);
  const savedCount = await progressRepository.countSaved(learnerId);

  return {
    streak: computeStreak(new Set(sessions.map((s) => s.date))),
    totalSessions: sessions.length,
    avgSecondAttemptGain:
      improved.length > 0
        ? Math.round(
            improved.reduce((a, s) => a + ((s.second ?? 0) - s.first), 0) / improved.length,
          )
        : null,
    savedCount,
    sessions,
  };
}
