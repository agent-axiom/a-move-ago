import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

export const structuredLog = createMiddleware<AppEnv>(async (context, next) => {
  try {
    await next();
  } finally {
    try {
      console.log(
        JSON.stringify({
          requestId: context.get("requestId"),
          method: context.req.method,
          path: context.req.path,
          status: context.res.status,
          sessionKind: context.get("session")?.kind ?? "none",
        }),
      );
    } catch {
      // Logging is best-effort and must not change the response boundary.
    }
  }
});
