import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError } from "./http/api-error";
import { errorResponse } from "./http/error-handler";
import { exactCors } from "./middleware/cors";
import { requestId } from "./middleware/request-id";

export const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", exactCors);

app.get("/v1/healthz", (context) => context.json({ ok: true }));

app.notFound(() => {
  throw new ApiError(404, "NOT_FOUND", "Resource not found.");
});

app.onError(errorResponse);
