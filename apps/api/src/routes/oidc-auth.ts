import { OidcStartRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import { z } from "zod";
import { resolveAuthReturnTarget } from "../auth/return-target";
import type { TelegramOidcProvider } from "../auth/telegram-oidc";
import { hashOpaqueToken } from "../crypto/opaque-token";
import { claimAuthFlow } from "../db/auth-flows";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requestJson } from "../http/request-body";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { completeOidcCallback, fixedReturnUrl, startOidcFlow } from "../services/oidc-service";

const oidcStartRoutes = new Hono<AppEnv>();

const CallbackQuerySchema = z.union([
  z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      error: z.string().min(1).max(256),
      error_description: z.string().max(2048).optional(),
    })
    .strict(),
]);

function parseCallbackQuery(url: string): z.infer<typeof CallbackQuerySchema> {
  const parsedUrl = new URL(url);
  if (parsedUrl.search.length > 8192) {
    throw new ApiError(400, "OIDC_CALLBACK_INVALID", "Invalid OIDC callback.");
  }
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [key, value] of parsedUrl.searchParams) {
    if (seen.has(key)) {
      throw new ApiError(400, "OIDC_CALLBACK_INVALID", "Invalid OIDC callback.");
    }
    seen.add(key);
    values[key] = value;
  }
  const parsed = CallbackQuerySchema.safeParse(values);
  if (!parsed.success) {
    throw new ApiError(400, "OIDC_CALLBACK_INVALID", "Invalid OIDC callback.");
  }
  return parsed.data;
}

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

export function createTelegramOidcRoutes(provider: TelegramOidcProvider) {
  const router = new Hono<AppEnv>();
  router.route("/", oidcStartRoutes);

  router.get("/callback", async (context) => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    const parsed = parseCallbackQuery(context.req.url);
    resolveAuthReturnTarget(context.env, "web");
    resolveAuthReturnTarget(context.env, "android");
    const now = Math.floor(Date.now() / 1000);
    if ("error" in parsed) {
      const stateHash = await hashOpaqueToken(
        parsed.state,
        context.env.SESSION_PEPPER,
        "oidc-state",
      );
      const flow = await claimAuthFlow(context.env.DB, stateHash, now);
      if (!flow) {
        throw new ApiError(400, "OIDC_STATE_INVALID", "OIDC state is invalid or expired.");
      }
      return context.redirect(
        fixedReturnUrl(context.env, flow.channel, { authError: "access_denied" }),
        302,
      );
    }

    const location = await completeOidcCallback({
      env: context.env,
      provider,
      state: parsed.state,
      code: parsed.code,
      now,
    });
    return context.redirect(location, 302);
  });

  return router;
}
