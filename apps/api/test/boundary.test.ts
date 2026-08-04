import { Hono } from "hono";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { AppEnv, Env, SessionActor, Variables } from "../src/env";
import { ApiError } from "../src/http/api-error";
import { errorResponse } from "../src/http/error-handler";
import { requestJson } from "../src/http/request-body";
import { exactCors } from "../src/middleware/cors";
import { requestId } from "../src/middleware/request-id";

const boundaryEnv: Env = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  ALLOWED_ORIGINS: " , https://allowed.test, ,",
  SESSION_TTL_SECONDS: "7776000",
  SESSION_PEPPER: "test-session-pepper-at-least-32-bytes",
  GUEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
  ATTEMPT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  HINT_RATE_LIMITER: { limit: async () => ({ success: true }) },
};

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createBoundaryApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", exactCors);
  app.get("/success", (context) => {
    context.header("vary", "Accept-Encoding");
    return context.json({ ok: true });
  });
  app.get("/vary-star", (context) => {
    context.header("vary", "*");
    return context.json({ ok: true });
  });
  app.get("/vary-duplicate", (context) => {
    context.header("vary", "Accept-Encoding, origin, Origin");
    return context.json({ ok: true });
  });
  app.get("/redirect", () => Response.redirect("https://example.test/target", 302));
  app.get("/api-error", () => {
    throw new ApiError(409, "CONFLICT", "Exact conflict.");
  });
  app.get("/zod-error", (context) => {
    z.object({ required: z.string() }).parse({});
    return context.body(null);
  });
  app.post("/malformed-json", async (context) => {
    await requestJson(context);
    return context.body(null);
  });
  app.get("/syntax-error", () => {
    throw new SyntaxError("secret syntax detail");
  });
  app.get("/unknown-error", () => {
    throw new Error("secret error detail");
  });
  app.notFound(() => {
    throw new ApiError(404, "NOT_FOUND", "Resource not found.");
  });
  app.onError(errorResponse);
  return app;
}

async function boundaryRequest(
  path: string,
  init?: RequestInit,
  env = boundaryEnv,
): Promise<Response> {
  return await createBoundaryApp().fetch(new Request(`https://api.test${path}`, init), env);
}

function varyTokens(response: Response): string[] {
  return (response.headers.get("vary") ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

describe("HTTP boundaries", () => {
  it("keeps explicit client failures while sanitizing internal errors", async () => {
    const cases = [
      ["/api-error", 409, "CONFLICT", "Exact conflict."],
      ["/zod-error", 400, "INVALID_REQUEST", "The request is malformed."],
      ["/syntax-error", 500, "INTERNAL_ERROR", "Unexpected server error."],
      ["/unknown-error", 500, "INTERNAL_ERROR", "Unexpected server error."],
    ] as const;

    for (const [path, status, code, message] of cases) {
      const response = await boundaryRequest(path);
      const body = await response.clone().text();
      const contentType = response.headers.get("content-type");
      const requestId = response.headers.get("x-request-id");
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code, message, requestId },
      });
      expect(body).not.toContain("secret");
      expect(contentType).toMatch(/^application\/json/);
      expect(requestId).toMatch(uuidV4);
    }
  });

  it("turns malformed request JSON into the standard client error", async () => {
    const response = await boundaryRequest("/malformed-json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    const requestId = response.headers.get("x-request-id");
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "The request is malformed.",
        requestId,
      },
    });
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(requestId).toMatch(uuidV4);
  });

  it("issues unique UUID v4 request ids on success, errors, not-found, and preflight", async () => {
    const responses = await Promise.all([
      boundaryRequest("/success"),
      boundaryRequest("/api-error"),
      boundaryRequest("/missing"),
      boundaryRequest("/success", {
        method: "OPTIONS",
        headers: { origin: "https://allowed.test" },
      }),
    ]);
    const ids = responses.map((response) => response.headers.get("x-request-id"));

    expect(ids).toHaveLength(4);
    for (const id of ids) expect(id).toMatch(uuidV4);
    expect(new Set(ids).size).toBe(4);
    const [success, apiError, notFound, preflight] = responses;
    if (!success || !apiError || !notFound || !preflight)
      throw new Error("Expected four responses");
    await expect(success.json()).resolves.toEqual({ ok: true });
    for (const response of [apiError, notFound]) {
      const requestId = response.headers.get("x-request-id");
      await expect(response.json()).resolves.toMatchObject({ error: { requestId } });
    }
    await expect(preflight.text()).resolves.toBe("");
  });

  it("varies every Origin response without granting denied origins", async () => {
    const paths = ["/success", "/api-error", "/missing"];
    for (const origin of ["https://allowed.test", "https://allowed.test.evil"] as const) {
      for (const path of paths) {
        const response = await boundaryRequest(path, { headers: { origin } });

        expect(varyTokens(response), `${origin} ${path}`).toContain("origin");
        expect(response.headers.get("access-control-allow-origin")).toBe(
          origin === "https://allowed.test" ? origin : null,
        );
      }
    }
  });

  it("merges Origin into downstream Vary and preserves wildcard Vary", async () => {
    const merged = await boundaryRequest("/success", {
      headers: { origin: "https://allowed.test" },
    });
    const wildcard = await boundaryRequest("/vary-star", {
      headers: { origin: "https://allowed.test" },
    });
    const duplicate = await boundaryRequest("/vary-duplicate", {
      headers: { origin: "https://allowed.test" },
    });

    expect(varyTokens(merged)).toEqual(expect.arrayContaining(["accept-encoding", "origin"]));
    expect(varyTokens(merged).filter((token) => token === "origin")).toHaveLength(1);
    expect(wildcard.headers.get("vary")).toBe("*");
    expect(varyTokens(duplicate).filter((token) => token === "origin")).toHaveLength(1);
  });

  it("preserves immutable redirect responses while applying CORS", async () => {
    const response = await boundaryRequest("/redirect", {
      headers: { origin: "https://allowed.test" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/target");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://allowed.test");
    expect(varyTokens(response)).toContain("origin");
    expect(response.headers.get("x-request-id")).toMatch(uuidV4);
  });

  it("treats missing and blank origin configuration as an empty deny list", async () => {
    const configurations = [
      { ...boundaryEnv, ALLOWED_ORIGINS: undefined },
      { ...boundaryEnv, ALLOWED_ORIGINS: "  ,  " },
    ] as unknown as Env[];

    for (const env of configurations) {
      const response = await boundaryRequest(
        "/success",
        { headers: { origin: "https://allowed.test" } },
        env,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(varyTokens(response)).toContain("origin");
    }
  });

  it("terminates allowed and denied preflight without granting the denied origin", async () => {
    const allowed = await boundaryRequest("/success", {
      method: "OPTIONS",
      headers: { origin: "https://allowed.test" },
    });
    const denied = await boundaryRequest("/success", {
      method: "OPTIONS",
      headers: { origin: "https://allowed.test.evil" },
    });

    for (const response of [allowed, denied]) {
      expect(response.status).toBe(204);
      await expect(response.text()).resolves.toBe("");
      expect(varyTokens(response)).toContain("origin");
    }
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.test");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-headers")).toBeNull();
    expect(denied.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("does not claim an unauthenticated session exists", () => {
    const session: Variables["session"] = undefined;
    expect(session).toBeUndefined();
    expectTypeOf<SessionActor | undefined>().toEqualTypeOf<Variables["session"]>();
  });
});
