import { GuestSessionRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requestJson } from "../http/request-body";
import { enforceLimit, guestLimitKey } from "../middleware/rate-limit";
import { issueGuest } from "../services/session-service";

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
