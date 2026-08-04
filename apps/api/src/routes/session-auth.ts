import { HandoffExchangeRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { requireSession } from "../middleware/session";
import { exchangeOidcHandoff } from "../services/oidc-service";
import { logoutToGuest } from "../services/session-service";

export const sessionAuthRoutes = new Hono<AppEnv>();

sessionAuthRoutes.post("/logout", requireSession, async (context) => {
  context.header("cache-control", "no-store");
  const session = context.get("session");
  if (!session) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  return context.json(await logoutToGuest(context.env, session, Math.floor(Date.now() / 1000)));
});

sessionAuthRoutes.post("/session/exchange", requireSession, async (context) => {
  context.header("cache-control", "no-store");
  const session = context.get("session");
  if (!session) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  const parsed = HandoffExchangeRequestSchema.safeParse(await requestJson(context));
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_REQUEST", "Invalid request body.");
  }
  return context.json(
    await exchangeOidcHandoff(
      context.env,
      session,
      parsed.data.handoffCode,
      Math.floor(Date.now() / 1000),
    ),
  );
});
