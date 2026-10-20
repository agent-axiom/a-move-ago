import { FeedbackRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { requireAllowedMutationOrigin } from "../middleware/origin";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { submitPuzzleFeedback } from "../services/feedback-service";

export function createFeedbackRoutes(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const feedback = new Hono<AppEnv>();
  feedback.post(
    "/",
    requireSession,
    requireAllowedMutationOrigin,
    bodyLimit({
      maxSize: 8_192,
      onError: () => {
        throw new ApiError(400, "INVALID_REQUEST", "The report is too large.");
      },
    }),
    async (context) => {
      const actor = context.get("session");
      if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
      await enforceLimit(context.env.HINT_RATE_LIMITER, `feedback:${actor.sessionId}`);
      const input = FeedbackRequestSchema.parse(await requestJson(context));
      const result = await submitPuzzleFeedback(
        context.env,
        actor,
        input,
        Math.floor(now().getTime() / 1_000),
      );
      if (result.replayed) context.header("idempotency-replayed", "true");
      return context.json(result.body, result.replayed ? 200 : 201);
    },
  );
  return feedback;
}
