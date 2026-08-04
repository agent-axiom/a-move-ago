import { OidcStartRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { startOidcFlow } from "../services/oidc-service";

export const oidcStartRoutes = new Hono<AppEnv>();

oidcStartRoutes.post("/start", requireSession, async (context) => {
  const guest = context.get("session");
  if (!guest) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  await enforceLimit(context.env.AUTH_RATE_LIMITER, `auth:${guest.sessionId}`);
  const parsed = OidcStartRequestSchema.safeParse(await requestJson(context));
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_REQUEST", "The request is malformed.");
  }
  return context.json(
    await startOidcFlow(context.env, guest, parsed.data.channel, Math.floor(Date.now() / 1000)),
  );
});
