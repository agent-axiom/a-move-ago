import { env } from "cloudflare:workers";
import {
  AttemptResultSchema,
  ErrorEnvelopeSchema,
  type Retraction,
  SessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env, SessionActor } from "../src/env";
import { withFakeRateLimiters } from "./fake-rate-limiters";
import {
  makePuzzleFixture,
  openingPuzzleFixture,
  seedCasePuzzle,
  seedContentFixture,
  seedDailyCase,
  seedPuzzle,
} from "./fixtures/content";

const testEnv = withFakeRateLimiters(env as Env);
const injectedNow = new Date("2026-08-03T23:30:00.000Z");
const injectedNowSeconds = Math.floor(injectedNow.getTime() / 1_000);
const app = createApp({ now: () => injectedNow });

type AttemptInput = {
  attemptUuid: string;
  caseId: string;
  puzzleId: string;
  retraction: Retraction;
};

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

async function postAttempt(token: string, body: unknown) {
  return await requestJson("/v1/attempts", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
  });
}

async function issueGuest(channel: "web" | "telegram" | "android" = "web") {
  const result = await requestJson("/v1/sessions/guest", {
    method: "POST",
    body: { channel },
  });
  expect(result.response.status).toBe(201);
  return SessionIssuedSchema.parse(result.body);
}

async function sessionIdFor(token: string): Promise<string> {
  const tokenHash = await hashSessionToken(token, testEnv.SESSION_PEPPER);
  const row = await testEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ id: string }>();
  if (!row) throw new Error("Expected session fixture");
  return row.id;
}

function correctRequest(attemptUuid: string = crypto.randomUUID()): AttemptInput {
  return {
    attemptUuid,
    caseId: "case-2026-08-03",
    puzzleId: openingPuzzleFixture.contentKey,
    retraction: structuredClone(openingPuzzleFixture.solution.retraction),
  };
}

const incorrectRetraction: Retraction = {
  currentSquare: "d5",
  previousSquare: "d4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: null,
  special: "normal",
};

async function countAttempts(): Promise<number> {
  const row = await testEnv.DB.prepare("SELECT count(*) AS count FROM attempts").first<{
    count: number;
  }>();
  return row?.count ?? 0;
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

async function seedOpening() {
  return await seedContentFixture(testEnv.DB);
}

async function conflictPair(
  kind: "case" | "puzzle" | "retraction",
  attemptUuid: string,
): Promise<[AttemptInput, AttemptInput]> {
  const original = correctRequest(attemptUuid);
  if (kind === "case") {
    const otherCase = await seedDailyCase(testEnv.DB, {
      id: "case-2026-08-02",
      date: "2026-08-02",
      slug: "case-2026-08-02",
    });
    await seedCasePuzzle(testEnv.DB, otherCase.id, openingPuzzleFixture.rowId);
    return [original, { ...original, caseId: otherCase.id }];
  }
  if (kind === "puzzle") {
    const otherPuzzle = makePuzzleFixture({ rowId: "quiet-a4:v1", contentKey: "quiet-a4" });
    await seedPuzzle(testEnv.DB, otherPuzzle);
    await seedCasePuzzle(testEnv.DB, original.caseId, otherPuzzle.rowId, 2);
    return [original, { ...original, puzzleId: otherPuzzle.contentKey }];
  }
  return [original, { ...original, retraction: incorrectRetraction }];
}

beforeEach(async () => {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_revoke_session_after_attempt").run();
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

describe("POST /v1/attempts", () => {
  it("stores a correct reveal against the physical puzzle row and current guest actor", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const sessionId = await sessionIdFor(issued.token);
    const input = correctRequest();

    const result = await postAttempt(issued.token, input);

    expect(result.response.status).toBe(201);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.get("idempotency-replayed")).toBeNull();
    const body = AttemptResultSchema.parse(result.body);
    expect(body).toEqual({
      id: body.id,
      attemptUuid: input.attemptUuid,
      correct: true,
      reveal: openingPuzzleFixture.solution,
    });
    const row = await testEnv.DB.prepare(
      `SELECT id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
              normalized_answer_json, correct, response_json, submitted_at
         FROM attempts`,
    ).first<{
      id: string;
      attempt_uuid: string;
      session_id: string;
      player_id: string | null;
      case_id: string;
      puzzle_id: string;
      normalized_answer_json: string;
      correct: number;
      response_json: string;
      submitted_at: number;
    }>();
    expect(row).toMatchObject({
      id: body.id,
      attempt_uuid: input.attemptUuid,
      session_id: sessionId,
      player_id: null,
      case_id: input.caseId,
      puzzle_id: openingPuzzleFixture.rowId,
      correct: 1,
      submitted_at: injectedNowSeconds,
    });
    expect(JSON.parse(row?.normalized_answer_json ?? "null")).toEqual(input.retraction);
    expect(JSON.parse(row?.response_json ?? "null")).toEqual(body);
  });

  it("stores an incorrect reconstruction as a successful business response", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const input = { ...correctRequest(), retraction: incorrectRetraction };

    const result = await postAttempt(issued.token, input);

    expect(result.response.status).toBe(201);
    expect(AttemptResultSchema.parse(result.body)).toEqual({
      id: expect.any(String),
      attemptUuid: input.attemptUuid,
      correct: false,
      contradiction: {
        code: "NOT_THE_LAST_MOVE",
        message: "reveal-secret",
      },
    });
    const row = await testEnv.DB.prepare("SELECT correct FROM attempts").first<{
      correct: number;
    }>();
    expect(row?.correct).toBe(0);
  });

  it("parses every ordered solution before evaluating and accepts identical maps in any key order", async () => {
    await seedOpening();
    await testEnv.DB.prepare("DELETE FROM puzzle_solutions WHERE puzzle_id = ?")
      .bind(openingPuzzleFixture.rowId)
      .run();
    const first = {
      ...openingPuzzleFixture.solution,
      explanation: "ordered-first",
    };
    const second = {
      ...openingPuzzleFixture.solution,
      explanation: "ordered-second",
    };
    await testEnv.DB.prepare(
      `INSERT INTO puzzle_solutions
        (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "solution-order-2",
        openingPuzzleFixture.rowId,
        "second",
        JSON.stringify(second),
        JSON.stringify({ WRONG_COLOR: "wrong", NOT_THE_LAST_MOVE: "last" }),
        2,
        "solution-order-1",
        openingPuzzleFixture.rowId,
        "first",
        JSON.stringify(first),
        JSON.stringify({ NOT_THE_LAST_MOVE: "last", WRONG_COLOR: "wrong" }),
        1,
      )
      .run();
    const issued = await issueGuest();

    const result = await postAttempt(issued.token, correctRequest());

    expect(result.response.status).toBe(201);
    expect(AttemptResultSchema.parse(result.body)).toMatchObject({
      correct: true,
      reveal: { explanation: "ordered-first" },
    });
  });

  it("replays an exact request through the logical content key with one stable snapshot", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const firstInput = correctRequest();
    const reorderedRetraction: Retraction = {
      special: firstInput.retraction.special,
      restoredPiece: firstInput.retraction.restoredPiece,
      movedPiece: {
        type: firstInput.retraction.movedPiece.type,
        color: firstInput.retraction.movedPiece.color,
      },
      previousSquare: firstInput.retraction.previousSquare,
      currentSquare: firstInput.retraction.currentSquare,
    };

    const first = await postAttempt(issued.token, firstInput);
    const replay = await postAttempt(issued.token, {
      ...firstInput,
      retraction: reorderedRetraction,
    });

    expect(first.response.status).toBe(201);
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(await countAttempts()).toBe(1);
  });

  it("collapses concurrent exact submissions to one row and one canonical response", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const input = correctRequest();

    const results = await Promise.all([
      postAttempt(issued.token, structuredClone(input)),
      postAttempt(issued.token, structuredClone(input)),
    ]);
    const created = results.find((result) => result.response.status === 201);
    const replayed = results.find((result) => result.response.status === 200);

    expect(results.map((result) => result.response.status).sort()).toEqual([200, 201]);
    expect(created?.response.headers.get("idempotency-replayed")).toBeNull();
    expect(replayed?.response.headers.get("idempotency-replayed")).toBe("true");
    expect(replayed?.body).toEqual(created?.body);
    expect(await countAttempts()).toBe(1);
  });

  it("does not replay from the loser reread after the winner atomically revokes the session", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const sessionId = await sessionIdFor(issued.token);
    const actor: SessionActor = {
      sessionId,
      playerId: null,
      kind: "guest",
      channel: "web",
    };
    const input = correctRequest();
    const { submitAttempt } = await import("../src/services/attempt-service");
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_revoke_session_after_attempt
       AFTER INSERT ON attempts
       FOR EACH ROW
       BEGIN
         UPDATE sessions SET revoked_at = NEW.submitted_at WHERE id = NEW.session_id;
       END`,
    ).run();

    try {
      const results = await Promise.allSettled([
        submitAttempt(testEnv, actor, structuredClone(input), injectedNowSeconds),
        submitAttempt(testEnv, actor, structuredClone(input), injectedNowSeconds),
      ]);
      const statuses = results
        .map((result) =>
          result.status === "fulfilled"
            ? result.value.replayed
              ? 200
              : 201
            : (result.reason as { status?: number }).status,
        )
        .sort();

      expect(statuses).toEqual([201, 401]);
      expect(await countAttempts()).toBe(1);
      const session = await testEnv.DB.prepare("SELECT revoked_at FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first<{ revoked_at: number | null }>();
      expect(session?.revoked_at).toBe(injectedNowSeconds);
    } finally {
      await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_revoke_session_after_attempt").run();
    }
  });

  it("allows the same client UUID in different sessions", async () => {
    await seedOpening();
    const [firstSession, secondSession] = await Promise.all([issueGuest(), issueGuest("android")]);
    const input = correctRequest();

    const [first, second] = await Promise.all([
      postAttempt(firstSession.token, input),
      postAttempt(secondSession.token, input),
    ]);

    expect([first.response.status, second.response.status]).toEqual([201, 201]);
    expect(AttemptResultSchema.parse(first.body).id).not.toBe(
      AttemptResultSchema.parse(second.body).id,
    );
    expect(await countAttempts()).toBe(2);
  });

  it("persists the authenticated Telegram player together with the originating session", async () => {
    await seedOpening();
    const issued = await issueGuest("telegram");
    const sessionId = await sessionIdFor(issued.token);
    await testEnv.DB.prepare(
      `INSERT INTO players
        (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('player-1', '1001', 'Player One', 1, 1)`,
    ).run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET kind = 'telegram', player_id = 'player-1' WHERE id = ?",
    )
      .bind(sessionId)
      .run();

    const result = await postAttempt(issued.token, correctRequest());

    expect(result.response.status).toBe(201);
    const row = await testEnv.DB.prepare("SELECT session_id, player_id FROM attempts").first<{
      session_id: string;
      player_id: string | null;
    }>();
    expect(row).toEqual({ session_id: sessionId, player_id: "player-1" });
  });

  it("requires authentication before parsing and always disables caching", async () => {
    await seedOpening();
    const input = correctRequest();
    const absent = await requestJson("/v1/attempts", { method: "POST", body: input });
    const unknown = await postAttempt("A".repeat(43), input);

    await expectError(absent, 401, "INVALID_SESSION");
    await expectError(unknown, 401, "INVALID_SESSION");
    expect(await countAttempts()).toBe(0);
  });

  it.each(["revoked", "expired", "deleted", "kind changed", "player changed"] as const)(
    "refuses a stale authenticated actor after its session is %s",
    async (mutation) => {
      await seedOpening();
      const issued = await issueGuest();
      const sessionId = await sessionIdFor(issued.token);
      let actor: SessionActor = {
        sessionId,
        playerId: null,
        kind: "guest",
        channel: "web",
      };

      if (mutation === "revoked") {
        await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
          .bind(injectedNowSeconds, sessionId)
          .run();
      } else if (mutation === "expired") {
        await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
          .bind(injectedNowSeconds, sessionId)
          .run();
      } else if (mutation === "deleted") {
        await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
      } else {
        await testEnv.DB.prepare(
          `INSERT INTO players
            (id, telegram_user_id, display_name, created_at, updated_at)
           VALUES ('player-1', '1001', 'Player One', 1, 1),
                  ('player-2', '1002', 'Player Two', 1, 1)`,
        ).run();
        if (mutation === "kind changed") {
          await testEnv.DB.prepare(
            "UPDATE sessions SET kind = 'telegram', player_id = 'player-1' WHERE id = ?",
          )
            .bind(sessionId)
            .run();
        } else {
          await testEnv.DB.prepare(
            "UPDATE sessions SET kind = 'telegram', player_id = 'player-1' WHERE id = ?",
          )
            .bind(sessionId)
            .run();
          actor = {
            sessionId,
            playerId: "player-1",
            kind: "telegram",
            channel: "web",
          };
          await testEnv.DB.prepare("UPDATE sessions SET player_id = 'player-2' WHERE id = ?")
            .bind(sessionId)
            .run();
        }
      }

      const { submitAttempt } = await import("../src/services/attempt-service");
      await expect(
        submitAttempt(testEnv, actor, correctRequest(), injectedNowSeconds),
      ).rejects.toMatchObject({
        status: 401,
        code: "INVALID_SESSION",
        message: "The session is invalid or expired.",
      });
      expect(await countAttempts()).toBe(0);
    },
  );

  it.each(["revoked", "expired", "deleted", "kind changed", "player changed"] as const)(
    "returns only 401 for a stored replay after its actor is %s",
    async (mutation) => {
      await seedOpening();
      const issued = await issueGuest();
      const sessionId = await sessionIdFor(issued.token);
      let actor: SessionActor = {
        sessionId,
        playerId: null,
        kind: "guest",
        channel: "web",
      };
      if (mutation === "player changed") {
        await testEnv.DB.prepare(
          `INSERT INTO players
            (id, telegram_user_id, display_name, created_at, updated_at)
           VALUES ('player-1', '1001', 'Player One', 1, 1),
                  ('player-2', '1002', 'Player Two', 1, 1)`,
        ).run();
        await testEnv.DB.prepare(
          "UPDATE sessions SET kind = 'telegram', player_id = 'player-1' WHERE id = ?",
        )
          .bind(sessionId)
          .run();
        actor = {
          sessionId,
          playerId: "player-1",
          kind: "telegram",
          channel: "web",
        };
      }
      const input = correctRequest();
      const { submitAttempt } = await import("../src/services/attempt-service");
      const stored = await submitAttempt(testEnv, actor, input, injectedNowSeconds);
      expect(stored.replayed).toBe(false);

      if (mutation === "revoked") {
        await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
          .bind(injectedNowSeconds, sessionId)
          .run();
      } else if (mutation === "expired") {
        await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
          .bind(injectedNowSeconds, sessionId)
          .run();
      } else if (mutation === "deleted") {
        await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
      } else if (mutation === "kind changed") {
        await testEnv.DB.prepare(
          `INSERT INTO players
            (id, telegram_user_id, display_name, created_at, updated_at)
           VALUES ('player-1', '1001', 'Player One', 1, 1)`,
        ).run();
        await testEnv.DB.prepare(
          "UPDATE sessions SET kind = 'telegram', player_id = 'player-1' WHERE id = ?",
        )
          .bind(sessionId)
          .run();
      } else {
        await testEnv.DB.prepare("UPDATE sessions SET player_id = 'player-2' WHERE id = ?")
          .bind(sessionId)
          .run();
      }

      const results = await Promise.allSettled([
        submitAttempt(testEnv, actor, input, injectedNowSeconds),
        submitAttempt(
          testEnv,
          actor,
          { ...input, retraction: incorrectRetraction },
          injectedNowSeconds,
        ),
      ]);
      expect(
        results.map((result) =>
          result.status === "rejected" ? (result.reason as { status?: number }).status : 200,
        ),
      ).toEqual([401, 401]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({
            status: 401,
            code: "INVALID_SESSION",
            message: "The session is invalid or expired.",
          });
        }
      }
      expect(await countAttempts()).toBe(1);
    },
  );

  it("strictly rejects malformed JSON and malformed request shapes", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const malformedResponse = await app.fetch(
      new Request("https://api.test/v1/attempts", {
        method: "POST",
        headers: {
          authorization: `Bearer ${issued.token}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
      testEnv,
    );
    await expectError(
      { response: malformedResponse, body: (await malformedResponse.json()) as unknown },
      400,
      "INVALID_REQUEST",
    );

    const valid = correctRequest();
    const invalidBodies: unknown[] = [
      {},
      { ...valid, attemptUuid: "not-a-uuid" },
      { ...valid, caseId: "" },
      { ...valid, puzzleId: "" },
      { ...valid, unexpected: true },
      { ...valid, retraction: { ...valid.retraction, unexpected: true } },
      {
        ...valid,
        retraction: {
          ...valid.retraction,
          previousSquare: valid.retraction.currentSquare,
        },
      },
    ];
    for (const body of invalidBodies) {
      await expectError(await postAttempt(issued.token, body), 400, "INVALID_REQUEST");
    }
    expect(await countAttempts()).toBe(0);
  });

  it("hides missing, mismatched, unpublished, retired, and future memberships identically", async () => {
    await seedOpening();
    const archive = await seedContentFixture(testEnv.DB, {
      id: "archive-case",
      date: "2026-07-31",
      slug: "archive-case",
      puzzle: makePuzzleFixture({ rowId: "archive:v1", contentKey: "archive" }),
    });
    await seedContentFixture(testEnv.DB, {
      id: "draft-case",
      date: "2026-08-01",
      slug: "draft-case",
      status: "draft",
      puzzle: makePuzzleFixture({ rowId: "draft-case:v1", contentKey: "draft-case-puzzle" }),
    });
    await seedContentFixture(testEnv.DB, {
      id: "retired-case",
      date: "2026-07-30",
      slug: "retired-case",
      status: "retired",
      puzzle: makePuzzleFixture({ rowId: "retired-case:v1", contentKey: "retired-case-puzzle" }),
    });
    await seedContentFixture(testEnv.DB, {
      id: "draft-puzzle-case",
      date: "2026-08-02",
      slug: "draft-puzzle-case",
      puzzle: makePuzzleFixture({ rowId: "draft-puzzle:v1", contentKey: "draft-puzzle" }),
      puzzleStatus: "draft",
    });
    await seedContentFixture(testEnv.DB, {
      id: "retired-puzzle-case",
      date: "2026-07-29",
      slug: "retired-puzzle-case",
      puzzle: makePuzzleFixture({ rowId: "retired-puzzle:v1", contentKey: "retired-puzzle" }),
      puzzleStatus: "retired",
    });
    const future = await seedContentFixture(testEnv.DB, {
      id: "future-case",
      date: "2026-08-04",
      slug: "future-case",
      puzzle: makePuzzleFixture({ rowId: "future:v1", contentKey: "future" }),
    });
    const issued = await issueGuest();
    const targets = [
      { caseId: "missing-case", puzzleId: "missing-puzzle" },
      { caseId: "case-2026-08-03", puzzleId: "missing-puzzle" },
      { caseId: "case-2026-08-03", puzzleId: archive.puzzle.contentKey },
      { caseId: archive.caseId, puzzleId: openingPuzzleFixture.contentKey },
      { caseId: "draft-case", puzzleId: "draft-case-puzzle" },
      { caseId: "retired-case", puzzleId: "retired-case-puzzle" },
      { caseId: "draft-puzzle-case", puzzleId: "draft-puzzle" },
      { caseId: "retired-puzzle-case", puzzleId: "retired-puzzle" },
      { caseId: future.caseId, puzzleId: future.puzzle.contentKey },
    ];

    const messages = new Set<string>();
    for (const target of targets) {
      const input = { ...correctRequest(), ...target, attemptUuid: crypto.randomUUID() };
      const envelope = await expectError(
        await postAttempt(issued.token, input),
        404,
        "PUZZLE_NOT_FOUND",
      );
      messages.add(envelope.error.message);
      expect(JSON.stringify(envelope)).not.toContain(target.caseId);
      expect(JSON.stringify(envelope)).not.toContain(target.puzzleId);
    }
    expect(messages).toEqual(new Set(["Puzzle not found."]));
    expect(await countAttempts()).toBe(0);
  });

  it("accepts only logical IDs and hides a case with any unpublished sibling puzzle", async () => {
    await seedOpening();
    const draftSibling = makePuzzleFixture({
      rowId: "draft-sibling:v1",
      contentKey: "draft-sibling",
    });
    await seedPuzzle(testEnv.DB, draftSibling, { status: "draft" });
    await seedCasePuzzle(testEnv.DB, "case-2026-08-03", draftSibling.rowId, 2);
    const issued = await issueGuest();

    const physicalId = await postAttempt(issued.token, {
      ...correctRequest(),
      attemptUuid: crypto.randomUUID(),
      puzzleId: openingPuzzleFixture.rowId,
    });
    const partiallyPublished = await postAttempt(issued.token, {
      ...correctRequest(),
      attemptUuid: crypto.randomUUID(),
    });

    await expectError(physicalId, 404, "PUZZLE_NOT_FOUND");
    await expectError(partiallyPublished, 404, "PUZZLE_NOT_FOUND");
    expect(await countAttempts()).toBe(0);
  });

  it.each(["case", "puzzle", "retraction"] as const)(
    "rejects stored UUID reuse with a different %s",
    async (kind) => {
      await seedOpening();
      const issued = await issueGuest();
      const [original, conflict] = await conflictPair(kind, crypto.randomUUID());

      const first = await postAttempt(issued.token, original);
      const rejected = await postAttempt(issued.token, conflict);
      const replay = await postAttempt(issued.token, original);

      expect(first.response.status).toBe(201);
      await expectError(rejected, 409, "IDEMPOTENCY_CONFLICT");
      expect(replay.response.status).toBe(200);
      expect(replay.body).toEqual(first.body);
      expect(await countAttempts()).toBe(1);
    },
  );

  it.each(["case", "puzzle", "retraction"] as const)(
    "chooses one canonical winner for concurrent UUID reuse with a different %s",
    async (kind) => {
      await seedOpening();
      const issued = await issueGuest();
      const [firstInput, secondInput] = await conflictPair(kind, crypto.randomUUID());

      const results = await Promise.all([
        postAttempt(issued.token, firstInput),
        postAttempt(issued.token, secondInput),
      ]);
      const createdIndex = results.findIndex((result) => result.response.status === 201);
      const rejected = results.find((result) => result.response.status === 409);
      const winningInput = createdIndex === 0 ? firstInput : secondInput;
      const created = results[createdIndex];

      expect(createdIndex).toBeGreaterThanOrEqual(0);
      await expectError(
        rejected as Awaited<ReturnType<typeof requestJson>>,
        409,
        "IDEMPOTENCY_CONFLICT",
      );
      const replay = await postAttempt(issued.token, winningInput);
      expect(replay.response.status).toBe(200);
      expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
      expect(replay.body).toEqual(created?.body);
      expect(await countAttempts()).toBe(1);
    },
  );

  it.each([
    [
      "an invalid public projection",
      async () => {
        await testEnv.DB.prepare("UPDATE puzzles SET public_json = ? WHERE id = ?")
          .bind(
            JSON.stringify({ ...openingPuzzleFixture.public, title: "" }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
    [
      "a mismatched logical public identity",
      async () => {
        await testEnv.DB.prepare("UPDATE puzzles SET public_json = ? WHERE id = ?")
          .bind(
            JSON.stringify({ ...openingPuzzleFixture.public, id: "storage-secret-do-not-leak" }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
    [
      "a mismatched public version",
      async () => {
        await testEnv.DB.prepare("UPDATE puzzles SET public_json = ? WHERE id = ?")
          .bind(
            JSON.stringify({ ...openingPuzzleFixture.public, version: 2 }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
    [
      "duplicate physical versions of one logical puzzle",
      async () => {
        const secondVersion = makePuzzleFixture({
          rowId: "opening-exd5:v2",
          contentKey: openingPuzzleFixture.contentKey,
          version: 2,
        });
        await seedPuzzle(testEnv.DB, secondVersion);
        await seedCasePuzzle(testEnv.DB, "case-2026-08-03", secondVersion.rowId, 2);
      },
    ],
    [
      "an invalid accepted solution",
      async () => {
        await testEnv.DB.prepare(
          "UPDATE puzzle_solutions SET solution_json = ? WHERE puzzle_id = ?",
        )
          .bind(
            JSON.stringify({ storage: "storage-secret-do-not-leak" }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
    [
      "an invalid contradiction map",
      async () => {
        await testEnv.DB.prepare(
          "UPDATE puzzle_solutions SET contradiction_json = ? WHERE puzzle_id = ?",
        )
          .bind(
            JSON.stringify({ NOT_THE_LAST_MOVE: "", storage: "storage-secret-do-not-leak" }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
    [
      "inconsistent contradiction maps",
      async () => {
        await testEnv.DB.prepare(
          `INSERT INTO puzzle_solutions
            (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order)
           VALUES (?, ?, ?, ?, ?, 2)`,
        )
          .bind(
            "second-inconsistent-solution",
            openingPuzzleFixture.rowId,
            "second",
            JSON.stringify(openingPuzzleFixture.solution),
            JSON.stringify({ NOT_THE_LAST_MOVE: "storage-secret-do-not-leak" }),
          )
          .run();
      },
    ],
    [
      "a published puzzle without solutions",
      async () => {
        await testEnv.DB.prepare("DELETE FROM puzzle_solutions WHERE puzzle_id = ?")
          .bind(openingPuzzleFixture.rowId)
          .run();
      },
    ],
    [
      "a schema-valid projection with an invalid FEN",
      async () => {
        await testEnv.DB.prepare("UPDATE puzzles SET public_json = ? WHERE id = ?")
          .bind(
            JSON.stringify({
              ...openingPuzzleFixture.public,
              postFen: "storage-secret-do-not-leak",
            }),
            openingPuzzleFixture.rowId,
          )
          .run();
      },
    ],
  ] as const)("fails closed without leaking private content for %s", async (_name, corrupt) => {
    await seedOpening();
    await corrupt();
    const issued = await issueGuest();

    const result = await postAttempt(issued.token, correctRequest());

    const envelope = await expectError(result, 500, "INTERNAL_ERROR");
    expect(envelope.error.message).toBe("Unexpected server error.");
    expect(JSON.stringify(result.body)).not.toContain("storage-secret-do-not-leak");
    expect(await countAttempts()).toBe(0);
  });

  it.each([
    "invalid schema",
    "wrong row id",
    "wrong attempt UUID",
    "wrong reveal retraction",
  ] as const)(
    "fails closed instead of blindly replaying a stored response with %s",
    async (kind) => {
      await seedOpening();
      const issued = await issueGuest();
      const input = correctRequest();
      const first = await postAttempt(issued.token, input);
      expect(first.response.status).toBe(201);
      const firstBody = AttemptResultSchema.parse(first.body);
      if (!firstBody.correct) throw new Error("Expected correct attempt fixture");
      const tampered =
        kind === "invalid schema"
          ? { correct: true, storage: "storage-secret-do-not-leak" }
          : kind === "wrong row id"
            ? { ...firstBody, id: crypto.randomUUID() }
            : kind === "wrong attempt UUID"
              ? { ...firstBody, attemptUuid: crypto.randomUUID() }
              : {
                  ...firstBody,
                  reveal: { ...firstBody.reveal, retraction: incorrectRetraction },
                };
      await testEnv.DB.prepare("UPDATE attempts SET response_json = ?")
        .bind(JSON.stringify(tampered))
        .run();

      const replay = await postAttempt(issued.token, input);

      const envelope = await expectError(replay, 500, "INTERNAL_ERROR");
      expect(envelope.error.message).toBe("Unexpected server error.");
      expect(JSON.stringify(replay.body)).not.toContain("storage-secret-do-not-leak");
      expect(await countAttempts()).toBe(1);
    },
  );

  it.each(["invalid normalized answer", "response correctness mismatch"] as const)(
    "fails closed for stored attempt corruption: %s",
    async (kind) => {
      await seedOpening();
      const issued = await issueGuest();
      const input = correctRequest();
      const first = await postAttempt(issued.token, input);
      expect(first.response.status).toBe(201);
      if (kind === "invalid normalized answer") {
        await testEnv.DB.prepare("UPDATE attempts SET normalized_answer_json = ?")
          .bind(JSON.stringify({ storage: "storage-secret-do-not-leak" }))
          .run();
      } else {
        await testEnv.DB.prepare("UPDATE attempts SET correct = 0").run();
      }

      const replay = await postAttempt(issued.token, input);

      const envelope = await expectError(replay, 500, "INTERNAL_ERROR");
      expect(envelope.error.message).toBe("Unexpected server error.");
      expect(JSON.stringify(replay.body)).not.toContain("storage-secret-do-not-leak");
      expect(await countAttempts()).toBe(1);
    },
  );

  it("surfaces a generated attempt primary-key collision instead of treating it as replay", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const first = await postAttempt(issued.token, correctRequest());
    expect(first.response.status).toBe(201);
    const collidingId = AttemptResultSchema.parse(first.body).id;
    vi.spyOn(crypto, "randomUUID").mockReturnValue(collidingId);

    const collision = await postAttempt(issued.token, correctRequest());

    await expectError(collision, 500, "INTERNAL_ERROR");
    expect(await countAttempts()).toBe(1);
  });

  it("ignores only the targeted idempotency conflict in insertAttempt", async () => {
    await seedOpening();
    const issued = await issueGuest();
    const input = correctRequest();
    const first = await postAttempt(issued.token, input);
    expect(first.response.status).toBe(201);
    const firstBody = AttemptResultSchema.parse(first.body);
    const sessionId = await sessionIdFor(issued.token);
    const { insertAttempt } = await import("../src/db/attempts");
    const base = {
      id: crypto.randomUUID(),
      attemptUuid: input.attemptUuid,
      sessionId,
      sessionKind: "guest" as const,
      playerId: null,
      caseId: input.caseId,
      puzzleId: openingPuzzleFixture.rowId,
      answerJson: JSON.stringify(input.retraction),
      correct: true,
      responseJson: JSON.stringify({ ...firstBody, id: crypto.randomUUID() }),
      submittedAt: injectedNowSeconds,
    };

    await expect(insertAttempt(testEnv.DB, base)).resolves.toBe(false);
    await expect(
      insertAttempt(testEnv.DB, {
        ...base,
        id: firstBody.id,
        attemptUuid: crypto.randomUUID(),
      }),
    ).rejects.toBeDefined();
    await expect(
      insertAttempt(testEnv.DB, {
        ...base,
        id: crypto.randomUUID(),
        attemptUuid: crypto.randomUUID(),
        answerJson: "not-json",
      }),
    ).rejects.toBeDefined();
    expect(await countAttempts()).toBe(1);
  });
});
