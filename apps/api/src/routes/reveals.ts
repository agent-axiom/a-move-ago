import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { getSolvedPuzzleReveal } from "../services/reveal-service";

export function createRevealRoutes(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const reveals = new Hono<AppEnv>();
  reveals.get("/:caseId/puzzles/:puzzleId/reveal", requireSession, async (context) => {
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    z.object({}).strict().parse(context.req.query());
    return context.json(
      await getSolvedPuzzleReveal(
        context.env,
        actor,
        context.req.param("caseId"),
        context.req.param("puzzleId"),
        Math.floor(now().getTime() / 1_000),
        context.req.header("x-content-locales") === "1",
      ),
    );
  });
  return reveals;
}
