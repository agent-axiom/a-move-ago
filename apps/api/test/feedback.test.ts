import { ErrorEnvelopeSchema, FeedbackResponseSchema } from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env, SessionActor } from "../src/env";
import { cleanupExpired } from "../src/scheduled";
import { submitPuzzleFeedback } from "../src/services/feedback-service";
import { deleteProfileForActor } from "../src/services/profile-deletion-service";
import { seedContentFixture } from "./fixtures/content";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";

const now = new Date("2026-10-20T12:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const app = createApp({ now: () => now });

function input() {
  return {
    reportUuid: crypto.randomUUID(),
    caseId: "case-2026-08-03",
    puzzleId: "opening-exd5",
    puzzleVersion: 1,
    locale: "ru" as const,
    reason: "alternative_answer" as const,
    comment: "A different return square may also be possible.",
  };
}

async function send(body: unknown, token?: string, options: { origin?: string; env?: Env } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (options.origin) headers.set("origin", options.origin);
  const response = await app.fetch(
    new Request("https://api.test/v1/feedback", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    options.env ?? testEnv,
  );
  return { response, body: (await response.json()) as unknown };
}

async function countReports() {
  return await testEnv.DB.prepare("SELECT count(*) AS count FROM puzzle_feedback").first<number>(
    "count",
  );
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
  await resetDatabase();
  await seedContentFixture(testEnv.DB);
});
afterEach(() => vi.restoreAllMocks());

describe("private puzzle feedback", () => {
  it("requires an active session and rejects disallowed browser origins", async () => {
    expect((await send(input())).response.status).toBe(401);
    const guest = await issueGuest();
    expect(
      (await send(input(), guest.token, { origin: "https://untrusted.invalid" })).response.status,
    ).toBe(403);
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(timestamp, guest.sessionId)
      .run();
    expect((await send(input(), guest.token)).response.status).toBe(401);
    expect(await countReports()).toBe(0);
  });

  it("stores a deliberate report and confirms duplicate receipt once", async () => {
    const guest = await issueGuest();
    const report = input();
    const first = await send(report, guest.token);
    expect(first.response.status).toBe(201);
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    expect(FeedbackResponseSchema.parse(first.body)).toEqual({
      reportUuid: report.reportUuid,
      received: true,
    });
    const row = await testEnv.DB.prepare("SELECT * FROM puzzle_feedback").first();
    expect(row).toMatchObject({
      session_id: guest.sessionId,
      player_id: null,
      puzzle_id: "opening-exd5:v1",
      locale: "ru",
      reason: "alternative_answer",
      comment: report.comment,
      created_at: timestamp,
    });
    expect(JSON.stringify(row)).not.toContain(guest.token);
    expect(JSON.stringify(row)).not.toContain("reveal-secret");
    const again = await send(report, guest.token);
    expect(again.response.status).toBe(200);
    expect(again.response.headers.get("idempotency-replayed")).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await countReports()).toBe(1);
    expect(
      await testEnv.DB.prepare("SELECT count(*) AS count FROM attempts").first<number>("count"),
    ).toBe(0);
    expect(
      await testEnv.DB.prepare("SELECT count(*) AS count FROM gameplay_events").first<number>(
        "count",
      ),
    ).toBe(0);
  });

  it("rejects changed payloads and isolates report UUIDs by guest", async () => {
    const owner = await issueGuest();
    const other = await issueGuest();
    const report = input();
    await send(report, owner.token);
    const conflict = await send({ ...report, comment: "A changed report" }, owner.token);
    expect(conflict.response.status).toBe(409);
    expect(ErrorEnvelopeSchema.parse(conflict.body).error.code).toBe("FEEDBACK_CONFLICT");
    expect(
      (await send({ ...report, comment: "Another guest's report" }, other.token)).response.status,
    ).toBe(201);
    expect(await countReports()).toBe(2);
    const response = await app.fetch(new Request("https://api.test/v1/feedback"), testEnv);
    expect(response.status).toBe(404);
  });

  it("validates fields and bounds both comments and the request body", async () => {
    const guest = await issueGuest();
    for (const body of [
      { ...input(), comment: "x".repeat(1_001) },
      { ...input(), comment: "x".repeat(9_000) },
      { ...input(), locale: "de" },
      { ...input(), reason: "unknown" },
      { ...input(), retraction: { currentSquare: "d5" } },
    ]) {
      const result = await send(body, guest.token);
      expect(result.response.status).toBe(400);
      expect(ErrorEnvelopeSchema.parse(result.body).error.code).toBe("INVALID_REQUEST");
    }
    expect(await countReports()).toBe(0);
  });

  it("accepts public aliases and rejects invalid membership or versions", async () => {
    const guest = await issueGuest();
    expect(
      (await send({ ...input(), puzzleId: "p-case-2026-08-03-1-v1" }, guest.token)).response.status,
    ).toBe(201);
    for (const change of [
      { puzzleId: "unknown" },
      { caseId: "another-case" },
      { puzzleVersion: 2 },
    ]) {
      expect((await send({ ...input(), ...change }, guest.token)).response.status).toBe(404);
    }
    expect(await countReports()).toBe(1);
  });

  it("rejects future, retired and draft content without exposing any solution", async () => {
    const guest = await issueGuest();
    for (const sql of [
      "UPDATE daily_cases SET case_date = '2026-10-21'",
      "UPDATE daily_cases SET case_date = '2026-08-03', status = 'retired'",
      "UPDATE daily_cases SET status = 'draft', published_at = NULL",
    ]) {
      await testEnv.DB.prepare(sql).run();
      const result = await send(input(), guest.token);
      expect(result.response.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain("reveal-secret");
    }
    await testEnv.DB.prepare("UPDATE daily_cases SET status = 'published', published_at = 1").run();
    await testEnv.DB.prepare("UPDATE puzzles SET status = 'draft'").run();
    expect((await send(input(), guest.token)).response.status).toBe(404);
    expect(await countReports()).toBe(0);
  });

  it("uses a separate limiter key and enforces the quota atomically", async () => {
    const guest = await issueGuest();
    const limit = vi.fn().mockResolvedValue({ success: false });
    const originalLimiter = testEnv.HINT_RATE_LIMITER;
    // Define an own binding: assigning through the Workers env prototype can
    // invoke an inherited setter and replace the shared test binding.
    const envWithLimit = Object.create(testEnv, {
      HINT_RATE_LIMITER: { value: { limit } },
    }) as Env;
    expect((await send(input(), guest.token, { env: envWithLimit })).response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: `feedback:${guest.sessionId}` });
    expect(testEnv.HINT_RATE_LIMITER).toBe(originalLimiter);
    const report = input();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => send(index === 0 ? report : input(), guest.token)),
    );
    expect(results.filter((result) => result.response.status === 201)).toHaveLength(5);
    expect(results.filter((result) => result.response.status === 429)).toHaveLength(3);
    expect(await countReports()).toBe(5);
    const persisted = await testEnv.DB.prepare(
      "SELECT report_uuid FROM puzzle_feedback WHERE session_id = ? LIMIT 1",
    )
      .bind(guest.sessionId)
      .first<{ report_uuid: string }>();
    expect(persisted).not.toBeNull();
    expect(
      (await send({ ...input(), reportUuid: persisted?.report_uuid }, guest.token)).response.status,
    ).toBe(200);
  });

  it("rechecks session ownership at the write boundary", async () => {
    const guest = await issueGuest();
    const actor: SessionActor = {
      sessionId: guest.sessionId,
      kind: "guest",
      playerId: null,
      channel: "web",
    };
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(timestamp, guest.sessionId)
      .run();
    await expect(submitPuzzleFeedback(testEnv, actor, input(), timestamp)).rejects.toMatchObject({
      status: 401,
    });
    expect(await countReports()).toBe(0);
  });

  it("shares the rolling quota across sessions of the same Telegram player", async () => {
    const first = await issueGuest();
    const second = await issueGuest();
    await testEnv.DB.prepare(
      `INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('reporter', '12345', 'Synthetic player', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET kind = 'telegram', player_id = 'reporter' WHERE id IN (?, ?)",
    )
      .bind(first.sessionId, second.sessionId)
      .run();
    for (let index = 0; index < 5; index += 1) {
      expect((await send(input(), first.token)).response.status).toBe(201);
    }
    expect((await send(input(), second.token)).response.status).toBe(429);
    expect(await countReports()).toBe(5);
  });

  it("confirms old receipts after retirement but rejects new reports", async () => {
    const guest = await issueGuest();
    const report = input();
    expect((await send(report, guest.token)).response.status).toBe(201);
    await testEnv.DB.prepare("UPDATE puzzles SET status = 'retired'").run();
    expect((await send(report, guest.token)).response.status).toBe(200);
    expect((await send(input(), guest.token)).response.status).toBe(404);
    expect(await countReports()).toBe(1);
  });

  it("deletes profile feedback and preserves unrelated guest reports", async () => {
    const linked = await issueGuest();
    const other = await issueGuest();
    await testEnv.DB.prepare(
      `INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at)
       VALUES ('reporter', '12345', 'Synthetic player', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
    await testEnv.DB.prepare(
      "UPDATE sessions SET kind = 'telegram', player_id = 'reporter' WHERE id = ?",
    )
      .bind(linked.sessionId)
      .run();
    expect((await send(input(), linked.token)).response.status).toBe(201);
    expect((await send(input(), other.token)).response.status).toBe(201);
    await deleteProfileForActor(
      testEnv,
      {
        sessionId: linked.sessionId,
        playerId: "reporter",
        kind: "telegram",
        channel: "web",
      },
      timestamp,
    );
    expect(await countReports()).toBe(1);
    expect(await testEnv.DB.prepare("SELECT session_id FROM puzzle_feedback").first()).toEqual({
      session_id: other.sessionId,
    });
  });

  it("cleans reports after 30 days and when their guest session expires", async () => {
    const guest = await issueGuest();
    const old = input();
    const recent = input();
    await send(old, guest.token);
    await send(recent, guest.token);
    await testEnv.DB.prepare("UPDATE puzzle_feedback SET created_at = ? WHERE report_uuid = ?")
      .bind(timestamp - 31 * 86_400, old.reportUuid)
      .run();
    await cleanupExpired(testEnv, timestamp);
    expect(await countReports()).toBe(1);
    expect(await testEnv.DB.prepare("SELECT report_uuid FROM puzzle_feedback").first()).toEqual({
      report_uuid: recent.reportUuid,
    });
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(timestamp - 1, guest.sessionId)
      .run();
    await cleanupExpired(testEnv, timestamp);
    expect(await countReports()).toBe(0);
  });
});
