import { env } from "cloudflare:workers";
import {
  AttemptResultSchema,
  DailyCaseResponseSchema,
  HintResponseSchema,
  type Retraction,
  SessionIssuedSchema,
  StatsResponseSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import {
  openingPuzzleFixture,
  privateSolutionMarker,
  seedContentFixture,
} from "./fixtures/content";

class FakeLimiter {
  readonly keys: string[] = [];

  async limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);
    return { success: true };
  }
}

type TestEnv = Env & {
  GUEST_RATE_LIMITER: FakeLimiter;
  ATTEMPT_RATE_LIMITER: FakeLimiter;
  HINT_RATE_LIMITER: FakeLimiter;
};

const workerEnv = env as Env;
const injectedNow = new Date("2026-08-03T23:30:00.000Z");
const app = createApp({ now: () => injectedNow });

function testEnv(): TestEnv {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: workerEnv.ENVIRONMENT,
    ALLOWED_ORIGINS: workerEnv.ALLOWED_ORIGINS,
    SESSION_TTL_SECONDS: workerEnv.SESSION_TTL_SECONDS,
    SESSION_PEPPER: workerEnv.SESSION_PEPPER,
    GUEST_RATE_LIMITER: new FakeLimiter(),
    ATTEMPT_RATE_LIMITER: new FakeLimiter(),
    HINT_RATE_LIMITER: new FakeLimiter(),
  };
}

async function jsonRequest(
  path: string,
  requestEnv: TestEnv,
  init: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.88" });
  if (init.token !== undefined) headers.set("authorization", `Bearer ${init.token}`);
  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }
  const response = await app.fetch(new Request(`https://api.test${path}`, requestInit), requestEnv);
  return { response, body: (await response.json()) as unknown };
}

async function sessionIdFor(token: string): Promise<string> {
  const row = await workerEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(await hashSessionToken(token, workerEnv.SESSION_PEPPER))
    .first<{ id: string }>();
  if (!row) throw new Error("Expected issued session");
  return row.id;
}

const incorrectRetraction: Retraction = {
  currentSquare: "d5",
  previousSquare: "d4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: null,
  special: "normal",
};

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(injectedNow.getTime());
  for (const table of [
    "hint_events",
    "attempts",
    "content_imports",
    "daily_case_puzzles",
    "puzzle_hints",
    "puzzle_solutions",
    "sessions",
    "daily_cases",
    "puzzles",
    "players",
  ]) {
    await workerEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("complete guest gameplay flow", () => {
  it("plays guest to daily to incorrect to hint one to correct to stats without an early reveal", async () => {
    await seedContentFixture(workerEnv.DB);
    const requestEnv = testEnv();
    const session = await jsonRequest("/v1/sessions/guest", requestEnv, {
      method: "POST",
      body: { channel: "web" },
    });
    expect(session.response.status).toBe(201);
    expect(session.response.headers.get("cache-control")).toBe("no-store");
    const issued = SessionIssuedSchema.parse(session.body);
    const sessionId = await sessionIdFor(issued.token);

    const daily = await jsonRequest("/v1/daily?date=2026-08-03", requestEnv, {
      token: issued.token,
    });
    expect(daily.response.status).toBe(200);
    expect(daily.response.headers.get("cache-control")).toBe("no-store");
    expect(DailyCaseResponseSchema.parse(daily.body)).toMatchObject({
      id: "case-2026-08-03",
      date: "2026-08-03",
      puzzles: [openingPuzzleFixture.public],
      solvedPuzzleIds: [],
    });
    const initialDaily = JSON.stringify(daily.body);
    expect(initialDaily).not.toContain("previousFen");
    expect(initialDaily).not.toContain("acceptedSolutions");
    expect(initialDaily).not.toContain(privateSolutionMarker);

    const incorrect = await jsonRequest("/v1/attempts", requestEnv, {
      method: "POST",
      token: issued.token,
      body: {
        attemptUuid: crypto.randomUUID(),
        caseId: "case-2026-08-03",
        puzzleId: openingPuzzleFixture.contentKey,
        retraction: incorrectRetraction,
      },
    });
    expect(incorrect.response.status).toBe(201);
    expect(incorrect.response.headers.get("cache-control")).toBe("no-store");
    const incorrectAttempt = AttemptResultSchema.parse(incorrect.body);
    expect(incorrectAttempt).toMatchObject({ correct: false });

    const hint = await jsonRequest(`/v1/attempts/${incorrectAttempt.id}/hints`, requestEnv, {
      method: "POST",
      token: issued.token,
      body: { level: 1 },
    });
    expect(hint.response.status).toBe(200);
    expect(hint.response.headers.get("cache-control")).toBe("no-store");
    expect(HintResponseSchema.parse(hint.body)).toEqual({
      level: 1,
      text: "A pawn changed files.",
      exhausted: false,
    });

    const correct = await jsonRequest("/v1/attempts", requestEnv, {
      method: "POST",
      token: issued.token,
      body: {
        attemptUuid: crypto.randomUUID(),
        caseId: "case-2026-08-03",
        puzzleId: openingPuzzleFixture.contentKey,
        retraction: openingPuzzleFixture.solution.retraction,
      },
    });
    expect(correct.response.status).toBe(201);
    expect(correct.response.headers.get("cache-control")).toBe("no-store");
    expect(AttemptResultSchema.parse(correct.body)).toMatchObject({
      correct: true,
      reveal: openingPuzzleFixture.solution,
    });

    const stats = await jsonRequest("/v1/me/stats", requestEnv, { token: issued.token });
    expect(stats.response.status).toBe(200);
    expect(stats.response.headers.get("cache-control")).toBe("no-store");
    expect(StatsResponseSchema.parse(stats.body)).toEqual({
      attempts: 2,
      hintsUsed: 1,
      solvedPuzzles: 1,
      completedCases: 1,
      currentStreak: 1,
      bestStreak: 1,
      lastCompletedDate: "2026-08-03",
    });

    expect(requestEnv.GUEST_RATE_LIMITER.keys).toHaveLength(1);
    expect(requestEnv.GUEST_RATE_LIMITER.keys[0]).toMatch(/^guest:[0-9a-f]{64}$/);
    expect(requestEnv.ATTEMPT_RATE_LIMITER.keys).toEqual([
      `attempt:${sessionId}`,
      `attempt:${sessionId}`,
    ]);
    expect(requestEnv.HINT_RATE_LIMITER.keys).toEqual([`hint:${sessionId}`]);
    const limiterKeys = [
      ...requestEnv.GUEST_RATE_LIMITER.keys,
      ...requestEnv.ATTEMPT_RATE_LIMITER.keys,
      ...requestEnv.HINT_RATE_LIMITER.keys,
    ].join("\n");
    expect(limiterKeys).not.toContain(issued.token);
    expect(limiterKeys).not.toContain("203.0.113.88");
  });
});
