import { ArchiveResponseSchema, ErrorEnvelopeSchema } from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import { getArchiveCatalog } from "../src/services/archive-service";
import {
  makePuzzleFixture,
  privateSolutionMarker,
  seedCasePuzzle,
  seedDailyCase,
  seedPuzzle,
} from "./fixtures/content";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";

const now = new Date("2026-10-15T00:30:00.000Z");
const app = createApp({ now: () => now });

async function archive(token?: string, query = "") {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(
    new Request(`https://api.test/v1/archive${query}`, { headers }),
    testEnv,
  );
  return { response, body: (await response.json()) as unknown };
}

async function seedCase(
  date: string,
  statuses: ("draft" | "published" | "retired")[] = ["published"],
  caseStatus: "draft" | "published" | "retired" = "published",
) {
  const id = `case-${date}`;
  const title = `Hidden theme for ${date}`;
  await seedDailyCase(testEnv.DB, {
    id,
    date,
    slug: `secret-motif-${date}`,
    title,
    status: caseStatus,
  });
  const puzzles = [];
  for (const [index, status] of statuses.entries()) {
    const puzzle = makePuzzleFixture({ contentKey: `${id}-puzzle-${index}` });
    await seedPuzzle(testEnv.DB, puzzle, { status });
    await seedCasePuzzle(testEnv.DB, id, puzzle.rowId, index + 1);
    puzzles.push(puzzle.rowId);
  }
  return { id, puzzles, title };
}

async function solve(
  sessionId: string,
  caseId: string,
  puzzleId: string,
  playerId: string | null = null,
  correct = true,
) {
  const id = crypto.randomUUID();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '{}', ?)`,
  )
    .bind(
      id,
      crypto.randomUUID(),
      sessionId,
      playerId,
      caseId,
      puzzleId,
      correct ? 1 : 0,
      Math.floor(now.getTime() / 1_000),
    )
    .run();
  return id;
}

function puzzleAt(value: { puzzles: string[] }, index = 0) {
  const id = value.puzzles[index];
  if (!id) throw new Error("Expected puzzle fixture");
  return id;
}

async function seedPlayer(id: string, telegramId: string) {
  await testEnv.DB.prepare(
    `INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at)
     VALUES (?, ?, 'Synthetic archive player', 1, 1)`,
  )
    .bind(id, telegramId)
    .run();
}

async function seedTelegramSession(id: string, playerId: string, token: string) {
  await testEnv.DB.prepare(
    `INSERT INTO sessions
      (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, 'telegram', 'web', ?, ?, ?)`,
  )
    .bind(
      id,
      playerId,
      await hashSessionToken(token, testEnv.SESSION_PEPPER),
      Math.floor(now.getTime() / 1_000),
      Math.floor(now.getTime() / 1_000) + 86_400,
      Math.floor(now.getTime() / 1_000),
    )
    .run();
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /v1/archive", () => {
  it("requires an active session and disables caching on success and errors", async () => {
    const missing = await archive();
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get("cache-control")).toBe("no-store");
    expect(ErrorEnvelopeSchema.parse(missing.body).error.code).toBe("INVALID_SESSION");
    const guest = await issueGuest();
    const success = await archive(guest.token);
    expect(success.response.status).toBe(200);
    expect(success.response.headers.get("cache-control")).toBe("no-store");
    expect(ArchiveResponseSchema.parse(success.body)).toEqual({
      today: "2026-10-15",
      startsOn: null,
      cases: [],
    });
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id = ?")
      .bind(guest.sessionId)
      .run();
    expect((await archive(guest.token)).response.status).toBe(401);
  });

  it("returns all usable historical dates latest first without puzzle or future metadata", async () => {
    const guest = await issueGuest();
    await seedCase("2026-09-10", ["published", "published"]);
    await seedCase("2026-10-14");
    await seedCase("2026-10-15");
    await seedCase("2026-10-16");
    await seedCase("2026-09-09", ["published"], "draft");
    await seedCase("2026-09-08", ["published"], "retired");
    await seedCase("2026-09-07", []);
    await seedCase("2026-09-06", ["published", "draft"]);
    await seedCase("2026-09-05", ["published", "retired"]);
    const result = await archive(guest.token);
    const body = ArchiveResponseSchema.parse(result.body);
    expect(body.today).toBe("2026-10-15");
    expect(body.startsOn).toBe("2026-09-10");
    expect(body.cases).toEqual([
      {
        id: "case-2026-10-15",
        date: "2026-10-15",
        slug: "case-2026-10-15",
        title: "Daily case",
        puzzleCount: 1,
        solvedPuzzles: 0,
        completed: false,
      },
      {
        id: "case-2026-10-14",
        date: "2026-10-14",
        slug: "case-2026-10-14",
        title: "Daily case",
        puzzleCount: 1,
        solvedPuzzles: 0,
        completed: false,
      },
      {
        id: "case-2026-09-10",
        date: "2026-09-10",
        slug: "case-2026-09-10",
        title: "Daily case",
        puzzleCount: 2,
        solvedPuzzles: 0,
        completed: false,
      },
    ]);
    const json = JSON.stringify(result.body);
    for (const hidden of [
      "2026-10-16",
      "2026-09-09",
      "2026-09-08",
      privateSolutionMarker,
      "postFen",
      "acceptedSolutions",
      "act_json",
      "hints",
      "Hidden theme",
      "secret-motif",
    ]) {
      expect(json).not.toContain(hidden);
    }
  });

  it("counts distinct correct puzzles for the exact guest and excludes linked-away attempts", async () => {
    const guest = await issueGuest();
    const stranger = await issueGuest();
    const dailyCase = await seedCase("2026-10-14", ["published", "published"]);
    await solve(guest.sessionId, dailyCase.id, puzzleAt(dailyCase));
    await solve(guest.sessionId, dailyCase.id, puzzleAt(dailyCase));
    await solve(guest.sessionId, dailyCase.id, puzzleAt(dailyCase, 1), null, false);
    await solve(stranger.sessionId, dailyCase.id, puzzleAt(dailyCase, 1));
    let result = ArchiveResponseSchema.parse((await archive(guest.token)).body);
    expect(result.cases[0]).toMatchObject({ puzzleCount: 2, solvedPuzzles: 1, completed: false });
    expect(result.cases[0]?.title).toBe("Daily case");
    const linkedAttempt = await solve(guest.sessionId, dailyCase.id, puzzleAt(dailyCase, 1));
    await seedPlayer("linked-away-player", "1001");
    await testEnv.DB.prepare("UPDATE attempts SET player_id = ? WHERE id = ?")
      .bind("linked-away-player", linkedAttempt)
      .run();
    result = ArchiveResponseSchema.parse((await archive(guest.token)).body);
    expect(result.cases[0]).toMatchObject({ solvedPuzzles: 1, completed: false });
    await solve(guest.sessionId, dailyCase.id, puzzleAt(dailyCase, 1));
    result = ArchiveResponseSchema.parse((await archive(guest.token)).body);
    expect(result.cases[0]).toMatchObject({ solvedPuzzles: 2, completed: true });
    expect(result.cases[0]?.title).toBe(dailyCase.title);
  });

  it("merges Telegram progress across sessions, including detached origins, without another player", async () => {
    await seedPlayer("archive-player", "1001");
    await seedPlayer("other-player", "1002");
    const token = "A".repeat(43);
    await seedTelegramSession("current-session", "archive-player", token);
    await seedTelegramSession("old-session", "archive-player", "B".repeat(43));
    await seedTelegramSession("other-session", "other-player", "C".repeat(43));
    const dailyCase = await seedCase("2026-10-14", ["published", "published"]);
    await solve("old-session", dailyCase.id, puzzleAt(dailyCase), "archive-player");
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = 'old-session'").run();
    await solve("other-session", dailyCase.id, puzzleAt(dailyCase, 1), "other-player");
    let result = ArchiveResponseSchema.parse((await archive(token)).body);
    expect(result.cases[0]).toMatchObject({ solvedPuzzles: 1, completed: false });
    await solve("current-session", dailyCase.id, puzzleAt(dailyCase, 1), "archive-player");
    result = ArchiveResponseSchema.parse((await archive(token)).body);
    expect(result.cases[0]).toMatchObject({ solvedPuzzles: 2, completed: true });
  });

  it.each(["?date=2026-10-16", "?limit=1", "?before=2026-10-01", "?x=1&x=2"])(
    "rejects unsupported query arguments: %s",
    async (query) => {
      const guest = await issueGuest();
      const result = await archive(guest.token, query);
      expect(result.response.status).toBe(400);
      expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INVALID_REQUEST");
    },
  );

  it("fails closed when stored public metadata violates the contract", async () => {
    const guest = await issueGuest();
    const dailyCase = await seedCase("2026-10-14");
    await testEnv.DB.prepare("UPDATE daily_cases SET title = '' WHERE id = ?")
      .bind(dailyCase.id)
      .run();
    const result = await archive(guest.token);
    expect(result.response.status).toBe(500);
    expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(result.body)).not.toContain(dailyCase.id);
  });

  it("rejects impossible aggregate progress before serving it", async () => {
    const db = {
      prepare: (query: string) => ({
        bind: () => ({
          all: async () => ({
            results: query.includes("WITH actor_solved")
              ? [
                  {
                    id: "invalid-case",
                    case_date: "2026-10-14",
                    slug: "invalid-case",
                    title: "Invalid case",
                    puzzle_count: 1,
                    solved_puzzles: 2,
                  },
                ]
              : [],
          }),
        }),
      }),
    } as unknown as D1Database;
    await expect(
      getArchiveCatalog(
        { ...testEnv, DB: db },
        { sessionId: "guest", kind: "guest", playerId: null, channel: "web" },
        "2026-10-15",
      ),
    ).rejects.toThrow("Stored archive metadata is invalid");
  });
});
