import { env } from "cloudflare:workers";
import {
  AttemptResultSchema,
  ErrorEnvelopeSchema,
  HintResponseSchema,
  type Retraction,
  SessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import { withFakeRateLimiters } from "./fake-rate-limiters";
import { openingPuzzleFixture, seedContentFixture } from "./fixtures/content";

const testEnv = withFakeRateLimiters(env as Env);
const injectedNow = new Date("2026-08-03T23:30:00.000Z");
const injectedNowSeconds = Math.floor(injectedNow.getTime() / 1_000);
const app = createApp({ now: () => injectedNow });

type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

const incorrectRetraction: Retraction = {
  currentSquare: "d5",
  previousSquare: "d4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: null,
  special: "normal",
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

async function postAttempt(token: string, correct = false): Promise<string> {
  const result = await requestJson("/v1/attempts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: {
      attemptUuid: crypto.randomUUID(),
      caseId: "case-2026-08-03",
      puzzleId: openingPuzzleFixture.contentKey,
      retraction: correct
        ? structuredClone(openingPuzzleFixture.solution.retraction)
        : structuredClone(incorrectRetraction),
    },
  });
  expect(result.response.status).toBe(201);
  const attempt = AttemptResultSchema.parse(result.body);
  expect(attempt.correct).toBe(correct);
  return attempt.id;
}

async function postHint(token: string, attemptId: string, body: unknown) {
  return await requestJson(`/v1/attempts/${encodeURIComponent(attemptId)}/hints`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

async function expectError(
  result: Awaited<ReturnType<typeof requestJson>>,
  status: number,
  code: string,
) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const envelope = ErrorEnvelopeSchema.parse(result.body);
  expect(envelope.error.code).toBe(code);
  return envelope;
}

async function hintState(attemptId: string): Promise<{ events: number; hintsUsed: number }> {
  const row = await testEnv.DB.prepare(
    `SELECT a.hints_used,
            (SELECT count(*) FROM hint_events he WHERE he.attempt_id = a.id) AS events
       FROM attempts a
      WHERE a.id = ?`,
  )
    .bind(attemptId)
    .first<{ events: number; hints_used: number }>();
  if (!row) throw new Error("Expected attempt fixture");
  return { events: row.events, hintsUsed: row.hints_used };
}

beforeEach(async () => {
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
  await seedContentFixture(testEnv.DB);
});

describe("POST /v1/attempts/:id/hints", () => {
  it("returns and persists the first ordered hint for an incorrect attempt", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);

    const result = await postHint(issued.token, attemptId, { level: 1 });

    expect(result.response.status).toBe(200);
    expect(HintResponseSchema.parse(result.body)).toEqual({
      level: 1,
      text: "A pawn changed files.",
      exhausted: false,
    });
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("replays the exact stored level without creating another event", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    const first = await postHint(issued.token, attemptId, { level: 1 });

    const replay = await postHint(issued.token, attemptId, { level: 1 });

    expect(replay.response.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(HintResponseSchema.parse(replay.body)).toEqual(first.body);
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("rejects skipping directly to level three without mutating the attempt", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);

    const result = await postHint(issued.token, attemptId, { level: 3 });

    await expectError(result, 409, "HINT_OUT_OF_ORDER");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("reports exhaustion only after every stored hint was issued", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    expect((await postHint(issued.token, attemptId, { level: 1 })).response.status).toBe(200);
    expect((await postHint(issued.token, attemptId, { level: 2 })).response.status).toBe(200);

    const exhausted = await postHint(issued.token, attemptId, { level: 3 });

    await expectError(exhausted, 409, "HINTS_EXHAUSTED");
    expect(await hintState(attemptId)).toEqual({ events: 2, hintsUsed: 2 });
  });

  it("rejects hints for an already correct attempt", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token, true);

    const result = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(result, 409, "ATTEMPT_ALREADY_CORRECT");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("does not distinguish another guest's attempt from a missing attempt", async () => {
    const owner = await issueGuest();
    const stranger = await issueGuest();
    const attemptId = await postAttempt(owner.token);

    const otherActor = await postHint(stranger.token, attemptId, { level: 1 });
    const missing = await postHint(stranger.token, crypto.randomUUID(), { level: 1 });

    const otherError = await expectError(otherActor, 404, "ATTEMPT_NOT_FOUND");
    const missingError = await expectError(missing, 404, "ATTEMPT_NOT_FOUND");
    expect(otherError.error.message).toBe(missingError.error.message);
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("lets a new Telegram session access the player's old attempt", async () => {
    const playerId = crypto.randomUUID();
    const firstSessionId = crypto.randomUUID();
    const firstToken = "A".repeat(43);
    const rotatedToken = "B".repeat(43);
    await seedPlayer(playerId, "1001");
    await seedTelegramSession(playerId, firstSessionId, firstToken);
    const attemptId = await postAttempt(firstToken);
    await seedTelegramSession(playerId, crypto.randomUUID(), rotatedToken);
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(firstSessionId).run();

    const stored = await testEnv.DB.prepare("SELECT session_id FROM attempts WHERE id = ?")
      .bind(attemptId)
      .first<{ session_id: string | null }>();
    expect(stored?.session_id).toBeNull();

    const result = await postHint(rotatedToken, attemptId, { level: 1 });

    expect(result.response.status).toBe(200);
    expect(HintResponseSchema.parse(result.body).level).toBe(1);
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("moves hint ownership from a guest session to its merged player", async () => {
    const guest = await issueGuest();
    const attemptId = await postAttempt(guest.token);
    const playerId = crypto.randomUUID();
    const telegramToken = "E".repeat(43);
    await seedPlayer(playerId, "1004");
    await seedTelegramSession(playerId, crypto.randomUUID(), telegramToken);
    await testEnv.DB.prepare("UPDATE attempts SET player_id = ? WHERE id = ?")
      .bind(playerId, attemptId)
      .run();

    const oldGuest = await postHint(guest.token, attemptId, { level: 1 });
    const mergedPlayer = await postHint(telegramToken, attemptId, { level: 1 });

    await expectError(oldGuest, 404, "ATTEMPT_NOT_FOUND");
    expect(mergedPlayer.response.status).toBe(200);
    expect(HintResponseSchema.parse(mergedPlayer.body).level).toBe(1);
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("hides a Telegram player's attempt from a different player", async () => {
    const ownerId = crypto.randomUUID();
    const strangerId = crypto.randomUUID();
    const ownerToken = "C".repeat(43);
    const strangerToken = "D".repeat(43);
    await seedPlayer(ownerId, "1002");
    await seedPlayer(strangerId, "1003");
    await seedTelegramSession(ownerId, crypto.randomUUID(), ownerToken);
    await seedTelegramSession(strangerId, crypto.randomUUID(), strangerToken);
    const attemptId = await postAttempt(ownerToken);

    const result = await postHint(strangerToken, attemptId, { level: 1 });

    await expectError(result, 404, "ATTEMPT_NOT_FOUND");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it.each([
    ["zero", { level: 0 }],
    ["non-integer", { level: 1.5 }],
    ["extra field", { level: 1, reveal: true }],
    ["non-object", "level one"],
  ])("rejects malformed hint input: %s", async (_label, body) => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);

    const result = await postHint(issued.token, attemptId, body);

    await expectError(result, 400, "INVALID_REQUEST");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("rejects a stale session before replaying its stored hint", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    const first = await postHint(issued.token, attemptId, { level: 1 });
    expect(first.response.status).toBe(200);
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ?").bind(injectedNowSeconds).run();

    const replay = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(replay, 401, "INVALID_SESSION");
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("collapses concurrent requests for the same next level to one event", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);

    const results = await Promise.all([
      postHint(issued.token, attemptId, { level: 1 }),
      postHint(issued.token, attemptId, { level: 1 }),
    ]);

    expect(results.map((result) => result.response.status)).toEqual([200, 200]);
    expect(results[0]?.body).toEqual(results[1]?.body);
    expect(results.map((result) => HintResponseSchema.parse(result.body).level)).toEqual([1, 1]);
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("fails closed when a stored puzzle hint violates the response schema", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    await testEnv.DB.prepare(
      "UPDATE puzzle_hints SET payload_json = ? WHERE puzzle_id = ? AND level = 1",
    )
      .bind(JSON.stringify({ level: 1, text: "", exhausted: false }), openingPuzzleFixture.rowId)
      .run();

    const result = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(result, 500, "INTERNAL_ERROR");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("fails closed when a stored puzzle hint level disagrees with its key", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    await testEnv.DB.prepare(
      "UPDATE puzzle_hints SET payload_json = ? WHERE puzzle_id = ? AND level = 1",
    )
      .bind(
        JSON.stringify({ level: 2, text: "Wrong level", exhausted: false }),
        openingPuzzleFixture.rowId,
      )
      .run();

    const result = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(result, 500, "INTERNAL_ERROR");
    expect(await hintState(attemptId)).toEqual({ events: 0, hintsUsed: 0 });
  });

  it("validates the stored event snapshot before replaying it", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    expect((await postHint(issued.token, attemptId, { level: 1 })).response.status).toBe(200);
    await testEnv.DB.prepare(
      "UPDATE hint_events SET hint_json = ? WHERE attempt_id = ? AND hint_level = 1",
    )
      .bind(JSON.stringify({ level: 1, text: "", exhausted: false }), attemptId)
      .run();

    const replay = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(replay, 500, "INTERNAL_ERROR");
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });

  it("fails closed when a replayed event level disagrees with its key", async () => {
    const issued = await issueGuest();
    const attemptId = await postAttempt(issued.token);
    expect((await postHint(issued.token, attemptId, { level: 1 })).response.status).toBe(200);
    await testEnv.DB.prepare(
      "UPDATE hint_events SET hint_json = ? WHERE attempt_id = ? AND hint_level = 1",
    )
      .bind(JSON.stringify({ level: 2, text: "Wrong replay level", exhausted: false }), attemptId)
      .run();

    const replay = await postHint(issued.token, attemptId, { level: 1 });

    await expectError(replay, 500, "INTERNAL_ERROR");
    expect(await hintState(attemptId)).toEqual({ events: 1, hintsUsed: 1 });
  });
});
