import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

export const requestId = createMiddleware<AppEnv>(async (context, next) => {
  const id = crypto.randomUUID();
  context.set("requestId", id);
  await next();
  context.header("x-request-id", id);
});
