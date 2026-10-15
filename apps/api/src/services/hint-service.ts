import { HintResponseSchema } from "@a-move-ago/api-contract";
import type { z } from "zod";
import {
  findHintAttemptForActor,
  findHintForActor,
  findPuzzleHint,
  isSessionActorActive,
  persistHintForActor,
} from "../db/attempts";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { localizeHint } from "./localization-service";

type HintResponse = z.infer<typeof HintResponseSchema>;

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
}

function attemptNotFound(): ApiError {
  return new ApiError(404, "ATTEMPT_NOT_FOUND", "Attempt not found.");
}

function attemptAlreadyCorrect(): ApiError {
  return new ApiError(
    409,
    "ATTEMPT_ALREADY_CORRECT",
    "Hints are unavailable for a correct attempt.",
  );
}

function hintOutOfOrder(): ApiError {
  return new ApiError(409, "HINT_OUT_OF_ORDER", "Request the next hint level.");
}

function hintsExhausted(): ApiError {
  return new ApiError(409, "HINTS_EXHAUSTED", "No more hints are available.");
}

function parseStoredHint(source: string, requestedLevel: number, label: string): HintResponse {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Stored ${label} JSON is invalid`);
  }
  const parsed = HintResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Stored ${label} is invalid`);
  if (parsed.data.level !== requestedLevel) {
    throw new Error("Stored hint level does not match its key");
  }
  return parsed.data;
}

async function throwMissingActorOrAttempt(
  env: Env,
  actor: SessionActor,
  now: number,
): Promise<never> {
  if (!(await isSessionActorActive(env.DB, actor, now))) throw invalidSession();
  throw attemptNotFound();
}

export async function requestHint(
  env: Env,
  actor: SessionActor,
  attemptId: string,
  requestedLevel: number,
  now: number,
  includeLocalizations = false,
): Promise<HintResponse> {
  const attempt = await findHintAttemptForActor(env.DB, actor, attemptId, now);
  if (!attempt) return await throwMissingActorOrAttempt(env, actor, now);
  if (attempt.correct !== 0 && attempt.correct !== 1) {
    throw new Error("Stored attempt correctness is invalid");
  }
  if (attempt.correct === 1) throw attemptAlreadyCorrect();
  const puzzleRowId = attempt.puzzle_id;

  async function result(hint: HintResponse) {
    return includeLocalizations ? await localizeHint(env.DB, puzzleRowId, hint) : hint;
  }

  const replay = await findHintForActor(env.DB, actor, attemptId, requestedLevel, now);
  if (replay) {
    return await result(parseStoredHint(replay.hint_json, requestedLevel, "hint event"));
  }

  if (requestedLevel !== attempt.max_hint_level + 1) throw hintOutOfOrder();
  const puzzleHint = await findPuzzleHint(env.DB, attempt.puzzle_id, requestedLevel);
  if (!puzzleHint) throw hintsExhausted();
  const hint = parseStoredHint(puzzleHint.payload_json, requestedLevel, "puzzle hint");

  await persistHintForActor(env.DB, actor, {
    attemptId,
    hintLevel: requestedLevel,
    hintJson: JSON.stringify(hint),
    now,
  });

  const stored = await findHintForActor(env.DB, actor, attemptId, requestedLevel, now);
  if (stored) return await result(parseStoredHint(stored.hint_json, requestedLevel, "hint event"));
  return await throwMissingActorOrAttempt(env, actor, now);
}
