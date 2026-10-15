import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { getDailyCase } from "../services/daily-service";

const DailyQuerySchema = z.object({ date: z.iso.date().optional() }).strict();

function invalidQuery(): ApiError {
  return new ApiError(400, "INVALID_REQUEST", "The request is malformed.");
}

function parseQuery(url: string): z.infer<typeof DailyQuerySchema> {
  const parameters = new URL(url).searchParams;
  const entries = [...parameters.entries()];
  if (entries.some(([key]) => key !== "date") || parameters.getAll("date").length > 1) {
    throw invalidQuery();
  }
  return DailyQuerySchema.parse(Object.fromEntries(entries));
}

export interface DailyRouteOptions {
  now?: () => Date;
}

export function createDailyRoutes(options: DailyRouteOptions = {}) {
  const now = options.now ?? (() => new Date());
  const daily = new Hono<AppEnv>();

  daily.get("/", requireSession, async (context) => {
    const query = parseQuery(context.req.url);
    const today = now().toISOString().slice(0, 10);
    const actor = context.get("session");
    if (!actor) throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
    const result = await getDailyCase(
      context.env,
      actor,
      query.date ?? today,
      today,
      context.req.header("x-content-locales") === "1",
      context.req.header("x-game-progress") === "1",
    );
    return context.json(result);
  });

  return daily;
}
