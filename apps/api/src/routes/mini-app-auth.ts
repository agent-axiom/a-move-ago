import { TelegramMiniAppAuthRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import { TelegramProofError, verifyMiniAppInitData } from "../auth/telegram-mini-app";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { requireAllowedMutationOrigin } from "../middleware/origin";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { linkGuestToPlayer } from "../services/account-link-service";

export const miniAppAuth = new Hono<AppEnv>();

miniAppAuth.post("/", requireSession, requireAllowedMutationOrigin, async (context) => {
  const guest = context.get("session");
  if (guest?.kind !== "guest" || guest.channel !== "telegram") {
    throw new ApiError(409, "AUTH_CHANNEL_MISMATCH", "Use a Telegram guest session.");
  }

  await enforceLimit(context.env.AUTH_RATE_LIMITER, `auth:${guest.sessionId}`);
  const parsed = TelegramMiniAppAuthRequestSchema.safeParse(await requestJson(context));
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_REQUEST", "The request is malformed.");
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    const identity = await verifyMiniAppInitData(parsed.data.initData, {
      botToken: context.env.TELEGRAM_BOT_TOKEN,
      nowSeconds: now,
      maxAgeSeconds: Number(context.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS),
      futureSkewSeconds: Number(context.env.TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS),
    });
    return context.json(await linkGuestToPlayer(context.env, guest, identity, now));
  } catch (error) {
    if (error instanceof TelegramProofError) {
      throw new ApiError(401, error.code, "Telegram proof is invalid or expired.");
    }
    throw error;
  }
});
