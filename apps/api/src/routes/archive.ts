import { Hono } from "hono";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { getArchiveCatalog } from "../services/archive-service";

export interface ArchiveRouteOptions {
  now?: () => Date;
}

export function createArchiveRoutes(options: ArchiveRouteOptions = {}) {
  const now = options.now ?? (() => new Date());
  const archive = new Hono<AppEnv>();
  archive.get("/", requireSession, async (context) => {
    if (new URL(context.req.url).searchParams.size > 0) {
      throw new ApiError(400, "INVALID_REQUEST", "The request is malformed.");
    }
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    const today = now().toISOString().slice(0, 10);
    return context.json(
      await getArchiveCatalog(
        context.env,
        actor,
        today,
        context.req.header("x-content-locales") === "1",
      ),
    );
  });
  return archive;
}
