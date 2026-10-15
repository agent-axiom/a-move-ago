import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { requestPuzzleClue } from "../services/gameplay-service";

export function createClueRoutes(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const clues = new Hono<AppEnv>();
  clues.post("/:caseId/puzzles/:puzzleId/clue", requireSession, async (context) => {
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    await enforceLimit(context.env.HINT_RATE_LIMITER, `clue:${actor.sessionId}`);
    z.object({}).strict().parse(await requestJson(context));
    return context.json(
      await requestPuzzleClue(
        context.env,
        actor,
        context.req.param("caseId"),
        context.req.param("puzzleId"),
        Math.floor(now().getTime() / 1_000),
        context.req.header("x-content-locales") === "1",
      ),
    );
  });
  return clues;
}
