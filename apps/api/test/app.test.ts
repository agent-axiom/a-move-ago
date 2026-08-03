import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("API Worker", () => {
  it("serves the health check with a request id", async () => {
    const response = await exports.default.fetch("https://api.test/v1/healthz");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns the request id in the not-found error envelope", async () => {
    const response = await exports.default.fetch("https://api.test/nope");
    const requestId = response.headers.get("x-request-id");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
        requestId,
      },
    });
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("allows only exact configured CORS origins", async () => {
    const allowed = await exports.default.fetch("https://api.test/v1/healthz", {
      headers: { origin: "https://agent-axiom.github.io" },
    });
    const lookalike = await exports.default.fetch("https://api.test/v1/healthz", {
      headers: { origin: "https://agent-axiom.github.io.evil.test" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://agent-axiom.github.io",
    );
    expect(lookalike.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("terminates allowed and denied CORS preflight requests", async () => {
    const allowed = await exports.default.fetch("https://api.test/v1/healthz", {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io" },
    });
    const denied = await exports.default.fetch("https://api.test/v1/healthz", {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io.evil.test" },
    });

    expect(allowed.status).toBe(204);
    await expect(allowed.text()).resolves.toBe("");
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://agent-axiom.github.io",
    );
    expect(denied.status).toBe(204);
    await expect(denied.text()).resolves.toBe("");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
