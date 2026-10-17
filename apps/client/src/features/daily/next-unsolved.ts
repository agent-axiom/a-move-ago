import type { ApiClient } from "@a-move-ago/api-contract";

export async function findNextUnsolvedCase(
  api: Pick<ApiClient, "getArchive">,
  currentDate: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const archive = await api.getArchive(signal);
  // The catalog spans the entire published archive, including previous months.
  // Select using server time, so a wrong device clock cannot expose future cases.
  let next: string | null = null;
  for (const dailyCase of archive.cases) {
    if (
      dailyCase.completed ||
      dailyCase.date === currentDate ||
      dailyCase.date > archive.today ||
      dailyCase.solvedPuzzles >= dailyCase.puzzleCount
    )
      continue;
    if (next === null || dailyCase.date > next) next = dailyCase.date;
  }
  return next;
}
