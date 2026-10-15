import {
  AcceptedSolutionSchema,
  type AttemptResultSchema,
  type ContentLocale,
  ContentLocaleSchema,
  type HintResponseSchema,
  LocalizedPuzzlePrivateSchema,
  LocalizedPuzzlePublicSchema,
  LocalizedTitleSchema,
} from "@a-move-ago/api-contract";
import type { z } from "zod";
import {
  readCaseLocalizations,
  readContradictionLocalizations,
  readHintLocalizations,
  readPublicPuzzleLocalizations,
  readSolutionLocalizations,
} from "../db/localizations";

type Localizations<T> = Partial<Record<ContentLocale, T>>;
type AttemptResult = z.infer<typeof AttemptResultSchema>;
type HintResponse = z.infer<typeof HintResponseSchema>;

function locale(value: string): ContentLocale {
  return ContentLocaleSchema.parse(value);
}

export async function caseTitleLocalizations(db: D1Database, caseId?: string) {
  const localized = new Map<string, Localizations<{ title: string }>>();
  for (const row of await readCaseLocalizations(db, caseId)) {
    const titles = localized.get(row.case_id) ?? {};
    titles[locale(row.locale)] = LocalizedTitleSchema.parse({ title: row.title });
    localized.set(row.case_id, titles);
  }
  return localized;
}

export async function publicPuzzleLocalizations(db: D1Database, caseId: string) {
  const localized = new Map<
    string,
    Localizations<z.infer<typeof LocalizedPuzzlePublicSchema>>
  >();
  for (const row of await readPublicPuzzleLocalizations(db, caseId)) {
    const texts = localized.get(row.puzzle_id) ?? {};
    texts[locale(row.locale)] = LocalizedPuzzlePublicSchema.parse(JSON.parse(row.public_json));
    localized.set(row.puzzle_id, texts);
  }
  return localized;
}

export async function localizeHint(db: D1Database, puzzleRowId: string, hint: HintResponse) {
  const texts: Localizations<{ text: string }> = {};
  for (const row of await readHintLocalizations(db, puzzleRowId, hint.level)) {
    if (row.text === null) continue;
    if (typeof row.text !== "string" || row.text.length === 0) {
      throw new Error("Stored hint translation is invalid");
    }
    texts[locale(row.locale)] = { text: row.text };
  }
  return Object.keys(texts).length === 0 ? hint : { ...hint, localizations: texts };
}

const defaultContradictions = {
  NO_PIECE_ON_CURRENT_SQUARE: {
    en: "There is no piece to move back from that square.",
    ru: "На этой клетке нет фигуры, которую можно вернуть назад.",
    zh: "该格上没有可以退回的棋子。",
  },
  WRONG_COLOR: {
    en: "That piece could not have made the last move.",
    ru: "Эта фигура не могла сделать последний ход.",
    zh: "这枚棋子不可能走出上一步。",
  },
  PREVIOUS_SQUARE_OCCUPIED: {
    en: "The proposed previous square was occupied.",
    ru: "Предлагаемая исходная клетка занята.",
    zh: "所选的原始格已被占据。",
  },
  RESTORE_SQUARE_OCCUPIED: {
    en: "The captured piece cannot be restored on an occupied square.",
    ru: "Нельзя восстановить взятую фигуру на занятой клетке.",
    zh: "不能在已被占据的格上恢复被吃的棋子。",
  },
  INVALID_SPECIAL_MOVE: {
    en: "That special move cannot be retracted from this position.",
    ru: "В этой позиции нельзя отменить такой особый ход.",
    zh: "在此局面中无法撤回这种特殊走法。",
  },
  OPPONENT_KING_IN_CHECK: {
    en: "The previous position leaves the side not to move in check.",
    ru: "В предыдущей позиции король стороны, которая не ходит, остаётся под шахом.",
    zh: "在还原后的局面中，非行棋方的王处于被将军状态。",
  },
  NOT_THE_LAST_MOVE: {
    en: "The position is legal, but the evidence does not support that last move.",
    ru: "Позиция допустима, но условия задачи не подтверждают этот последний ход.",
    zh: "局面合法，但题目线索不支持这一步作为最后一着。",
  },
} as const;

// Call only after normal attempt ownership, idempotency and correctness checks.
// Persisted response_json stays English so changing languages never changes an attempt.
export async function localizeAttemptResult(
  db: D1Database,
  caseId: string,
  puzzleId: string,
  body: AttemptResult,
): Promise<AttemptResult> {
  if (body.correct) {
    const texts: Localizations<{ explanation: string }> = {};
    const { localizations: _existing, ...baseReveal } = body.reveal;
    const canonical = JSON.stringify(AcceptedSolutionSchema.parse(baseReveal));
    for (const row of await readSolutionLocalizations(db, caseId, puzzleId)) {
      if (row.explanation === null) continue;
      const solution = AcceptedSolutionSchema.parse(JSON.parse(row.solution_json));
      if (JSON.stringify(solution) !== canonical) continue;
      if (typeof row.explanation !== "string" || row.explanation.length === 0) {
        throw new Error("Stored solution translation is invalid");
      }
      texts[locale(row.locale)] = { explanation: row.explanation };
    }
    return Object.keys(texts).length === 0
      ? body
      : { ...body, reveal: { ...baseReveal, localizations: texts } };
  }

  const texts: Localizations<{ message: string }> = {};
  const defaults = defaultContradictions[body.contradiction.code];
  if (body.contradiction.message === defaults.en) {
    texts.ru = { message: defaults.ru };
    texts.zh = { message: defaults.zh };
  }
  for (const row of await readContradictionLocalizations(db, caseId, puzzleId)) {
    const custom = LocalizedPuzzlePrivateSchema.shape.contradictionExplanations.parse(
      JSON.parse(row.contradiction_json),
    );
    const message = custom[body.contradiction.code];
    if (message !== undefined) texts[locale(row.locale)] = { message };
  }
  return Object.keys(texts).length === 0
    ? body
    : { ...body, contradiction: { ...body.contradiction, localizations: texts } };
}
