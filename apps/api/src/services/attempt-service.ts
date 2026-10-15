import {
  AcceptedSolutionSchema,
  type AttemptRequestSchema,
  AttemptResultSchema,
  type PuzzlePrivate,
  PuzzlePrivateSchema,
  PuzzlePublicSchema,
  type Retraction,
  RetractionSchema,
} from "@a-move-ago/api-contract";
import { evaluateRetraction } from "@a-move-ago/game-core";
import type { ZodType } from "zod";
import {
  type AttemptInsert,
  type AttemptPuzzleRow,
  type AttemptReplayRow,
  findAttemptPuzzle,
  findAttemptReplayForActor,
  insertAttempt,
  isSessionActorActive,
} from "../db/attempts";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { localizeAttemptResult } from "./localization-service";

export type AttemptInput = ReturnType<typeof AttemptRequestSchema.parse>;
type AttemptResult = ReturnType<typeof AttemptResultSchema.parse>;

function puzzleNotFound(): ApiError {
  return new ApiError(404, "PUZZLE_NOT_FOUND", "Puzzle not found.");
}

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key was already used for another request.",
  );
}

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
}

function parseStoredJson<T>(source: string | null, schema: ZodType<T>, label: string): T {
  if (source === null) throw new Error(`Stored ${label} is missing`);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Stored ${label} JSON is invalid`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`Stored ${label} is invalid`);
  return parsed.data;
}

function canonicalRetraction(retraction: Retraction): string {
  return JSON.stringify({
    currentSquare: retraction.currentSquare,
    previousSquare: retraction.previousSquare,
    movedPiece: {
      color: retraction.movedPiece.color,
      type: retraction.movedPiece.type,
    },
    restoredPiece:
      retraction.restoredPiece === null
        ? null
        : {
            color: retraction.restoredPiece.color,
            type: retraction.restoredPiece.type,
            square: retraction.restoredPiece.square,
          },
    special: retraction.special,
  });
}

function canonicalStringMap(value: Record<string, string | undefined>): string {
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries));
}

function loadPuzzle(rows: AttemptPuzzleRow[]): PuzzlePrivate {
  const first = rows[0];
  if (!first) throw puzzleNotFound();

  for (const row of rows) {
    if (
      row.case_id !== first.case_id ||
      row.puzzle_row_id !== first.puzzle_row_id ||
      row.puzzle_content_key !== first.puzzle_content_key ||
      row.puzzle_version !== first.puzzle_version ||
      row.public_json !== first.public_json
    ) {
      throw new Error("Stored attempt puzzle rows are inconsistent");
    }
  }

  const publicPuzzle = parseStoredJson(first.public_json, PuzzlePublicSchema, "puzzle public data");
  if (
    publicPuzzle.id !== first.puzzle_content_key ||
    publicPuzzle.version !== first.puzzle_version
  ) {
    throw new Error("Stored puzzle identity is inconsistent");
  }

  const acceptedSolutions = [];
  let contradictionExplanations: PuzzlePrivate["contradictionExplanations"] | undefined;
  let contradictionKey: string | undefined;
  let previousOrder = 0;
  for (const row of rows) {
    if (
      row.sort_order === null ||
      !Number.isSafeInteger(row.sort_order) ||
      row.sort_order <= previousOrder
    ) {
      throw new Error("Stored puzzle solution order is invalid");
    }
    previousOrder = row.sort_order;
    acceptedSolutions.push(
      parseStoredJson(row.solution_json, AcceptedSolutionSchema, "accepted solution"),
    );
    const currentExplanations = parseStoredJson(
      row.contradiction_json,
      PuzzlePrivateSchema.shape.contradictionExplanations,
      "contradiction explanations",
    );
    const currentKey = canonicalStringMap(currentExplanations);
    if (contradictionKey !== undefined && currentKey !== contradictionKey) {
      throw new Error("Stored contradiction explanations are inconsistent");
    }
    contradictionExplanations = currentExplanations;
    contradictionKey = currentKey;
  }

  const parsed = PuzzlePrivateSchema.safeParse({
    public: publicPuzzle,
    acceptedSolutions,
    hints: [],
    contradictionExplanations,
  });
  if (!parsed.success) throw new Error("Stored private puzzle is invalid");
  return parsed.data;
}

function parseReplay(
  row: AttemptReplayRow,
  input: AttemptInput,
  answerJson: string,
): AttemptResult {
  const storedAnswer = parseStoredJson(
    row.normalized_answer_json,
    RetractionSchema,
    "normalized answer",
  );
  const storedCanonicalAnswer = canonicalRetraction(storedAnswer);
  if (storedCanonicalAnswer !== row.normalized_answer_json) {
    throw new Error("Stored normalized answer is not canonical");
  }

  const body = parseStoredJson(row.response_json, AttemptResultSchema, "attempt response");
  if (
    body.id !== row.id ||
    body.attemptUuid !== input.attemptUuid ||
    (row.correct !== 0 && row.correct !== 1) ||
    body.correct !== (row.correct === 1) ||
    (body.correct && canonicalRetraction(body.reveal.retraction) !== storedCanonicalAnswer)
  ) {
    throw new Error("Stored attempt response is inconsistent");
  }

  if (
    row.case_id !== input.caseId ||
    row.puzzle_content_key !== input.puzzleId ||
    storedCanonicalAnswer !== answerJson
  ) {
    throw idempotencyConflict();
  }
  return body;
}

function validatedResult(value: unknown): AttemptResult {
  const parsed = AttemptResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Generated attempt response is invalid");
  return parsed.data;
}

function utcDate(now: number): string {
  if (!Number.isSafeInteger(now)) throw new Error("Attempt timestamp is invalid");
  return new Date(now * 1_000).toISOString().slice(0, 10);
}

export async function submitAttempt(
  env: Env,
  actor: SessionActor,
  input: AttemptInput,
  now: number,
  includeLocalizations = false,
): Promise<{ replayed: boolean; body: AttemptResult }> {
  async function result(replayed: boolean, body: AttemptResult) {
    return {
      replayed,
      body: includeLocalizations
        ? await localizeAttemptResult(env.DB, input.caseId, input.puzzleId, body)
        : body,
    };
  }
  const answerJson = canonicalRetraction(input.retraction);
  const replay = await findAttemptReplayForActor(env.DB, actor, input.attemptUuid, now);
  if (replay) {
    return await result(true, parseReplay(replay, input, answerJson));
  }
  if (!(await isSessionActorActive(env.DB, actor, now))) throw invalidSession();

  const rows = await findAttemptPuzzle(env.DB, input.caseId, input.puzzleId, utcDate(now));
  if (rows.length === 0) throw puzzleNotFound();
  const puzzle = loadPuzzle(rows);
  const evaluation = evaluateRetraction(puzzle, input.retraction);
  const id = crypto.randomUUID();
  const body = validatedResult({ id, attemptUuid: input.attemptUuid, ...evaluation });
  const first = rows[0];
  if (!first) throw new Error("Attempt puzzle disappeared");
  const insert: AttemptInsert = {
    id,
    attemptUuid: input.attemptUuid,
    sessionId: actor.sessionId,
    sessionKind: actor.kind,
    playerId: actor.playerId,
    caseId: input.caseId,
    puzzleId: first.puzzle_row_id,
    answerJson,
    correct: body.correct,
    responseJson: JSON.stringify(body),
    submittedAt: now,
  };

  if (await insertAttempt(env.DB, insert)) return await result(false, body);

  const winner = await findAttemptReplayForActor(env.DB, actor, input.attemptUuid, now);
  if (winner) return await result(true, parseReplay(winner, input, answerJson));
  if (!(await isSessionActorActive(env.DB, actor, now))) throw invalidSession();
  throw new Error("Attempt insertion did not create or recover a row");
}
