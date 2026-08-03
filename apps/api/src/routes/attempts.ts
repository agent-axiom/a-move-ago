import { AttemptRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { requireSession } from "../middleware/session";
import { submitAttempt } from "../services/attempt-service";

export interface AttemptRouteOptions {
  now?: () => Date;
}

export function createAttemptRoutes(options: AttemptRouteOptions = {}) {
  const now = options.now ?? (() => new Date());
  const attempts = new Hono<AppEnv>();

  attempts.post("/", requireSession, async (context) => {
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    const input = AttemptRequestSchema.parse(await requestJson(context));
    const timestamp = Math.floor(now().getTime() / 1_000);
    const result = await submitAttempt(context.env, actor, input, timestamp);
    if (result.replayed) context.header("idempotency-replayed", "true");
    return context.json(result.body, result.replayed ? 200 : 201);
  });

  return attempts;
}
