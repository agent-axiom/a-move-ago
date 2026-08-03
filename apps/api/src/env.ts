export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SECONDS: string;
  SESSION_PEPPER: string;
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
