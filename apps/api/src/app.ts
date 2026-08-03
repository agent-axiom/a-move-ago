import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError } from "./http/api-error";
import { errorResponse } from "./http/error-handler";
import { exactCors } from "./middleware/cors";
import { requestId } from "./middleware/request-id";
import { requireSession } from "./middleware/session";
import { me } from "./routes/me";
import { logoutHandler, sessions } from "./routes/sessions";

export const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", exactCors);

app.get("/v1/healthz", (context) => context.json({ ok: true }));
app.route("/v1/sessions", sessions);
app.post("/v1/auth/logout", requireSession, logoutHandler);
app.route("/v1/me", me);

app.notFound(() => {
  throw new ApiError(404, "NOT_FOUND", "Resource not found.");
});

app.onError(errorResponse);
