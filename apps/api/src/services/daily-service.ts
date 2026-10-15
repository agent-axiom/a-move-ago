import {
  DailyCaseResponseSchema,
  type PuzzlePublic,
  PuzzlePublicSchema,
} from "@a-move-ago/api-contract";
import { findPublishedDaily, findSolvedPuzzleRows } from "../db/content";
import { readGameProgress } from "../db/gameplay";
import { publicPuzzleId } from "../db/puzzle-identity";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { neutralCaseTitles, neutralPuzzleTitles, puzzleProgressStates } from "./gameplay-service";
import { caseTitleLocalizations, publicPuzzleLocalizations } from "./localization-service";

const neutralPuzzlePrompts = {
  en: "Reconstruct the last move.",
  ru: "Восстановите последний ход.",
  zh: "还原上一步棋。",
};

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
  includeGameProgress = false,
) {
  if (requestedDate > today) throw dailyNotFound();

  const rows = await findPublishedDaily(env.DB, requestedDate, today);
  const first = rows[0];
  if (!first) throw dailyNotFound();
  if (typeof first.title !== "string" || first.title.length === 0)
    throw new Error("Stored daily title is invalid");
  const puzzleRowIds = rows.map((row) => row.puzzle_row_id);
  const progressStates = includeGameProgress
    ? await puzzleProgressStates(env, actor, puzzleRowIds, includeLocalizations)
    : undefined;
  const rawProgress = progressStates ?? (await readGameProgress(env.DB, actor, puzzleRowIds));
  const entitled = (rowId: string) => {
    const progress = rawProgress.get(rowId);
    return progress !== undefined && (progress.clueUnlocked || progress.earnedPoints !== null);
  };
  const caseEntitled = rows.every((row) => entitled(row.puzzle_row_id));

  const [titles, translatedPuzzles] = includeLocalizations
    ? await Promise.all([
        caseTitleLocalizations(env.DB, first.case_id),
        publicPuzzleLocalizations(env.DB, first.case_id),
      ])
    : ([undefined, undefined] as const);

  const puzzles: PuzzlePublic[] = [];
  const physicalToLogical = new Map<string, string>();
  const physicalToPublic = new Map<string, string>();
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
    const alias = publicPuzzleId(first.case_id, row.position, puzzle.version);
    physicalToPublic.set(row.puzzle_row_id, alias);
    const localizations = translatedPuzzles?.get(row.puzzle_row_id);
    const visible = entitled(row.puzzle_row_id);
    const neutral = neutralPuzzleTitles(row.position);
    const { localizations: _sourceLocalizations, ...publicFields } = puzzle;
    puzzles.push({
      ...publicFields,
      id: alias,
      title: visible ? puzzle.title : neutral.en,
      prompt: visible ? puzzle.prompt : neutralPuzzlePrompts.en,
      ...(localizations === undefined
        ? {}
        : {
            localizations: Object.fromEntries(
              Object.entries(localizations).map(([locale, text]) => [
                locale,
                {
                  ...text,
                  title: visible ? text.title : neutral[locale as "ru" | "zh"],
                  prompt: visible ? text.prompt : neutralPuzzlePrompts[locale as "ru" | "zh"],
                },
              ]),
            ),
          }),
    });
  }

  const solvedRows = await findSolvedPuzzleRows(env.DB, first.case_id, actor);
  const solved = new Set<string>();
  for (const row of solvedRows) {
    const logicalId = physicalToLogical.get(row.puzzle_row_id);
    if (logicalId === undefined || logicalId !== row.content_key) {
      throw new Error("Stored solved puzzle is not part of its daily case");
    }
    const alias = physicalToPublic.get(row.puzzle_row_id);
    if (!alias) throw new Error("Stored solved puzzle alias is missing");
    solved.add(alias);
  }

  const response = DailyCaseResponseSchema.safeParse({
    id: first.case_id,
    date: first.case_date,
    title: caseEntitled ? first.title : neutralCaseTitles.en.title,
    ...(includeLocalizations
      ? {
          localizations: caseEntitled
            ? titles?.get(first.case_id)
            : { ru: neutralCaseTitles.ru, zh: neutralCaseTitles.zh },
        }
      : {}),
    puzzles,
    solvedPuzzleIds: puzzles.filter((puzzle) => solved.has(puzzle.id)).map((puzzle) => puzzle.id),
    ...(progressStates !== undefined
      ? {
          progressStates: Object.fromEntries(
            [...progressStates].map(([rowId, state]) => [physicalToPublic.get(rowId), state]),
          ),
        }
      : {}),
  });
  if (!response.success) throw new Error("Stored daily response is invalid");
  return response.data;
}
