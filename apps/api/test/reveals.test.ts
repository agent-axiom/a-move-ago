import { ErrorEnvelopeSchema, PuzzleRevealResponseSchema } from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { hashSessionToken } from "../src/crypto/opaque-token";
import { contentDigest, seedContentFixture } from "./fixtures/content";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";

const now = new Date("2026-10-17T12:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const app = createApp({ now: () => now });

async function review(caseId: string, puzzleId: string, token?: string, locales = false) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (locales) headers.set("x-content-locales", "1");
  const response = await app.fetch(
    new Request(`https://api.test/v1/cases/${caseId}/puzzles/${puzzleId}/reveal`, { headers }),
    testEnv,
  );
  return { response, body: (await response.json()) as unknown };
}

async function completedAttempt(
  fixture: Awaited<ReturnType<typeof seedContentFixture>>,
  sessionId: string,
  playerId: string | null = null,
) {
  const id = crypto.randomUUID();
  const attemptUuid = crypto.randomUUID();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(
      id,
      attemptUuid,
      sessionId,
      playerId,
      fixture.caseId,
      fixture.puzzle.rowId,
      JSON.stringify(fixture.puzzle.solution.retraction),
      JSON.stringify({ id, attemptUuid, correct: true, reveal: fixture.puzzle.solution }),
      timestamp,
    )
    .run();
  return id;
}

async function ledgerSnapshot() {
  return await testEnv.DB.batch([
    testEnv.DB.prepare("SELECT * FROM attempts ORDER BY id"),
    testEnv.DB.prepare("SELECT * FROM gameplay_events ORDER BY seq"),
    testEnv.DB.prepare("SELECT * FROM hint_events ORDER BY attempt_id, hint_level"),
  ]).then((rows) => rows.map((row) => row.results));
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
  await resetDatabase();
});
afterEach(() => vi.restoreAllMocks());

describe("read-only solved puzzle review", () => {
  it("requires an active session and never caches private reviews", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const guest = await issueGuest();
    await completedAttempt(fixture, guest.sessionId);
    const missing = await review(fixture.caseId, fixture.puzzle.contentKey);
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get("cache-control")).toBe("no-store");
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id = ?")
      .bind(guest.sessionId)
      .run();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).response.status,
    ).toBe(401);
  });

  it("reopens an earned explanation by canonical ID or public alias without attempts or point changes", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const guest = await issueGuest();
    await completedAttempt(fixture, guest.sessionId);
    const before = await ledgerSnapshot();
    for (const puzzleId of [fixture.puzzle.contentKey, `p-${fixture.caseId}-1-v1`]) {
      const result = await review(fixture.caseId, puzzleId, guest.token);
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(PuzzleRevealResponseSchema.parse(result.body)).toEqual({
        reveal: fixture.puzzle.solution,
      });
    }
    expect(await ledgerSnapshot()).toEqual(before);
  });

  it("does not reveal answers to another guest or an unsolved actor", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const owner = await issueGuest();
    const stranger = await issueGuest();
    await completedAttempt(fixture, owner.sessionId);
    const result = await review(fixture.caseId, fixture.puzzle.contentKey, stranger.token);
    expect(result.response.status).toBe(404);
    expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("REVEAL_NOT_FOUND");
    expect(JSON.stringify(result.body)).not.toContain(fixture.puzzle.solution.explanation);
    const unknown = await review(fixture.caseId, "unknown", owner.token);
    expect(unknown.response.status).toBe(404);
  });

  it("supports historical solves without a rating ledger event", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const guest = await issueGuest();
    const id = await completedAttempt(fixture, guest.sessionId);
    await testEnv.DB.prepare("DELETE FROM gameplay_events WHERE attempt_id = ?").bind(id).run();
    const before = await ledgerSnapshot();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).response.status,
    ).toBe(200);
    expect(await ledgerSnapshot()).toEqual(before);
  });

  it("returns authorized translated explanations only when requested", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const guest = await issueGuest();
    await completedAttempt(fixture, guest.sessionId);
    await testEnv.DB.prepare(
      "INSERT INTO content_imports (digest, case_id, source_name, imported_at) VALUES (?, ?, 'synthetic', 1)",
    )
      .bind(contentDigest, fixture.caseId)
      .run();
    for (const [locale, explanation] of [
      ["ru", "Разбор уже решённой задачи."],
      ["zh", "已解棋题的讲解。"],
    ]) {
      await testEnv.DB.prepare(
        `INSERT INTO puzzle_localizations
          (puzzle_id, locale, public_json, private_json, source_digest, content_digest)
         VALUES (?, ?, '{}', ?, ?, ?)`,
      )
        .bind(
          fixture.puzzle.rowId,
          locale,
          JSON.stringify({ explanations: [explanation] }),
          contentDigest,
          contentDigest,
        )
        .run();
    }
    const plain = PuzzleRevealResponseSchema.parse(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).body,
    );
    expect(plain.reveal.localizations).toBeUndefined();
    const translated = PuzzleRevealResponseSchema.parse(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token, true)).body,
    );
    expect(translated.reveal.localizations).toEqual({
      ru: { explanation: "Разбор уже решённой задачи." },
      zh: { explanation: "已解棋题的讲解。" },
    });
  });

  it("keeps future, retired and unpublished puzzles unavailable even with an old solve", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const guest = await issueGuest();
    await completedAttempt(fixture, guest.sessionId);
    await testEnv.DB.prepare("UPDATE daily_cases SET case_date = '2026-10-18' WHERE id = ?")
      .bind(fixture.caseId)
      .run();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).response.status,
    ).toBe(404);
    await testEnv.DB.prepare(
      "UPDATE daily_cases SET case_date = '2026-10-16', status = 'retired' WHERE id = ?",
    )
      .bind(fixture.caseId)
      .run();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).response.status,
    ).toBe(404);
    await testEnv.DB.prepare("UPDATE daily_cases SET status = 'published' WHERE id = ?")
      .bind(fixture.caseId)
      .run();
    await testEnv.DB.prepare("UPDATE puzzles SET status = 'draft' WHERE id = ?")
      .bind(fixture.puzzle.rowId)
      .run();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, guest.token)).response.status,
    ).toBe(404);
  });

  it("allows the same Telegram player across sessions, never a linked-away guest or other player", async () => {
    const fixture = await seedContentFixture(testEnv.DB);
    const oldGuest = await issueGuest();
    for (const [id, telegramId] of [
      ["owner", "1"],
      ["other", "2"],
    ]) {
      await testEnv.DB.prepare(
        "INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at) VALUES (?, ?, 'Review player', 1, 1)",
      )
        .bind(id, telegramId)
        .run();
    }
    const linkedAttempt = await completedAttempt(fixture, oldGuest.sessionId);
    await testEnv.DB.prepare("UPDATE attempts SET player_id = 'owner' WHERE id = ?")
      .bind(linkedAttempt)
      .run();
    const ownerToken = "A".repeat(43);
    const otherToken = "B".repeat(43);
    for (const [playerId, token] of [
      ["owner", ownerToken],
      ["other", otherToken],
    ] as const) {
      await testEnv.DB.prepare(
        `INSERT INTO sessions (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, 'telegram', 'web', ?, ?, ?)`,
      )
        .bind(
          `${playerId}-session`,
          playerId,
          await hashSessionToken(token, testEnv.SESSION_PEPPER),
          timestamp,
          timestamp + 86_400,
          timestamp,
        )
        .run();
    }
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, oldGuest.token)).response.status,
    ).toBe(404);
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(oldGuest.sessionId).run();
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, ownerToken)).response.status,
    ).toBe(200);
    expect(
      (await review(fixture.caseId, fixture.puzzle.contentKey, otherToken)).response.status,
    ).toBe(404);
  });
});
