import { MeResponseSchema, StatsResponseSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import { findPlayer, toTelegramProfile } from "../db/players";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { statsForActor } from "../services/stats-service";

export const me = new Hono<AppEnv>();

me.get("/stats", requireSession, async (context) => {
  const session = context.get("session");
  if (!session || (session.kind === "telegram" && !session.playerId)) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  return context.json(
    StatsResponseSchema.parse(await statsForActor(context.env.DB, session, today)),
  );
});

me.get("/", requireSession, async (context) => {
  context.header("cache-control", "no-store");
  const session = context.get("session");
  if (!session) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  if (session.kind === "guest") {
    return context.json(MeResponseSchema.parse({ kind: "guest", profile: null }));
  }
  if (!session.playerId) {
    throw new ApiError(401, "INVALID_SESSION", "Session player does not exist.");
  }

  const player = await findPlayer(context.env.DB, session.playerId);
  if (!player) {
    throw new ApiError(401, "INVALID_SESSION", "Session player does not exist.");
  }

  return context.json(
    MeResponseSchema.parse({
      kind: "telegram",
      profile: toTelegramProfile(player),
    }),
  );
});
