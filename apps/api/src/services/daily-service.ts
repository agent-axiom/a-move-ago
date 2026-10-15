import {
  DailyCaseResponseSchema,
  type PuzzlePublic,
  PuzzlePublicSchema,
} from "@a-move-ago/api-contract";
import { findPublishedDaily, findSolvedPuzzleRows } from "../db/content";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { caseTitleLocalizations, publicPuzzleLocalizations } from "./localization-service";

function dailyNotFound(): ApiError {
  return new ApiError(404, "DAILY_NOT_FOUND", "Daily case not found.");
}

function parseStoredPublic(publicJson: string): PuzzlePublic {
  let value: unknown;
  try {
    value = JSON.parse(publicJson);
  } catch {
    throw new Error("Stored puzzle public JSON is invalid");
  }
  const parsed = PuzzlePublicSchema.safeParse(value);
  if (!parsed.success) throw new Error("Stored puzzle public projection is invalid");
  return parsed.data;
}

export async function getDailyCase(
  env: Env,
  actor: SessionActor,
  requestedDate: string,
  today: string,
  includeLocalizations = false,
) {
  if (requestedDate > today) throw dailyNotFound();

  const rows = await findPublishedDaily(env.DB, requestedDate, today);
  const first = rows[0];
  if (!first) throw dailyNotFound();

  const [titles, translatedPuzzles] = includeLocalizations
    ? await Promise.all([
        caseTitleLocalizations(env.DB, first.case_id),
        publicPuzzleLocalizations(env.DB, first.case_id),
      ])
    : ([undefined, undefined] as const);

  const puzzles: PuzzlePublic[] = [];
  const physicalToLogical = new Map<string, string>();
  const logicalIds = new Set<string>();
  for (const row of rows) {
    if (
      row.case_id !== first.case_id ||
      row.case_date !== first.case_date ||
      row.title !== first.title
    ) {
      throw new Error("Stored daily case rows are inconsistent");
    }
    const puzzle = parseStoredPublic(row.public_json);
    if (puzzle.id !== row.content_key || puzzle.version !== row.version) {
      throw new Error("Stored puzzle public identity is inconsistent");
    }
    if (logicalIds.has(puzzle.id)) {
      throw new Error("Stored daily case contains a duplicate logical puzzle");
    }
    logicalIds.add(puzzle.id);
    physicalToLogical.set(row.puzzle_row_id, puzzle.id);
    const localizations = translatedPuzzles?.get(row.puzzle_row_id);
    puzzles.push(localizations === undefined ? puzzle : { ...puzzle, localizations });
  }

  const solvedRows = await findSolvedPuzzleRows(env.DB, first.case_id, actor);
  const solved = new Set<string>();
  for (const row of solvedRows) {
    const logicalId = physicalToLogical.get(row.puzzle_row_id);
    if (logicalId === undefined || logicalId !== row.content_key) {
      throw new Error("Stored solved puzzle is not part of its daily case");
    }
    solved.add(logicalId);
  }

  const response = DailyCaseResponseSchema.safeParse({
    id: first.case_id,
    date: first.case_date,
    title: first.title,
    ...(titles?.has(first.case_id) ? { localizations: titles.get(first.case_id) } : {}),
    puzzles,
    solvedPuzzleIds: puzzles.filter((puzzle) => solved.has(puzzle.id)).map((puzzle) => puzzle.id),
  });
  if (!response.success) throw new Error("Stored daily response is invalid");
  return response.data;
}
