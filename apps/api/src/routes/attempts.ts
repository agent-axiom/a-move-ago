import { AttemptRequestSchema, HintRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { submitAttempt } from "../services/attempt-service";
import { requestHint } from "../services/hint-service";

export interface AttemptRouteOptions {
  now?: () => Date;
}

export function createAttemptRoutes(options: AttemptRouteOptions = {}) {
  const now = options.now ?? (() => new Date());
  const attempts = new Hono<AppEnv>();

  attempts.post("/", requireSession, async (context) => {
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    await enforceLimit(context.env.ATTEMPT_RATE_LIMITER, `attempt:${actor.sessionId}`);
    const input = AttemptRequestSchema.parse(await requestJson(context));
    const timestamp = Math.floor(now().getTime() / 1_000);
    const result = await submitAttempt(
      context.env,
      actor,
      input,
      timestamp,
      context.req.header("x-content-locales") === "1",
      context.req.header("x-game-progress") === "1",
    );
    if (result.replayed) context.header("idempotency-replayed", "true");
    return context.json(result.body, result.replayed ? 200 : 201);
  });

  attempts.post("/:attemptId/hints", requireSession, async (context) => {
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    await enforceLimit(context.env.HINT_RATE_LIMITER, `hint:${actor.sessionId}`);
    const input = HintRequestSchema.parse(await requestJson(context));
    const timestamp = Math.floor(now().getTime() / 1_000);
    const hint = await requestHint(
      context.env,
      actor,
      context.req.param("attemptId"),
      input.level,
      timestamp,
      context.req.header("x-content-locales") === "1",
      context.req.header("x-game-progress") === "1",
    );
    return context.json(hint);
  });

  return attempts;
}
