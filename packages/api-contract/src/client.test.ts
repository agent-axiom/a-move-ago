import { describe, expect, it, vi } from "vitest";
import { ApiContractError, ApiError, ApiTransportError, createApiClient } from "./client";

const session = {
  token: "x".repeat(43),
  expiresAt: "2026-11-01T00:00:00.000Z",
  kind: "guest" as const,
};

const attemptRequest = {
  attemptUuid: "22222222-2222-4222-8222-222222222222",
  caseId: "case-2026-08-03",
  puzzleId: "opening-exd5",
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
} as const;

function errorResponse(retryAfter?: string) {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Slow down.", requestId: "req-1" } },
    {
      status: 429,
      ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
    },
  );
}

function responseWithJsonFailure(error: unknown, status = 200) {
  const response = new Response(null, { status });
  vi.spyOn(response, "json").mockRejectedValue(error);
  return response;
}

describe("ApiClient", () => {
  it("issues an anonymous guest session with the selected channel", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(session, { status: 201 }));
    const getToken = vi.fn(() => null);
    const api = createApiClient({
      baseUrl: "https://api.test/",
      fetch,
      getToken,
    });

    await expect(api.createGuest("web")).resolves.toEqual(session);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/sessions/guest",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ channel: "web" }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("reuses the exact attempt UUID in the serialized request", async () => {
    const result = {
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: attemptRequest.attemptUuid,
      correct: false as const,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another retraction." },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(result, { status: 201 }));
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest-token",
    });

    await expect(api.submitAttempt(attemptRequest)).resolves.toEqual(result);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer guest-token" });
    expect(JSON.parse(String(init.body))).toEqual(attemptRequest);
  });

  it("maps a validated error envelope to ApiError", async () => {
    const denied = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: "INVALID_SESSION", message: "Expired.", requestId: "req-1" } },
          { status: 401 },
        ),
      );
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: denied,
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toEqual(
      new ApiError(401, "INVALID_SESSION", "Expired.", "req-1", null),
    );
  });

  it("wraps fetch failures as ApiTransportError", async () => {
    const failure = new TypeError("Failed to fetch");
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockRejectedValue(failure),
      getToken: () => "x",
    });

    const caught = await api.getMe().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiTransportError);
    expect((caught as ApiTransportError).cause).toBe(failure);
  });

  it("passes AbortError through unchanged", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockRejectedValue(abortError),
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toBe(abortError);
  });

  it("passes a response body AbortError through unchanged", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockResolvedValue(responseWithJsonFailure(abortError)),
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toBe(abortError);
  });

  it("wraps a response body read failure as ApiTransportError", async () => {
    const failure = new TypeError("The response body stream was interrupted.");
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockResolvedValue(responseWithJsonFailure(failure)),
      getToken: () => "x",
    });

    const caught = await api.getMe().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ApiTransportError);
    expect((caught as ApiTransportError).cause).toBe(failure);
  });

  it.each([
    [
      "a malformed JSON SyntaxError",
      () => responseWithJsonFailure(new SyntaxError("Unexpected end of JSON input")),
    ],
    ["a parsed null payload", () => Response.json(null)],
  ])("rejects %s from a successful response as ApiContractError", async (_label, response) => {
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockResolvedValue(response()),
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects malformed JSON from an error response as ApiContractError", async () => {
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockResolvedValue(new Response("{", { status: 502 })),
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toBeInstanceOf(ApiContractError);
  });

  it("parses retry-after only when it contains decimal digits", async () => {
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockResolvedValue(errorResponse("120")),
      getToken: () => "x",
    });

    await expect(api.getMe()).rejects.toEqual(
      new ApiError(429, "RATE_LIMITED", "Slow down.", "req-1", 120),
    );
  });

  it.each(["1.5", "+120", "120 seconds", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "rejects non-digit retry-after value %j",
    async (retryAfter) => {
      const api = createApiClient({
        baseUrl: "https://api.test",
        fetch: vi.fn().mockResolvedValue(errorResponse(retryAfter)),
        getToken: () => "x",
      });

      await expect(api.getMe()).rejects.toEqual(
        new ApiError(429, "RATE_LIMITED", "Slow down.", "req-1", null),
      );
    },
  );

  it("rejects an authenticated call with no token before fetching", async () => {
    const fetch = vi.fn();
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => null,
    });

    await expect(api.getMe()).rejects.toEqual(
      new ApiError(401, "MISSING_SESSION", "No app session is available.", "client", null),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a validly shaped response for a different attempt UUID", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          id: "11111111-1111-4111-8111-111111111111",
          attemptUuid: "33333333-3333-4333-8333-333333333333",
          correct: false,
          contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try again." },
        },
        { status: 201 },
      ),
    );
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest",
    });

    await expect(api.submitAttempt(attemptRequest)).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects a validly shaped hint response for a different level", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ level: 2, text: "A pawn changed files.", exhausted: false }),
      );
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest",
    });

    await expect(api.requestHint("attempt/with spaces", 1)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/attempts/attempt%2Fwith%20spaces/hints",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ level: 1 }) }),
    );
  });
});
