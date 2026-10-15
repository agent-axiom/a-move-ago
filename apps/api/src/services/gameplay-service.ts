import {
  ClueResponseSchema,
  EarnedHintSchema,
  type PuzzleProgress,
  PuzzleProgressSchema,
  PuzzlePublicSchema,
} from "@a-move-ago/api-contract";
import { isSessionActorActive } from "../db/attempts";
import { findPublishedCluePuzzle } from "../db/content";
import { grantPuzzleClue, readGameProgress } from "../db/gameplay";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { localizeHint, publicPuzzleLocalizations } from "./localization-service";

export const neutralCaseTitles = {
  en: { title: "Daily case" },
  ru: { title: "Задача дня" },
  zh: { title: "每日棋题" },
};

export function neutralPuzzleTitles(position: number) {
  return {
    en: `Puzzle ${position}`,
    ru: `Задача ${position}`,
    zh: `棋题 ${position}`,
  };
}

export async function puzzleProgressStates(
  env: Env,
  actor: SessionActor,
  puzzleRowIds: string[],
  includeLocalizations = false,
): Promise<Map<string, PuzzleProgress>> {
  const rows = await readGameProgress(env.DB, actor, puzzleRowIds);
  const result = new Map<string, PuzzleProgress>();
  for (const [puzzleRowId, row] of rows) {
    const earnedHints = [];
    if (row.highestHintLevel > 0) {
      const hints = await env.DB.prepare(
        "SELECT level, payload_json FROM puzzle_hints WHERE puzzle_id = ? AND level <= ? ORDER BY level",
      )
        .bind(puzzleRowId, row.highestHintLevel)
        .all<{ level: number; payload_json: string }>();
      for (const stored of hints.results) {
        const hint = EarnedHintSchema.parse(JSON.parse(stored.payload_json));
        if (hint.level !== stored.level) throw new Error("Stored earned hint identity is invalid");
        earnedHints.push(
          includeLocalizations ? await localizeHint(env.DB, puzzleRowId, hint) : hint,
        );
      }
    }
    result.set(puzzleRowId, PuzzleProgressSchema.parse({ ...row, earnedHints }));
  }
  return result;
}

export async function requestPuzzleClue(
  env: Env,
  actor: SessionActor,
  caseId: string,
  puzzleId: string,
  now: number,
  includeLocalizations = false,
) {
  const today = new Date(now * 1_000).toISOString().slice(0, 10);
  const first = await findPublishedCluePuzzle(env.DB, caseId, puzzleId, today);
  if (!first) throw new ApiError(404, "PUZZLE_NOT_FOUND", "Puzzle not found.");
  const puzzle = PuzzlePublicSchema.parse(JSON.parse(first.public_json));
  if (puzzle.id !== first.content_key || puzzle.version !== first.version) {
    throw new Error("Stored clue puzzle identity is inconsistent");
  }
  await grantPuzzleClue(env.DB, actor, {
    caseId,
    puzzleId: first.puzzle_row_id,
    today,
    now,
  });
  if (!(await isSessionActorActive(env.DB, actor, now))) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  const states = await puzzleProgressStates(
    env,
    actor,
    [first.puzzle_row_id],
    includeLocalizations,
  );
  const progress = states.get(first.puzzle_row_id);
  if (!progress?.clueUnlocked && progress?.earnedPoints === null) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  if (!progress) throw new Error("Clue progress is missing");
  const translations = includeLocalizations
    ? (await publicPuzzleLocalizations(env.DB, caseId)).get(first.puzzle_row_id)
    : undefined;
  return ClueResponseSchema.parse({
    title: puzzle.title,
    prompt: puzzle.prompt,
    ...(translations === undefined
      ? {}
      : {
          localizations: Object.fromEntries(
            Object.entries(translations).map(([locale, text]) => [
              locale,
              { title: text.title, prompt: text.prompt },
            ]),
          ),
        }),
    progress,
  });
}
