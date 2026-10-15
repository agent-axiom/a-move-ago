import { env } from "cloudflare:workers";
import {
  DailyCaseResponseSchema,
  ErrorEnvelopeSchema,
  SessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import { publicPuzzleId } from "../src/db/puzzle-identity";
import type { Env } from "../src/env";
import { withFakeRateLimiters } from "./fake-rate-limiters";
import {
  makePuzzleFixture,
  openingPuzzleFixture,
  privateSolutionMarker,
  seedCasePuzzle,
  seedContentFixture,
  seedDailyCase,
  seedPuzzle,
} from "./fixtures/content";

const testEnv = withFakeRateLimiters(env as Env);
const injectedNow = new Date("2026-08-03T23:30:00.000Z");
const app = createApp({ now: () => injectedNow });

type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
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

async function authenticatedJson(path: string, token: string) {
  return await requestJson(path, { headers: { authorization: `Bearer ${token}` } });
}

async function issueGuest(channel: "web" | "telegram" | "android" = "web") {
  const issued = await requestJson("/v1/sessions/guest", {
    method: "POST",
    body: { channel },
  });
  expect(issued.response.status).toBe(201);
  return SessionIssuedSchema.parse(issued.body);
}

async function sessionIdFor(token: string): Promise<string> {
  const tokenHash = await hashSessionToken(token, testEnv.SESSION_PEPPER);
  const row = await testEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!row) throw new Error("Expected session fixture");
  return row.id;
}

async function insertAttempt(options: {
  sessionId: string;
  playerId?: string | null;
  caseId: string;
  puzzleRowId: string;
  correct: boolean;
  attemptUuid?: string;
}) {
  const id = crypto.randomUUID();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?)`,
  )
    .bind(
      id,
      options.attemptUuid ?? crypto.randomUUID(),
      options.sessionId,
      options.playerId ?? null,
      options.caseId,
      options.puzzleRowId,
      options.correct ? 1 : 0,
      Math.floor(injectedNow.getTime() / 1_000),
    )
    .run();
}

async function expectDailyNotFound(path: string, token: string) {
  const result = await authenticatedJson(path, token);
  expect(result.response.status).toBe(404);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("DAILY_NOT_FOUND");
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
});

describe("GET /v1/daily", () => {
  it("serves an authenticated, ordered public projection without private solution data", async () => {
    const dailyCase = await seedDailyCase(testEnv.DB);
    const secondPuzzle = makePuzzleFixture({
      rowId: "quiet-a4:v1",
      contentKey: "quiet-a4",
      title: "The quiet clue",
    });
    await seedPuzzle(testEnv.DB, openingPuzzleFixture);
    await seedPuzzle(testEnv.DB, secondPuzzle);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, openingPuzzleFixture.rowId, 2);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, secondPuzzle.rowId, 1);
    const token = (await issueGuest()).token;

    const result = await authenticatedJson("/v1/daily?date=2026-08-03", token);
    const serialized = JSON.stringify(result.body);

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(DailyCaseResponseSchema.parse(result.body)).toEqual({
      id: dailyCase.id,
      date: "2026-08-03",
      title: "Daily case",
      puzzles: [
        {
          ...secondPuzzle.public,
          id: publicPuzzleId(dailyCase.id, 1, 1),
          title: "Puzzle 1",
          prompt: "Reconstruct the last move.",
        },
        {
          ...openingPuzzleFixture.public,
          id: publicPuzzleId(dailyCase.id, 2, 1),
          title: "Puzzle 2",
          prompt: "Reconstruct the last move.",
        },
      ],
      solvedPuzzleIds: [],
    });
    expect(serialized).not.toContain("acceptedSolutions");
    expect(serialized).not.toContain("previousFen");
    expect(serialized).not.toContain(privateSolutionMarker);
    for (const hidden of [
      dailyCase.title,
      secondPuzzle.public.title,
      secondPuzzle.contentKey,
      openingPuzzleFixture.contentKey,
      openingPuzzleFixture.public.prompt,
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("uses the injected UTC date by default and serves a published past archive", async () => {
    await seedContentFixture(testEnv.DB);
    await seedContentFixture(testEnv.DB, {
      id: "case-2026-08-01",
      date: "2026-08-01",
      slug: "archive-2026-08-01",
      puzzle: makePuzzleFixture({ rowId: "archive:v1", contentKey: "archive" }),
    });
    const token = (await issueGuest()).token;

    const today = await authenticatedJson("/v1/daily", token);
    const archive = await authenticatedJson("/v1/daily?date=2026-08-01", token);

    expect(today.response.status).toBe(200);
    expect(DailyCaseResponseSchema.parse(today.body).date).toBe("2026-08-03");
    expect(archive.response.status).toBe(200);
    expect(DailyCaseResponseSchema.parse(archive.body).date).toBe("2026-08-01");
  });

  it("requires a valid session", async () => {
    await seedContentFixture(testEnv.DB);

    const result = await requestJson("/v1/daily?date=2026-08-03");

    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INVALID_SESSION");
  });

  it("strictly rejects malformed, duplicate, and extra query parameters", async () => {
    const token = (await issueGuest()).token;
    const paths = [
      "/v1/daily?date=2026-8-03",
      "/v1/daily?date=2026-02-30",
      "/v1/daily?date=%202026-08-03",
      "/v1/daily?date=2026-08-03&date=2026-08-02",
      "/v1/daily?date=2026-08-03&preview=true",
      "/v1/daily?preview=true",
    ];

    for (const path of paths) {
      const result = await authenticatedJson(path, token);
      expect(result.response.status, path).toBe(400);
      expect(result.response.headers.get("cache-control"), path).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(result.body).error.code, path).toBe("INVALID_REQUEST");
    }
  });

  it("hides future content even when it is already marked published", async () => {
    await seedContentFixture(testEnv.DB, {
      id: "case-2026-08-04",
      date: "2026-08-04",
      slug: "future-2026-08-04",
      puzzle: makePuzzleFixture({ rowId: "future:v1", contentKey: "future" }),
    });
    const token = (await issueGuest()).token;

    await expectDailyNotFound("/v1/daily?date=2026-08-04", token);
  });

  it("hides non-published cases and refuses empty, unpublished, or partially published cases", async () => {
    await seedContentFixture(testEnv.DB, {
      id: "draft-case",
      date: "2026-07-29",
      slug: "draft-case",
      status: "draft",
      puzzle: makePuzzleFixture({ rowId: "draft-case-puzzle:v1", contentKey: "draft-case-puzzle" }),
    });
    await seedContentFixture(testEnv.DB, {
      id: "retired-case",
      date: "2026-07-30",
      slug: "retired-case",
      status: "retired",
      puzzle: makePuzzleFixture({
        rowId: "retired-case-puzzle:v1",
        contentKey: "retired-case-puzzle",
      }),
    });
    const mixedCase = await seedDailyCase(testEnv.DB, {
      id: "mixed-case",
      date: "2026-07-31",
      slug: "mixed-case",
    });
    const mixedPublished = makePuzzleFixture({
      rowId: "mixed-published:v1",
      contentKey: "mixed-published",
    });
    const mixedDraft = makePuzzleFixture({
      rowId: "mixed-draft:v1",
      contentKey: "mixed-draft",
    });
    await seedPuzzle(testEnv.DB, mixedPublished);
    await seedPuzzle(testEnv.DB, mixedDraft, { status: "draft" });
    await seedCasePuzzle(testEnv.DB, mixedCase.id, mixedPublished.rowId, 1);
    await seedCasePuzzle(testEnv.DB, mixedCase.id, mixedDraft.rowId, 2);
    await seedContentFixture(testEnv.DB, {
      id: "draft-puzzle-case",
      date: "2026-08-01",
      slug: "draft-puzzle-case",
      puzzle: makePuzzleFixture({ rowId: "draft-puzzle:v1", contentKey: "draft-puzzle" }),
      puzzleStatus: "draft",
    });
    await seedContentFixture(testEnv.DB, {
      id: "retired-puzzle-case",
      date: "2026-08-02",
      slug: "retired-puzzle-case",
      puzzle: makePuzzleFixture({ rowId: "retired-puzzle:v1", contentKey: "retired-puzzle" }),
      puzzleStatus: "retired",
    });
    await seedDailyCase(testEnv.DB, {
      id: "empty-case",
      date: "2026-08-03",
      slug: "empty-case",
    });
    const token = (await issueGuest()).token;

    for (const date of [
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]) {
      await expectDailyNotFound(`/v1/daily?date=${date}`, token);
    }
  });

  it("reports only distinct correct logical puzzle ids for the current guest session", async () => {
    const dailyCase = await seedDailyCase(testEnv.DB);
    const secondPuzzle = makePuzzleFixture({ rowId: "quiet-a4:v1", contentKey: "quiet-a4" });
    await seedPuzzle(testEnv.DB, openingPuzzleFixture);
    await seedPuzzle(testEnv.DB, secondPuzzle);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, openingPuzzleFixture.rowId, 1);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, secondPuzzle.rowId, 2);
    const currentToken = (await issueGuest()).token;
    const currentSessionId = await sessionIdFor(currentToken);
    const otherToken = (await issueGuest()).token;
    const otherSessionId = await sessionIdFor(otherToken);
    await insertAttempt({
      sessionId: currentSessionId,
      caseId: dailyCase.id,
      puzzleRowId: openingPuzzleFixture.rowId,
      correct: true,
    });
    await insertAttempt({
      sessionId: currentSessionId,
      caseId: dailyCase.id,
      puzzleRowId: openingPuzzleFixture.rowId,
      correct: true,
    });
    await insertAttempt({
      sessionId: currentSessionId,
      caseId: dailyCase.id,
      puzzleRowId: secondPuzzle.rowId,
      correct: false,
    });
    const otherCase = await seedDailyCase(testEnv.DB, {
      id: "case-2026-08-02",
      date: "2026-08-02",
      slug: "case-2026-08-02",
    });
    await seedCasePuzzle(testEnv.DB, otherCase.id, secondPuzzle.rowId, 1);
    await insertAttempt({
      sessionId: currentSessionId,
      caseId: otherCase.id,
      puzzleRowId: secondPuzzle.rowId,
      correct: true,
    });
    await insertAttempt({
      sessionId: otherSessionId,
      caseId: dailyCase.id,
      puzzleRowId: secondPuzzle.rowId,
      correct: true,
    });

    const current = await authenticatedJson("/v1/daily?date=2026-08-03", currentToken);
    const other = await authenticatedJson("/v1/daily?date=2026-08-03", otherToken);

    const currentDaily = DailyCaseResponseSchema.parse(current.body);
    const otherDaily = DailyCaseResponseSchema.parse(other.body);
    expect(currentDaily.solvedPuzzleIds).toEqual([publicPuzzleId(dailyCase.id, 1, 1)]);
    expect(otherDaily.solvedPuzzleIds).toEqual([publicPuzzleId(dailyCase.id, 2, 1)]);
    expect(currentDaily.title).toBe(dailyCase.title);
    expect(currentDaily.puzzles[0]?.title).toBe(openingPuzzleFixture.public.title);
    expect(otherDaily.title).toBe("Daily case");
    expect(otherDaily.puzzles[0]?.title).toBe("Puzzle 1");
    expect(otherDaily.puzzles[1]?.title).toBe(secondPuzzle.public.title);
  });

  it("scopes Telegram solved puzzles to the player across sessions without cross-player leaks", async () => {
    const dailyCase = await seedDailyCase(testEnv.DB);
    const secondPuzzle = makePuzzleFixture({ rowId: "quiet-a4:v1", contentKey: "quiet-a4" });
    await seedPuzzle(testEnv.DB, openingPuzzleFixture);
    await seedPuzzle(testEnv.DB, secondPuzzle);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, openingPuzzleFixture.rowId, 1);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, secondPuzzle.rowId, 2);
    const firstToken = (await issueGuest("telegram")).token;
    const firstSessionId = await sessionIdFor(firstToken);
    await insertAttempt({
      sessionId: firstSessionId,
      caseId: dailyCase.id,
      puzzleRowId: secondPuzzle.rowId,
      correct: true,
    });
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('player-1', '101', 'Player One', 1, 1)`,
    ).run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET player_id = 'player-1', kind = 'telegram' WHERE id = ?",
    )
      .bind(firstSessionId)
      .run();

    const secondToken = (await issueGuest("telegram")).token;
    const secondSessionId = await sessionIdFor(secondToken);
    await testEnv.DB.prepare(
      "UPDATE sessions SET player_id = 'player-1', kind = 'telegram' WHERE id = ?",
    )
      .bind(secondSessionId)
      .run();

    const otherToken = (await issueGuest("telegram")).token;
    const otherSessionId = await sessionIdFor(otherToken);
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('player-2', '202', 'Player Two', 1, 1)`,
    ).run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET player_id = 'player-2', kind = 'telegram' WHERE id = ?",
    )
      .bind(otherSessionId)
      .run();
    await insertAttempt({
      sessionId: firstSessionId,
      playerId: "player-1",
      caseId: dailyCase.id,
      puzzleRowId: openingPuzzleFixture.rowId,
      correct: true,
    });
    await insertAttempt({
      sessionId: otherSessionId,
      playerId: "player-2",
      caseId: dailyCase.id,
      puzzleRowId: secondPuzzle.rowId,
      correct: true,
    });

    const samePlayer = await authenticatedJson("/v1/daily?date=2026-08-03", secondToken);
    const otherPlayer = await authenticatedJson("/v1/daily?date=2026-08-03", otherToken);

    expect(DailyCaseResponseSchema.parse(samePlayer.body).solvedPuzzleIds).toEqual([
      publicPuzzleId(dailyCase.id, 1, 1),
    ]);
    expect(DailyCaseResponseSchema.parse(otherPlayer.body).solvedPuzzleIds).toEqual([
      publicPuzzleId(dailyCase.id, 2, 1),
    ]);
  });

  it("fails closed for corrupt, private, mismatched, or version-inconsistent public projections", async () => {
    const token = (await issueGuest()).token;
    await seedContentFixture(testEnv.DB, {
      id: "corrupt-case",
      date: "2026-08-01",
      slug: "corrupt-case",
      puzzle: makePuzzleFixture({ rowId: "corrupt:v1", contentKey: "corrupt" }),
    });
    await testEnv.DB.prepare("UPDATE puzzles SET public_json = '{}' WHERE id = 'corrupt:v1'").run();
    await seedContentFixture(testEnv.DB, {
      id: "mismatch-case",
      date: "2026-08-02",
      slug: "mismatch-case",
      puzzle: makePuzzleFixture({
        rowId: "mismatch:v1",
        contentKey: "mismatch",
        publicId: "different-logical-id",
      }),
    });
    const privateCase = await seedDailyCase(testEnv.DB, {
      id: "private-case",
      date: "2026-07-31",
      slug: "private-case",
    });
    const privatePuzzle = makePuzzleFixture({ rowId: "private:v1", contentKey: "private" });
    await seedPuzzle(testEnv.DB, privatePuzzle, {
      publicJson: JSON.stringify({ ...privatePuzzle.public, previousFen: privateSolutionMarker }),
    });
    await seedCasePuzzle(testEnv.DB, privateCase.id, privatePuzzle.rowId);
    const versionCase = await seedContentFixture(testEnv.DB, {
      id: "version-case",
      date: "2026-07-30",
      slug: "version-case",
      puzzle: makePuzzleFixture({ rowId: "version:v1", contentKey: "version" }),
    });
    await testEnv.DB.prepare("UPDATE puzzles SET version = 2 WHERE id = ?")
      .bind(versionCase.puzzle.rowId)
      .run();

    for (const date of ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]) {
      const result = await authenticatedJson(`/v1/daily?date=${date}`, token);
      expect(result.response.status).toBe(500);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INTERNAL_ERROR");
      expect(JSON.stringify(result.body)).not.toContain("different-logical-id");
      expect(JSON.stringify(result.body)).not.toContain(privateSolutionMarker);
    }
  });

  it("fails closed when two physical versions would duplicate a logical puzzle id", async () => {
    const dailyCase = await seedDailyCase(testEnv.DB);
    const versionOne = makePuzzleFixture({
      rowId: "duplicate:v1",
      contentKey: "duplicate",
      version: 1,
    });
    const versionTwo = makePuzzleFixture({
      rowId: "duplicate:v2",
      contentKey: "duplicate",
      version: 2,
    });
    await seedPuzzle(testEnv.DB, versionOne);
    await seedPuzzle(testEnv.DB, versionTwo);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, versionOne.rowId, 1);
    await seedCasePuzzle(testEnv.DB, dailyCase.id, versionTwo.rowId, 2);
    const token = (await issueGuest()).token;

    const result = await authenticatedJson("/v1/daily?date=2026-08-03", token);

    expect(result.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INTERNAL_ERROR");
  });
});
