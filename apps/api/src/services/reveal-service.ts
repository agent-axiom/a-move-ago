import { AttemptResultSchema, PuzzleRevealResponseSchema } from "@a-move-ago/api-contract";
import { readSolvedPuzzleReveal } from "../db/reveals";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { localizeAttemptResult } from "./localization-service";

export async function getSolvedPuzzleReveal(
  env: Env,
  actor: SessionActor,
  caseId: string,
  puzzleId: string,
  now: number,
  includeLocalizations = false,
) {
  const today = new Date(now * 1_000).toISOString().slice(0, 10);
  const row = await readSolvedPuzzleReveal(env.DB, actor, caseId, puzzleId, today, now);
  if (!row) throw new ApiError(404, "REVEAL_NOT_FOUND", "No solved puzzle review is available.");
  const parsed = AttemptResultSchema.safeParse(JSON.parse(row.response_json));
  if (!parsed.success || !parsed.data.correct) throw new Error("Stored solved response is invalid");
  const result = includeLocalizations
    ? await localizeAttemptResult(env.DB, caseId, row.puzzle_content_key, parsed.data)
    : parsed.data;
  if (!result.correct) throw new Error("Stored solved response is inconsistent");
  return PuzzleRevealResponseSchema.parse({ reveal: result.reveal });
}
