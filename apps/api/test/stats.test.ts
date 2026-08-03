import { env } from "cloudflare:workers";
import {
  ErrorEnvelopeSchema,
  SessionIssuedSchema,
  StatsResponseSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import { readStatsSnapshot } from "../src/db/stats";
import type { Env, SessionActor } from "../src/env";
import { streaks } from "../src/services/stats-service";
import {
  makePuzzleFixture,
  type PuzzleFixture,
  seedCasePuzzle,
  seedDailyCase,
  seedPuzzle,
} from "./fixtures/content";

const testEnv = env as Env;
const injectedNow = new Date("2026-08-04T12:00:00.000Z");
const injectedNowSeconds = Math.floor(injectedNow.getTime() / 1_000);
const app = createApp({ now: () => injectedNow });

type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

type AttemptSeed = {
  sessionId: string;
  playerId?: string | null;
  caseId: string;
  puzzleId: string;
  correct: boolean;
  hintsUsed?: number;
};

async function requestJson(path: string, init: JsonRequestInit = {}) {
  const headers = new Headers(init.headers);
  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }
  const response = await app.fetch(new Request(`https://api.test${path}`, requestInit), testEnv);
  return { response, body: (await response.json()) as unknown };
}

async function issueGuest() {
  const result = await requestJson("/v1/sessions/guest", {
    method: "POST",
    body: { channel: "web" },
  });
  expect(result.response.status).toBe(201);
  return SessionIssuedSchema.parse(result.body);
}

async function sessionIdFor(token: string): Promise<string> {
  const row = await testEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(await hashSessionToken(token, testEnv.SESSION_PEPPER))
    .first<{ id: string }>();
  if (!row) throw new Error("Expected session fixture");
  return row.id;
}

async function getStats(token: string) {
  const result = await requestJson("/v1/me/stats", {
    headers: { authorization: `Bearer ${token}` },
  });
  return { ...result, stats: StatsResponseSchema.parse(result.body) };
}

async function seedCase(
  id: string,
  date: string,
  puzzleCount: number,
): Promise<{ caseId: string; puzzles: PuzzleFixture[] }> {
  const dailyCase = await seedDailyCase(testEnv.DB, { id, date, slug: id });
  const puzzles = Array.from({ length: puzzleCount }, (_unused, index) =>
    makePuzzleFixture({
      rowId: `${id}-puzzle-${index + 1}:v1`,
      contentKey: `${id}-puzzle-${index + 1}`,
      title: `${id} puzzle ${index + 1}`,
    }),
  );
  for (const [index, puzzle] of puzzles.entries()) {
    await seedPuzzle(testEnv.DB, puzzle);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, puzzle.rowId, index + 1);
  }
  return { caseId: dailyCase.id, puzzles };
}

async function seedAttempt(input: AttemptSeed): Promise<string> {
  const id = crypto.randomUUID();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      crypto.randomUUID(),
      input.sessionId,
      input.playerId ?? null,
      input.caseId,
      input.puzzleId,
      JSON.stringify({}),
      input.correct ? 1 : 0,
      JSON.stringify({}),
      input.hintsUsed ?? 0,
      injectedNowSeconds,
    )
    .run();
  return id;
}

async function seedPlayer(id: string, telegramUserId: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, telegramUserId, `Player ${telegramUserId}`, injectedNowSeconds, injectedNowSeconds)
    .run();
}

async function seedTelegramSession(
  playerId: string,
  sessionId: string,
  token: string,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO sessions
      (id, player_id, token_hash, kind, channel, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, 'telegram', 'telegram', ?, ?, NULL, ?)`,
  )
    .bind(
      sessionId,
      playerId,
      await hashSessionToken(token, testEnv.SESSION_PEPPER),
      injectedNowSeconds,
      injectedNowSeconds + 86_400,
      injectedNowSeconds,
    )
    .run();
}

async function postCorrectAttempt(
  token: string,
  caseId: string,
  puzzle: PuzzleFixture,
  attemptUuid: string,
) {
  return await requestJson("/v1/attempts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: {
      attemptUuid,
      caseId,
      puzzleId: puzzle.contentKey,
      retraction: structuredClone(puzzle.solution.retraction),
    },
  });
}

async function statsQueryPlan(actor: SessionActor): Promise<string[]> {
  let sql = "";
  let bindings: unknown[] = [];
  const statement = {
    bind(...values: unknown[]) {
      bindings = values;
      return statement;
    },
    async all() {
      return {
        results: [
          {
            attempts: 0,
            hints_used: 0,
            solved_puzzles: 0,
            completed_date: null,
          },
        ],
      };
    },
  };
  const captureDb = {
    prepare(query: string) {
      sql = query;
      return statement;
    },
  } as unknown as D1Database;
  await readStatsSnapshot(captureDb, actor);
  if (!sql) throw new Error("Expected captured stats SQL");
  const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...bindings)
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail);
}

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
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streaks", () => {
  it("deduplicates and sorts dates before finding the best and current runs", () => {
    expect(streaks(["2026-08-04", "2026-08-01", "2026-08-02", "2026-08-01"], "2026-08-04")).toEqual(
      { current: 1, best: 2 },
    );
  });

  it("keeps yesterday active but rejects stale and future final runs", () => {
    expect(streaks(["2026-08-03", "2026-08-04"], "2026-08-05")).toEqual({
      current: 2,
      best: 2,
    });
    expect(streaks(["2026-08-03", "2026-08-04"], "2026-08-06")).toEqual({
      current: 0,
      best: 2,
    });
    expect(streaks(["2099-01-01"], "2026-08-04")).toEqual({ current: 0, best: 1 });
    expect(streaks([], "2026-08-04")).toEqual({ current: 0, best: 0 });
  });

  it("treats leap days and UTC year boundaries as consecutive", () => {
    expect(streaks(["2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-02")).toEqual({
      current: 3,
      best: 3,
    });
    expect(streaks(["2025-12-31", "2026-01-01"], "2026-01-01")).toEqual({
      current: 2,
      best: 2,
    });
  });
});

describe("stats query plan", () => {
  it.each([
    [
      "guest",
      {
        sessionId: "guest-plan-session",
        playerId: null,
        kind: "guest",
        channel: "web",
      } satisfies SessionActor,
      "attempts_session_idx",
    ],
    [
      "Telegram player",
      {
        sessionId: "telegram-plan-session",
        playerId: "plan-player",
        kind: "telegram",
        channel: "telegram",
      } satisfies SessionActor,
      "attempts_player_idx",
    ],
  ] as const)(
    "materializes %s history before probing completed cases",
    async (_label, actor, actorIndex) => {
      const details = await statsQueryPlan(actor);

      expect(details).toContain("MATERIALIZE actor_attempts");
      expect(details).toContain("MATERIALIZE actor_solved");
      expect(
        details.some((detail) => detail.includes(`SEARCH attempts USING INDEX ${actorIndex}`)),
      ).toBe(true);
      expect(details.some((detail) => detail.includes("attempts_case_correct_idx"))).toBe(false);
      expect(details.some((detail) => detail.startsWith("SCAN dc"))).toBe(false);
    },
  );
});

describe("GET /v1/me/stats", () => {
  it("returns schema-validated zero stats for a new authenticated guest", async () => {
    const guest = await issueGuest();

    const result = await getStats(guest.token);

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.stats).toEqual({
      attempts: 0,
      hintsUsed: 0,
      solvedPuzzles: 0,
      completedCases: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
    });
  });

  it("requires an active authenticated session", async () => {
    const response = await requestJson("/v1/me/stats");

    expect(response.response.status).toBe(401);
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    expect(ErrorEnvelopeSchema.parse(response.body).error.code).toBe("INVALID_SESSION");
  });

  it("derives the canonical aggregate from incomplete and complete multi-puzzle cases", async () => {
    const owner = await issueGuest();
    const stranger = await issueGuest();
    const ownerSessionId = await sessionIdFor(owner.token);
    const strangerSessionId = await sessionIdFor(stranger.token);
    const incomplete = await seedCase("case-2026-08-01", "2026-08-01", 2);
    const previous = await seedCase("case-2026-08-02", "2026-08-02", 1);
    const latest = await seedCase("case-2026-08-03", "2026-08-03", 2);
    const [incompleteFirst, incompleteSecond] = incomplete.puzzles;
    const [previousPuzzle] = previous.puzzles;
    const [latestFirst, latestSecond] = latest.puzzles;
    if (!incompleteFirst || !incompleteSecond || !previousPuzzle || !latestFirst || !latestSecond) {
      throw new Error("Expected complete puzzle fixtures");
    }

    await seedAttempt({
      sessionId: ownerSessionId,
      caseId: incomplete.caseId,
      puzzleId: incompleteFirst.rowId,
      correct: false,
      hintsUsed: 1,
    });
    await seedAttempt({
      sessionId: ownerSessionId,
      caseId: previous.caseId,
      puzzleId: previousPuzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId: ownerSessionId,
      caseId: latest.caseId,
      puzzleId: latestFirst.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId: ownerSessionId,
      caseId: latest.caseId,
      puzzleId: latestSecond.rowId,
      correct: false,
      hintsUsed: 1,
    });
    await seedAttempt({
      sessionId: ownerSessionId,
      caseId: latest.caseId,
      puzzleId: latestSecond.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId: strangerSessionId,
      caseId: incomplete.caseId,
      puzzleId: incompleteFirst.rowId,
      correct: true,
      hintsUsed: 9,
    });
    await seedAttempt({
      sessionId: strangerSessionId,
      caseId: incomplete.caseId,
      puzzleId: incompleteSecond.rowId,
      correct: true,
      hintsUsed: 9,
    });

    const result = await getStats(owner.token);

    expect(result.stats).toEqual({
      attempts: 5,
      hintsUsed: 2,
      solvedPuzzles: 3,
      completedCases: 2,
      currentStreak: 2,
      bestStreak: 2,
      lastCompletedDate: "2026-08-03",
    });
  });

  it("counts an idempotent POST replay as one physical attempt", async () => {
    const guest = await issueGuest();
    const dailyCase = await seedCase("case-replay", "2026-08-04", 1);
    const puzzle = dailyCase.puzzles[0];
    if (!puzzle) throw new Error("Expected puzzle fixture");
    const attemptUuid = crypto.randomUUID();

    const created = await postCorrectAttempt(guest.token, dailyCase.caseId, puzzle, attemptUuid);
    const replay = await postCorrectAttempt(guest.token, dailyCase.caseId, puzzle, attemptUuid);
    const result = await getStats(guest.token);

    expect(created.response.status).toBe(201);
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(result.stats).toEqual({
      attempts: 1,
      hintsUsed: 0,
      solvedPuzzles: 1,
      completedCases: 1,
      currentStreak: 1,
      bestStreak: 1,
      lastCompletedDate: "2026-08-04",
    });
  });

  it("counts a reused physical puzzle once while completing each daily case", async () => {
    const guest = await issueGuest();
    const sessionId = await sessionIdFor(guest.token);
    const puzzle = makePuzzleFixture({
      rowId: "reused-puzzle:v1",
      contentKey: "reused-puzzle",
    });
    await seedPuzzle(testEnv.DB, puzzle);
    const firstCase = await seedDailyCase(testEnv.DB, {
      id: "case-reused-first",
      date: "2026-08-03",
      slug: "case-reused-first",
    });
    const secondCase = await seedDailyCase(testEnv.DB, {
      id: "case-reused-second",
      date: "2026-08-04",
      slug: "case-reused-second",
    });
    await seedCasePuzzle(testEnv.DB, firstCase.id, puzzle.rowId);
    await seedCasePuzzle(testEnv.DB, secondCase.id, puzzle.rowId);
    await seedAttempt({
      sessionId,
      caseId: firstCase.id,
      puzzleId: puzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId,
      caseId: secondCase.id,
      puzzleId: puzzle.rowId,
      correct: true,
    });

    const result = await getStats(guest.token);

    expect(result.stats).toEqual({
      attempts: 2,
      hintsUsed: 0,
      solvedPuzzles: 1,
      completedCases: 2,
      currentStreak: 2,
      bestStreak: 2,
      lastCompletedDate: "2026-08-04",
    });
  });

  it("excludes attempts already linked away from the exact guest actor", async () => {
    const guest = await issueGuest();
    const sessionId = await sessionIdFor(guest.token);
    const dailyCase = await seedCase("case-linked-away", "2026-08-04", 1);
    const puzzle = dailyCase.puzzles[0];
    if (!puzzle) throw new Error("Expected puzzle fixture");
    const attemptId = await seedAttempt({
      sessionId,
      caseId: dailyCase.caseId,
      puzzleId: puzzle.rowId,
      correct: true,
      hintsUsed: 2,
    });
    await seedPlayer("linked-player", "3003");
    await testEnv.DB.prepare("UPDATE attempts SET player_id = ? WHERE id = ?")
      .bind("linked-player", attemptId)
      .run();

    const result = await getStats(guest.token);

    expect(result.stats).toEqual({
      attempts: 0,
      hintsUsed: 0,
      solvedPuzzles: 0,
      completedCases: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
    });
  });

  it("uses all player attempts across sessions and nullable origin sessions", async () => {
    const playerId = "player-primary";
    const otherPlayerId = "player-other";
    const firstToken = "A".repeat(43);
    const secondToken = "B".repeat(43);
    const currentToken = "C".repeat(43);
    const otherToken = "D".repeat(43);
    await seedPlayer(playerId, "1001");
    await seedPlayer(otherPlayerId, "2002");
    await seedTelegramSession(playerId, "session-primary-1", firstToken);
    await seedTelegramSession(playerId, "session-primary-2", secondToken);
    await seedTelegramSession(playerId, "session-primary-current", currentToken);
    await seedTelegramSession(otherPlayerId, "session-other", otherToken);
    const dailyCase = await seedCase("case-player", "2026-08-04", 2);
    const [firstPuzzle, secondPuzzle] = dailyCase.puzzles;
    if (!firstPuzzle || !secondPuzzle) throw new Error("Expected puzzle fixtures");

    const detachedAttemptId = await seedAttempt({
      sessionId: "session-primary-1",
      playerId,
      caseId: dailyCase.caseId,
      puzzleId: firstPuzzle.rowId,
      correct: true,
    });
    await testEnv.DB.prepare("UPDATE attempts SET session_id = NULL WHERE id = ?")
      .bind(detachedAttemptId)
      .run();
    await seedAttempt({
      sessionId: "session-primary-2",
      playerId,
      caseId: dailyCase.caseId,
      puzzleId: secondPuzzle.rowId,
      correct: false,
      hintsUsed: 2,
    });
    await seedAttempt({
      sessionId: "session-primary-2",
      playerId,
      caseId: dailyCase.caseId,
      puzzleId: secondPuzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId: "session-other",
      playerId: otherPlayerId,
      caseId: dailyCase.caseId,
      puzzleId: firstPuzzle.rowId,
      correct: true,
      hintsUsed: 7,
    });

    const result = await getStats(currentToken);

    expect(result.stats).toEqual({
      attempts: 3,
      hintsUsed: 2,
      solvedPuzzles: 2,
      completedCases: 1,
      currentStreak: 1,
      bestStreak: 1,
      lastCompletedDate: "2026-08-04",
    });
  });

  it("keeps a future completion out of the current streak", async () => {
    const guest = await issueGuest();
    const sessionId = await sessionIdFor(guest.token);
    const future = await seedCase("case-future", "2099-01-01", 1);
    const puzzle = future.puzzles[0];
    if (!puzzle) throw new Error("Expected puzzle fixture");
    await seedAttempt({
      sessionId,
      caseId: future.caseId,
      puzzleId: puzzle.rowId,
      correct: true,
    });

    const result = await getStats(guest.token);

    expect(result.stats).toEqual({
      attempts: 1,
      hintsUsed: 0,
      solvedPuzzles: 1,
      completedCases: 1,
      currentStreak: 0,
      bestStreak: 1,
      lastCompletedDate: "2099-01-01",
    });
  });

  it("sorts completion dates and handles gaps without duplicate correct inflation", async () => {
    const guest = await issueGuest();
    const sessionId = await sessionIdFor(guest.token);
    const today = await seedCase("case-gap-today", "2026-08-04", 1);
    const oldest = await seedCase("case-gap-oldest", "2026-08-01", 1);
    const consecutive = await seedCase("case-gap-consecutive", "2026-08-02", 1);
    const todayPuzzle = today.puzzles[0];
    const oldestPuzzle = oldest.puzzles[0];
    const consecutivePuzzle = consecutive.puzzles[0];
    if (!todayPuzzle || !oldestPuzzle || !consecutivePuzzle) {
      throw new Error("Expected puzzle fixtures");
    }

    await seedAttempt({
      sessionId,
      caseId: today.caseId,
      puzzleId: todayPuzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId,
      caseId: oldest.caseId,
      puzzleId: oldestPuzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId,
      caseId: consecutive.caseId,
      puzzleId: consecutivePuzzle.rowId,
      correct: true,
    });
    await seedAttempt({
      sessionId,
      caseId: oldest.caseId,
      puzzleId: oldestPuzzle.rowId,
      correct: true,
    });

    const result = await getStats(guest.token);

    expect(result.stats).toEqual({
      attempts: 4,
      hintsUsed: 0,
      solvedPuzzles: 3,
      completedCases: 3,
      currentStreak: 1,
      bestStreak: 2,
      lastCompletedDate: "2026-08-04",
    });
  });
});
