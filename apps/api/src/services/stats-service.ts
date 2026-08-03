import { readStatsSnapshot } from "../db/stats";
import type { SessionActor } from "../env";

export function streaks(dates: string[], today: string): { current: number; best: number } {
  const days = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const value = Date.parse(`${day}T00:00:00Z`) / 86_400_000;
    run = previous !== null && value === previous + 1 ? run + 1 : 1;
    previous = value;
    best = Math.max(best, run);
  }
  const todayValue = Date.parse(`${today}T00:00:00Z`) / 86_400_000;
  const delta = previous === null ? null : todayValue - previous;
  const current = delta !== null && delta >= 0 && delta <= 1 ? run : 0;
  return { current, best };
}

export async function statsForActor(db: D1Database, actor: SessionActor, today: string) {
  const snapshot = await readStatsSnapshot(db, actor);
  const completedDates = [...new Set(snapshot.completedDates)].sort();
  const streak = streaks(completedDates, today);
  return {
    attempts: snapshot.attempts,
    hintsUsed: snapshot.hintsUsed,
    solvedPuzzles: snapshot.solvedPuzzles,
    completedCases: snapshot.completedDates.length,
    currentStreak: streak.current,
    bestStreak: streak.best,
    lastCompletedDate: completedDates.at(-1) ?? null,
  };
}
