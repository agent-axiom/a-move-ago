import { FeedbackResponseSchema, type PuzzleFeedbackRequest } from "@a-move-ago/api-contract";
import { isSessionActorActive } from "../db/attempts";
import { findPublishedCluePuzzle } from "../db/content";
import { type FeedbackRow, findFeedback, insertFeedback } from "../db/feedback";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

function assertSameReport(row: FeedbackRow, input: PuzzleFeedbackRequest): void {
  if (
    row.case_id !== input.caseId ||
    row.client_puzzle_id !== input.puzzleId ||
    row.puzzle_version !== input.puzzleVersion ||
    row.locale !== input.locale ||
    row.reason !== input.reason ||
    row.comment !== (input.comment ?? "")
  ) {
    throw new ApiError(409, "FEEDBACK_CONFLICT", "This report identifier was already used.");
  }
}

export async function submitPuzzleFeedback(
  env: Env,
  actor: SessionActor,
  input: PuzzleFeedbackRequest,
  now: number,
) {
  const response = FeedbackResponseSchema.parse({
    reportUuid: input.reportUuid,
    received: true,
  });
  const existing = await findFeedback(env.DB, actor, input.reportUuid, now);
  if (existing) {
    assertSameReport(existing, input);
    return { body: response, replayed: true };
  }
  const today = new Date(now * 1_000).toISOString().slice(0, 10);
  const puzzle = await findPublishedCluePuzzle(env.DB, input.caseId, input.puzzleId, today);
  if (!puzzle || puzzle.version !== input.puzzleVersion) {
    throw new ApiError(404, "CASE_NOT_FOUND", "This puzzle is no longer available.");
  }
  const inserted = await insertFeedback(env.DB, actor, input, puzzle.puzzle_row_id, now);
  if (!(await isSessionActorActive(env.DB, actor, now))) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  const persisted = await findFeedback(env.DB, actor, input.reportUuid, now);
  if (persisted) {
    assertSameReport(persisted, input);
    return { body: response, replayed: !inserted };
  }
  const stillPublished = await findPublishedCluePuzzle(env.DB, input.caseId, input.puzzleId, today);
  if (!stillPublished || stillPublished.version !== input.puzzleVersion) {
    throw new ApiError(404, "CASE_NOT_FOUND", "This puzzle is no longer available.");
  }
  throw new ApiError(429, "RATE_LIMITED", "Up to five reports can be sent in 24 hours.");
}
