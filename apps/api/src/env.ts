export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SECONDS: string;
  SESSION_PEPPER: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_OIDC_CLIENT_ID: string;
  TELEGRAM_OIDC_CLIENT_SECRET: string;
  TELEGRAM_OIDC_CALLBACK_URL: string;
  API_ORIGIN: string;
  WEB_AUTH_RETURN_URL: string;
  ANDROID_AUTH_RETURN_URL: string;
  ANDROID_PACKAGE_NAME: string;
  ANDROID_SHA256_CERT_FINGERPRINTS: string;
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: string;
  TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS: string;
  OIDC_FLOW_TTL_SECONDS: string;
  HANDOFF_TTL_SECONDS: string;
  GUEST_RATE_LIMITER: RateLimitBinding;
  ATTEMPT_RATE_LIMITER: RateLimitBinding;
  HINT_RATE_LIMITER: RateLimitBinding;
  AUTH_RATE_LIMITER: RateLimitBinding;
}

export interface SessionActor {
  sessionId: string;
  playerId: string | null;
  kind: "guest" | "telegram";
  channel: "web" | "telegram" | "android";
}

export interface Variables {
  requestId: string;
  session: SessionActor | undefined;
}

export type AppEnv = {
  Bindings: Env;
  Variables: Variables;
};
