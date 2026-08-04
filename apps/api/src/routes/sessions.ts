import { GuestSessionRequestSchema } from "@a-move-ago/api-contract";
import { type Context, Hono } from "hono";
import type { AppEnv, Env, Variables } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { enforceLimit, guestLimitKey } from "../middleware/rate-limit";
import { issueGuest, logoutToGuest } from "../services/session-service";

export const sessions = new Hono<AppEnv>();

sessions.post("/guest", async (context) => {
  context.header("cache-control", "no-store");
  await enforceLimit(
    context.env.GUEST_RATE_LIMITER,
    await guestLimitKey(context.req.header("cf-connecting-ip"), context.env.SESSION_PEPPER),
  );
  const input = GuestSessionRequestSchema.parse(await requestJson(context));
  const result = await issueGuest(context.env, input.channel, Math.floor(Date.now() / 1000));
  return context.json(result, 201);
});

export const logoutHandler = async (context: Context<{ Bindings: Env; Variables: Variables }>) => {
  context.header("cache-control", "no-store");
  const session = context.get("session");
  if (!session) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  const result = await logoutToGuest(context.env, session, Math.floor(Date.now() / 1000));
  return context.json(result);
};
