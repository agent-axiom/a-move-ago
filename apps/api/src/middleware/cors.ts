import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

function allowedOrigins(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

function mergedOriginVary(value: string | null): string | undefined {
  const tokens = (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.some((token) => token === "*")) return undefined;
  let hasOrigin = false;
  const merged = tokens.filter((token) => {
    if (token.toLowerCase() !== "origin") return true;
    if (hasOrigin) return false;
    hasOrigin = true;
    return true;
  });
  if (!hasOrigin) merged.push("Origin");
  return merged.join(", ");
}

function applyCorsHeaders(context: Context<AppEnv>): void {
  const origin = context.req.header("Origin");
  if (origin !== undefined && allowedOrigins(context.env.ALLOWED_ORIGINS).has(origin)) {
    context.header("access-control-allow-origin", origin);
    context.header("access-control-allow-headers", "authorization,content-type,x-content-locales,x-game-progress");
    context.header("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  }
  if (context.req.raw.headers.has("Origin")) {
    const vary = mergedOriginVary(context.res.headers.get("vary"));
    if (vary !== undefined) context.header("vary", vary);
  }
}

export const exactCors = createMiddleware<AppEnv>(async (context, next) => {
  if (context.req.method === "OPTIONS") {
    applyCorsHeaders(context);
    return context.body(null, 204);
  }
  try {
    await next();
  } finally {
    applyCorsHeaders(context);
  }
});
