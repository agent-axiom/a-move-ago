import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";

export const requireAllowedMutationOrigin = createMiddleware<AppEnv>(async (context, next) => {
  const origin = context.req.header("origin");
  if (origin !== undefined) {
    const allowed = new Set(
      context.env.ALLOWED_ORIGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    if (!allowed.has(origin)) {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed.");
    }
  }
  await next();
});
