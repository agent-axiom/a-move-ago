import { createMiddleware } from "hono/factory";
import { hashSessionToken } from "../crypto/opaque-token";
import { findActiveSession } from "../db/sessions";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";

const bearerToken = /^Bearer ([A-Za-z0-9_-]{43})$/;

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
}

export const requireSession = createMiddleware<AppEnv>(async (context, next) => {
  context.header("cache-control", "no-store");
  const token = bearerToken.exec(context.req.header("authorization") ?? "")?.[1];
  if (!token) throw invalidSession();

  const tokenHash = await hashSessionToken(token, context.env.SESSION_PEPPER);
  const row = await findActiveSession(context.env.DB, tokenHash, Math.floor(Date.now() / 1000));
  if (!row) throw invalidSession();

  context.set("session", {
    sessionId: row.id,
    playerId: row.player_id,
    kind: row.kind,
    channel: row.channel,
  });
  await next();
});
