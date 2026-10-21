import {
  AttemptResultSchema,
  ClueResponseSchema,
  DailyCaseResponseSchema,
  HintResponseSchema,
  StatsResponseSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { publicPuzzleId } from "../src/db/puzzle-identity";
import { upsertOidcPlayer } from "../src/db/players";
import type { SessionActor } from "../src/env";
import { cleanupExpired } from "../src/scheduled";
import {
  exchangeHandoffAndLinkGuest,
  linkGuestToPlayer,
} from "../src/services/account-link-service";
import { makePuzzleFixture, seedContentFixture } from "./fixtures/content";
import { verifiedOidcIdentity } from "./fixtures/telegram";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";

const now = new Date("2026-10-15T12:00:00Z");
const seconds = Math.floor(now.getTime() / 1_000);
const app = createApp({ now: () => now });
const progressHeaders = { "x-game-progress": "1", "x-content-locales": "1" };

async function call(path: string, token: string, body?: unknown, progress = true) {
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    ...(progress ? progressHeaders : {}),
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await app.fetch(
    new Request(`https://api.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    testEnv,
  );
  return { response, body: await response.json() };
}

async function fixture() {
  const content = await seedContentFixture(testEnv.DB, {
    id: "case-2026-10-15",
    date: "2026-10-15",
  });
  return { ...content, alias: publicPuzzleId(content.caseId, 1, content.puzzle.public.version) };
}

function answer(
  content: Awaited<ReturnType<typeof fixture>>,
  correct = true,
  attemptUuid = crypto.randomUUID(),
) {
  return {
    attemptUuid,
    caseId: content.caseId,
    puzzleId: content.alias,
    retraction: correct
      ? content.puzzle.solution.retraction
      : {
          ...content.puzzle.solution.retraction,
          movedPiece: { color: "b", type: "p" },
          restoredPiece: null,
          special: "normal",
        },
  };
}
function actor(
  guest: Awaited<ReturnType<typeof issueGuest>>,
  channel: SessionActor["channel"],
): SessionActor {
  return { sessionId: guest.sessionId, playerId: null, kind: "guest", channel };
}

async function mergeLogin(
  guest: Awaited<ReturnType<typeof issueGuest>>,
  channel: "telegram" | "web",
) {
  if (channel === "telegram") {
    return linkGuestToPlayer(testEnv, actor(guest, channel), verifiedOidcIdentity, seconds);
  }
  const player = await upsertOidcPlayer(testEnv.DB, verifiedOidcIdentity, seconds);
  const handoffHash = crypto.randomUUID();
  await testEnv.DB.prepare(`INSERT INTO auth_flows
    (id,state_hash,guest_session_id,channel,nonce,pkce_verifier,expires_at,
     callback_claimed_at,player_id,handoff_hash,handoff_expires_at,created_at)
    VALUES (?, ?, ?, 'web', 'nonce', 'verifier', ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(), crypto.randomUUID(), guest.sessionId, seconds + 600,
      seconds, player.id, handoffHash, seconds + 60, seconds,
    )
    .run();
  return exchangeHandoffAndLinkGuest(
    testEnv, actor(guest, channel), { handoffHash, channel }, seconds,
  );
}

async function solveForPoints(
  content: Awaited<ReturnType<typeof fixture>>,
  token: string,
  assisted: boolean,
) {
  if (assisted) {
    await call(`/v1/cases/${content.caseId}/puzzles/${content.alias}/clue`, token, {});
    await call("/v1/attempts", token, answer(content, false));
  }
  const solved = AttemptResultSchema.parse((await call("/v1/attempts", token, answer(content))).body);
  expect(solved.progress?.earnedPoints).toBe(assisted ? 35 : 100);
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
  await resetDatabase();
});
afterEach(() => vi.restoreAllMocks());

describe("server-authoritative clues and personal points", () => {
  it.each([
    ["telegram", false], ["telegram", true], ["web", false], ["web", true],
  ] as const)("merges best results through %s when desktop is better: %s", async (channel, desktopBetter) => {
    const content = await fixture();
    const extra = await seedContentFixture(testEnv.DB, {
      id: "case-extra", date: "2026-10-14",
      puzzle: makePuzzleFixture({ contentKey: "extra-puzzle" }),
    });
    const extraContent = {
      ...extra, alias: publicPuzzleId(extra.caseId, 1, extra.puzzle.public.version),
    };
    const desktop = await mergeLogin(await issueGuest("web"), "web");
    await solveForPoints(content, desktop.token, !desktopBetter);
    const phone = await issueGuest(channel);
    await solveForPoints(content, phone.token, desktopBetter);
    await solveForPoints(extraContent, phone.token, false);

    const linked = await mergeLogin(phone, channel);
    expect(linked.profile.telegramUserId).toBe(desktop.profile.telegramUserId);
    for (const token of [linked.token, desktop.token]) {
      const stats = StatsResponseSchema.parse((await call("/v1/me/stats", token)).body);
      expect(stats).toMatchObject({ points: 200, solvedPuzzles: 2 });
      const daily = DailyCaseResponseSchema.parse((await call("/v1/daily", token)).body);
      expect(daily.progressStates?.[content.alias]).toMatchObject({
        earnedPoints: 100, attemptCount: 1, assistanceCount: 0, clueUnlocked: true,
      });
    }
    // A later lower-scoring device must neither lower the award nor add duplicate points.
    const another = await issueGuest(channel);
    await solveForPoints(content, another.token, true);
    const repeated = await mergeLogin(another, channel);
    await call("/v1/attempts", repeated.token, answer(content));
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", repeated.token)).body))
      .toMatchObject({ points: 200, solvedPuzzles: 2 });
    expect((await testEnv.DB.prepare("SELECT count(*) AS n FROM merged_puzzle_awards")
      .first<{ n: number }>())?.n).toBe(2);
    const outsider = await issueGuest();
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", outsider.token)).body).points).toBe(0);

    // Old guest-session cleanup keeps linked attempts and their preserved awards.
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id = ?")
      .bind(phone.sessionId).run();
    await cleanupExpired(testEnv, seconds);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", repeated.token)).body).points).toBe(200);
    const deleted = await app.fetch(new Request("https://api.test/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${repeated.token}`, origin: "https://chess.kosarevsky.dev" },
    }), testEnv);
    expect(deleted.status).toBe(200);
    expect((await testEnv.DB.prepare("SELECT count(*) AS n FROM merged_puzzle_awards")
      .first<{ n: number }>())?.n).toBe(0);
  });

  it("rolls back preserved awards together with a failed guest-account merge", async () => {
    const content = await fixture();
    const desktop = await mergeLogin(await issueGuest("web"), "web");
    await solveForPoints(content, desktop.token, true);
    const phone = await issueGuest("telegram");
    await solveForPoints(content, phone.token, false);
    await testEnv.DB.prepare(`CREATE TRIGGER test_fail_mini_app_revoke
      BEFORE UPDATE OF revoked_at ON sessions
      WHEN OLD.id = '${phone.sessionId}' AND NEW.revoked_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'synthetic merge rollback'); END`).run();
    await expect(mergeLogin(phone, "telegram")).rejects.toThrow();
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", desktop.token)).body).points).toBe(35);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", phone.token)).body).points).toBe(100);
    expect((await testEnv.DB.prepare("SELECT count(*) AS n FROM merged_puzzle_awards")
      .first<{ n: number }>())?.n).toBe(0);
  });

  it("masks default titles, prompts and semantic IDs, then records a clue once before disclosure", async () => {
    const content = await fixture();
    await testEnv.DB.prepare("UPDATE puzzles SET public_json = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          ...content.puzzle.public,
          localizations: {
            ru: {
              title: "Embedded spoiler",
              prompt: "Embedded prompt",
              provenance: "Author",
              license: "License",
            },
          },
        }),
        content.puzzle.rowId,
      )
      .run();
    const guest = await issueGuest();
    const stranger = await issueGuest();
    const daily = DailyCaseResponseSchema.parse(
      (await call("/v1/daily", guest.token, undefined, false)).body,
    );
    expect(daily.title).toBe("Daily case");
    expect(daily.puzzles[0]).toMatchObject({
      id: content.alias,
      title: "Puzzle 1",
      prompt: "Reconstruct the last move.",
    });
    expect(JSON.stringify(daily)).not.toContain(content.puzzle.contentKey);
    expect(JSON.stringify(daily)).not.toContain("Embedded spoiler");
    expect(JSON.stringify(daily)).not.toContain("Embedded prompt");
    expect(JSON.stringify(daily)).not.toContain(content.puzzle.public.prompt);
    expect(daily.puzzles[0]?.localizations).toBeUndefined();
    expect(daily.progressStates).toBeUndefined();
    const masked = DailyCaseResponseSchema.parse((await call("/v1/daily", guest.token)).body);
    expect(masked.puzzles[0]?.prompt).toBe("Reconstruct the last move.");
    expect(masked.progressStates?.[content.alias]?.clueUnlocked).toBe(false);
    const path = `/v1/cases/${content.caseId}/puzzles/${content.alias}/clue`;
    const clue = ClueResponseSchema.parse((await call(path, guest.token, {})).body);
    expect(clue.title).toBe(content.puzzle.public.title);
    expect(clue.prompt).toBe(content.puzzle.public.prompt);
    expect(clue.progress).toMatchObject({
      clueUnlocked: true,
      assistanceCount: 1,
      nextAttemptPoints: 50,
    });
    await call(path, guest.token, {});
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM gameplay_events WHERE kind = 'clue'",
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const restored = DailyCaseResponseSchema.parse((await call("/v1/daily", guest.token)).body);
    expect(restored.title).toBe("The missing pawn");
    expect(restored.puzzles[0]?.title).toBe(content.puzzle.public.title);
    expect(restored.puzzles[0]?.prompt).toBe(content.puzzle.public.prompt);
    expect(restored.progressStates?.[content.alias]?.clueUnlocked).toBe(true);
    expect(
      DailyCaseResponseSchema.parse((await call("/v1/daily", stranger.token)).body).puzzles[0]
        ?.title,
    ).toBe("Puzzle 1");
    expect(
      DailyCaseResponseSchema.parse((await call("/v1/daily", stranger.token)).body).puzzles[0]
        ?.prompt,
    ).toBe("Reconstruct the last move.");
  });

  it("awards a first solve once and treats alias/canonical UUID replays as one puzzle", async () => {
    const content = await fixture();
    const guest = await issueGuest();
    const body = answer(content);
    const original = await call("/v1/attempts", guest.token, body);
    const solved = AttemptResultSchema.parse(original.body);
    expect(original.response.status).toBe(201);
    expect(solved.progress).toMatchObject({
      attemptCount: 1,
      earnedPoints: 100,
      awardAttemptId: solved.id,
      nextAttemptPoints: 0,
    });
    const canonicalReplay = await call("/v1/attempts", guest.token, {
      ...body,
      puzzleId: content.puzzle.contentKey,
    });
    expect(canonicalReplay.response.status).toBe(200);
    expect(AttemptResultSchema.parse(canonicalReplay.body).progress).toEqual(solved.progress);
    const again = AttemptResultSchema.parse(
      (await call("/v1/attempts", guest.token, answer(content))).body,
    );
    expect(again.id).not.toBe(solved.id);
    expect(again.progress?.awardAttemptId).toBe(solved.id);
    expect(again.progress?.earnedPoints).toBe(100);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", guest.token)).body)).toMatchObject(
      { points: 100, attempts: 2 },
    );
    expect(
      StatsResponseSchema.parse((await call("/v1/me/stats", guest.token, undefined, false)).body)
        .points,
    ).toBeUndefined();
    const stored = await testEnv.DB.prepare("SELECT response_json FROM attempts WHERE id = ?")
      .bind(solved.id)
      .first<{ response_json: string }>();
    expect(stored?.response_json).not.toContain("progress");
    const daily = DailyCaseResponseSchema.parse((await call("/v1/daily", guest.token)).body);
    expect(daily.solvedPuzzleIds).toEqual([content.alias]);
    expect(daily.progressStates?.[content.alias]?.earnedPoints).toBe(100);
    expect(daily.puzzles[0]?.prompt).toBe(content.puzzle.public.prompt);
  });

  it("halves the second-attempt reward for a title clue and each distinct hint", async () => {
    const content = await fixture();
    const guest = await issueGuest();
    const wrongBody = answer(content, false);
    const wrong = AttemptResultSchema.parse(
      (await call("/v1/attempts", guest.token, wrongBody)).body,
    );
    await call("/v1/attempts", guest.token, wrongBody);
    await call(`/v1/cases/${content.caseId}/puzzles/${content.alias}/clue`, guest.token, {});
    const path = `/v1/attempts/${wrong.id}/hints`;
    const hint = HintResponseSchema.parse((await call(path, guest.token, { level: 1 })).body);
    expect(hint.progress).toMatchObject({
      attemptCount: 1,
      assistanceCount: 2,
      nextAttemptPoints: 17,
    });
    await call(path, guest.token, { level: 1 });
    const solved = AttemptResultSchema.parse(
      (await call("/v1/attempts", guest.token, answer(content))).body,
    );
    expect(solved.progress).toMatchObject({
      attemptCount: 2,
      assistanceCount: 2,
      earnedPoints: 17,
    });
    const reload = DailyCaseResponseSchema.parse((await call("/v1/daily", guest.token)).body);
    expect(reload.progressStates?.[content.alias]?.earnedHints).toHaveLength(1);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", guest.token)).body)).toMatchObject(
      { points: 17, attempts: 2, hintsUsed: 1 },
    );
  });

  it("continues earned hint levels across failed attempts and hint-text retention", async () => {
    const content = await fixture();
    const guest = await issueGuest();
    const first = AttemptResultSchema.parse(
      (await call("/v1/attempts", guest.token, answer(content, false))).body,
    );
    await call(`/v1/attempts/${first.id}/hints`, guest.token, { level: 1 });
    const second = AttemptResultSchema.parse(
      (await call("/v1/attempts", guest.token, answer(content, false))).body,
    );
    await testEnv.DB.prepare("DELETE FROM hint_events").run();
    await call(`/v1/attempts/${second.id}/hints`, guest.token, { level: 1 });
    const next = HintResponseSchema.parse(
      (await call(`/v1/attempts/${second.id}/hints`, guest.token, { level: 2 })).body,
    );
    expect(next.progress).toMatchObject({
      highestHintLevel: 2,
      assistanceCount: 2,
      nextAttemptPoints: 10,
    });
    expect(next.progress?.earnedHints).toHaveLength(2);
    expect(
      StatsResponseSchema.parse((await call("/v1/me/stats", guest.token)).body).hintsUsed,
    ).toBe(2);
  });

  it("serializes competing correct UUIDs into one first-solve award", async () => {
    const content = await fixture();
    const guest = await issueGuest();
    const attempts = await Promise.all([
      call("/v1/attempts", guest.token, answer(content)),
      call("/v1/attempts", guest.token, answer(content)),
    ]);
    const results = attempts.map((result) => AttemptResultSchema.parse(result.body));
    expect(results[0]?.progress?.awardAttemptId).toBe(results[1]?.progress?.awardAttemptId);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", guest.token)).body).points).toBe(
      100,
    );
  });

  it("transfers clue-only Mini App history, survives old-session cleanup, and deletes profile points", async () => {
    const content = await fixture();
    const guest = await issueGuest("telegram");
    await call(`/v1/cases/${content.caseId}/puzzles/${content.alias}/clue`, guest.token, {});
    const linked = await linkGuestToPlayer(
      testEnv,
      actor(guest, "telegram"),
      verifiedOidcIdentity,
      seconds,
    );
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id = ?")
      .bind(guest.sessionId)
      .run();
    await cleanupExpired(testEnv, seconds);
    const solved = AttemptResultSchema.parse(
      (await call("/v1/attempts", linked.token, answer(content))).body,
    );
    expect(solved.progress).toMatchObject({ earnedPoints: 50, assistanceCount: 1 });
    const response = await app.fetch(
      new Request("https://api.test/v1/me", {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${linked.token}`,
          origin: "https://chess.kosarevsky.dev",
        },
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(StatsResponseSchema.parse((await call("/v1/me/stats", linked.token)).body).points).toBe(
      0,
    );
    expect(
      (
        await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM gameplay_events").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("transfers clue-only browser handoff history in the guarded account-link transaction", async () => {
    const content = await fixture();
    const guest = await issueGuest("web");
    await call(`/v1/cases/${content.caseId}/puzzles/${content.alias}/clue`, guest.token, {});
    const playerId = crypto.randomUUID();
    await testEnv.DB.prepare(
      "INSERT INTO players (id,telegram_user_id,display_name,created_at,updated_at) VALUES (?,?,'Player',?,?)",
    )
      .bind(playerId, "10101", seconds, seconds)
      .run();
    await testEnv.DB.prepare(`INSERT INTO auth_flows (id,state_hash,guest_session_id,channel,nonce,pkce_verifier,expires_at,callback_claimed_at,player_id,handoff_hash,handoff_expires_at,created_at)
      VALUES (?, ?, ?, 'web', 'nonce', 'verifier', ?, ?, ?, 'handoff-hash', ?, ?)`)
      .bind(
        crypto.randomUUID(),
        "state-hash",
        guest.sessionId,
        seconds + 600,
        seconds,
        playerId,
        seconds + 60,
        seconds,
      )
      .run();
    const linked = await exchangeHandoffAndLinkGuest(
      testEnv,
      actor(guest, "web"),
      { handoffHash: "handoff-hash", channel: "web" },
      seconds,
    );
    const solved = AttemptResultSchema.parse(
      (await call("/v1/attempts", linked.token, answer(content))).body,
    );
    expect(solved.progress).toMatchObject({ earnedPoints: 50, assistanceCount: 1 });
  });
});
