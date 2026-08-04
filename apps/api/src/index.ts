import { app } from "./app";
import type { Env } from "./env";
import { cleanupExpired } from "./scheduled";

export default {
  fetch: app.fetch,
  scheduled(_event, env, context) {
    context.waitUntil(cleanupExpired(env, Math.floor(Date.now() / 1_000)));
  },
} satisfies ExportedHandler<Env>;
