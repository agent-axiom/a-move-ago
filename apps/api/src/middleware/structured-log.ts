import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import type { AppEnv } from "../env";

export const structuredLog = createMiddleware<AppEnv>(async (context, next) => {
  const startedAt = performance.now();
  try {
    await next();
  } finally {
    try {
      console.log(
        JSON.stringify({
          requestId: context.get("requestId"),
          method: context.req.method,
          route: routePath(context),
          status: context.res.status,
          durationMs: Math.max(0, Math.round((performance.now() - startedAt) * 1_000) / 1_000),
          sessionKind: context.get("session")?.kind ?? "none",
        }),
      );
    } catch {
      // Logging is best-effort and must not change the response boundary.
    }
  }
});
