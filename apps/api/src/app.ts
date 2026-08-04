import { Hono } from "hono";
import { type TelegramOidcProvider, telegramOidcProvider } from "./auth/telegram-oidc";
import type { AppEnv } from "./env";
import { ApiError } from "./http/api-error";
import { errorResponse } from "./http/error-handler";
import { exactCors } from "./middleware/cors";
import { requestId } from "./middleware/request-id";
import { structuredLog } from "./middleware/structured-log";
import { createAttemptRoutes } from "./routes/attempts";
import { createDailyRoutes } from "./routes/daily";
import { me } from "./routes/me";
import { miniAppAuth } from "./routes/mini-app-auth";
import { createTelegramOidcRoutes } from "./routes/oidc-auth";
import { sessionAuthRoutes } from "./routes/session-auth";
import { sessions } from "./routes/sessions";

export interface AppOptions {
  now?: () => Date;
  oidcProvider?: TelegramOidcProvider;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", requestId);
  app.use("*", structuredLog);
  app.use("*", exactCors);

  app.get("/v1/healthz", (context) => context.json({ ok: true }));
  app.route("/v1/sessions", sessions);
  app.route("/v1/auth", sessionAuthRoutes);
  app.route("/v1/auth/telegram/mini-app", miniAppAuth);
  app.route(
    "/v1/auth/telegram/oidc",
    createTelegramOidcRoutes(options.oidcProvider ?? telegramOidcProvider),
  );
  app.route("/v1/daily", createDailyRoutes(options.now ? { now: options.now } : {}));
  app.route("/v1/attempts", createAttemptRoutes(options.now ? { now: options.now } : {}));
  app.route("/v1/me", me);

  app.notFound(() => {
    throw new ApiError(404, "NOT_FOUND", "Resource not found.");
  });

  app.onError(errorResponse);
  return app;
}

export const app = createApp();
