import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { cleanupExpired } from "../src/scheduled";
import { deleteProfileForActor } from "../src/services/profile-deletion-service";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";
import {
  deletionNow,
  seedProfileDeletionGraph,
  telegramDeletionActor,
} from "./helpers/profile-deletion";

async function count(sql: string, ...bindings: unknown[]): Promise<number> {
  const row = await testEnv.DB.prepare(sql)
    .bind(...bindings)
    .first<{ count: number }>();
  if (!row) throw new Error(`Count query returned no row: ${sql}`);
  return row.count;
}

type InactiveSessionState = "missing" | "revoked" | "expired";

async function makeSessionInactive(state: InactiveSessionState, sessionId: string): Promise<void> {
  if (state === "missing") {
    await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  } else if (state === "revoked") {
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(deletionNow - 1, sessionId)
      .run();
  } else {
    await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(deletionNow, sessionId)
      .run();
  }
}

beforeEach(resetDatabase);

afterEach(async () => {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_profile_delete_player").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_abort_profile_delete_player").run();
});

describe("deleteProfileForActor", () => {
  it("atomically keeps the current token as guest and deletes only its player graph", async () => {
    const graph = await seedProfileDeletionGraph();
    const before = await testEnv.DB.prepare(
      `SELECT id, token_hash, channel, created_at, expires_at, revoked_at
         FROM sessions WHERE id = ?`,
    )
      .bind(graph.current.sessionId)
      .first();
    const contentBefore = {
      puzzles: await count("SELECT count(*) AS count FROM puzzles"),
      dailyCases: await count("SELECT count(*) AS count FROM daily_cases"),
      contentImports: await count("SELECT count(*) AS count FROM content_imports"),
    };

    await expect(
      deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
    ).resolves.toEqual({ kind: "guest", profile: null });

    expect(
      await testEnv.DB.prepare(
        `SELECT id, token_hash, channel, created_at, expires_at, revoked_at,
                kind, player_id, rotated_from_session_id, last_seen_at
           FROM sessions WHERE id = ?`,
      )
        .bind(graph.current.sessionId)
        .first(),
    ).toEqual({
      ...before,
      kind: "guest",
      player_id: null,
      rotated_from_session_id: null,
      last_seen_at: deletionNow,
    });
    expect(await count("SELECT count(*) AS count FROM players WHERE id = ?", graph.playerId)).toBe(
      0,
    );
    expect(
      await count("SELECT count(*) AS count FROM sessions WHERE player_id = ?", graph.playerId),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS count FROM attempts WHERE player_id = ?", graph.playerId),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS count FROM auth_flows WHERE player_id = ?", graph.playerId),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS count FROM hint_events WHERE attempt_id IN (?, ?)",
        graph.linkedAttemptIds[0],
        graph.linkedAttemptIds[1],
      ),
    ).toBe(0);

    expect(
      await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
        .bind(graph.unrelatedPlayerId)
        .first(),
    ).toEqual({ id: graph.unrelatedPlayerId });
    expect(
      await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE player_id = ?")
        .bind(graph.unrelatedPlayerId)
        .first(),
    ).toEqual({ kind: "telegram", player_id: graph.unrelatedPlayerId });
    expect(
      await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
        .bind(graph.unrelatedAttemptId)
        .first(),
    ).toEqual({ id: graph.unrelatedAttemptId });
    expect(
      await testEnv.DB.prepare("SELECT attempt_id FROM hint_events WHERE attempt_id = ?")
        .bind(graph.unrelatedAttemptId)
        .first(),
    ).toEqual({ attempt_id: graph.unrelatedAttemptId });
    expect(
      await testEnv.DB.prepare("SELECT id FROM auth_flows WHERE id = ?")
        .bind(graph.unrelatedFlowId)
        .first(),
    ).toEqual({ id: graph.unrelatedFlowId });
    expect(
      await testEnv.DB.prepare("SELECT id FROM auth_flows WHERE id = ?")
        .bind(graph.unlinkedFlowId)
        .first(),
    ).toEqual({ id: graph.unlinkedFlowId });
    expect(
      await testEnv.DB.prepare(
        "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
      )
        .bind(graph.predecessorId)
        .first(),
    ).toEqual({
      kind: "guest",
      player_id: null,
      rotated_from_session_id: graph.ancestorId,
    });
    expect(
      await testEnv.DB.prepare(
        "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
      )
        .bind(graph.ancestorId)
        .first(),
    ).toEqual({ kind: "guest", player_id: null, rotated_from_session_id: null });
    expect({
      puzzles: await count("SELECT count(*) AS count FROM puzzles"),
      dailyCases: await count("SELECT count(*) AS count FROM daily_cases"),
      contentImports: await count("SELECT count(*) AS count FROM content_imports"),
    }).toEqual(contentBefore);
  });

  it("treats an active guest as a byte-for-byte no-op", async () => {
    const guest = await issueGuest("web");
    const before = await testEnv.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(guest.sessionId)
      .first();
    await expect(
      deleteProfileForActor(
        testEnv,
        { sessionId: guest.sessionId, playerId: null, kind: "guest", channel: "web" },
        deletionNow,
      ),
    ).resolves.toEqual({ kind: "guest", profile: null });
    expect(
      await testEnv.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(guest.sessionId).first(),
    ).toEqual(before);
  });

  it.each(["missing", "revoked", "expired"] as const)(
    "rejects an inactive %s guest actor",
    async (state) => {
      const guest = await issueGuest("web");
      await makeSessionInactive(state, guest.sessionId);

      await expect(
        deleteProfileForActor(
          testEnv,
          { sessionId: guest.sessionId, playerId: null, kind: "guest", channel: "web" },
          deletionNow,
        ),
      ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
    },
  );

  it("keeps retained predecessor cleanup eligible after deletion", async () => {
    const graph = await seedProfileDeletionGraph();
    await deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow);
    await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(deletionNow - 2_592_001, graph.predecessorId)
      .run();
    await cleanupExpired(testEnv, deletionNow);
    expect(
      await testEnv.DB.prepare("SELECT id FROM sessions WHERE id = ?")
        .bind(graph.predecessorId)
        .first(),
    ).toBeNull();
    expect(
      await testEnv.DB.prepare("SELECT kind FROM sessions WHERE id = ?")
        .bind(graph.current.sessionId)
        .first(),
    ).toEqual({ kind: "guest" });
  });

  it.each(["missing", "revoked", "expired"] as const)(
    "rejects an inactive %s Telegram actor",
    async (state) => {
      const graph = await seedProfileDeletionGraph();
      const actor = telegramDeletionActor(graph);
      await makeSessionInactive(state, graph.current.sessionId);

      await expect(deleteProfileForActor(testEnv, actor, deletionNow)).rejects.toMatchObject({
        status: 401,
        code: "INVALID_SESSION",
      });
    },
  );

  it.each([
    ["IGNORE", "test_ignore_profile_delete_player"],
    ["ABORT", "test_abort_profile_delete_player"],
  ] as const)("rolls back the full batch when player deletion raises %s", async (mode, name) => {
    const graph = await seedProfileDeletionGraph();
    const raise =
      mode === "IGNORE" ? "RAISE(IGNORE)" : "RAISE(ABORT, 'forced_profile_delete_failure')";
    await testEnv.DB.prepare(
      `CREATE TRIGGER ${name}
         BEFORE DELETE ON players
         WHEN OLD.id = '${graph.playerId}'
         BEGIN
           SELECT ${raise};
         END`,
    ).run();
    await expect(
      deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
    ).rejects.toBeInstanceOf(Error);
    expect(
      await testEnv.DB.prepare(
        "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
      )
        .bind(graph.current.sessionId)
        .first(),
    ).toEqual({
      kind: "telegram",
      player_id: graph.playerId,
      rotated_from_session_id: graph.predecessorId,
    });
    expect(
      await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
    ).not.toBeNull();
    expect(
      await count(
        "SELECT count(*) AS count FROM attempts WHERE id IN (?, ?)",
        graph.linkedAttemptIds[0],
        graph.linkedAttemptIds[1],
      ),
    ).toBe(2);
    expect(
      await testEnv.DB.prepare("SELECT id FROM auth_flows WHERE id = ?")
        .bind(graph.linkedFlowId)
        .first(),
    ).toEqual({ id: graph.linkedFlowId });
    await testEnv.DB.prepare(`DROP TRIGGER ${name}`).run();
    await expect(
      deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
    ).resolves.toEqual({ kind: "guest", profile: null });
  });

  it("classifies a committed deletion after unexpected batch metadata", async () => {
    const graph = await seedProfileDeletionGraph();
    const wrappedDb = new Proxy(testEnv.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const committed = await target.batch(statements);
            return committed.map((result, index) =>
              index === 0 ? { ...result, meta: { ...result.meta, changes: 9 } } : result,
            ) as D1Result[];
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wrappedEnv = Object.assign(Object.create(testEnv) as Env, { DB: wrappedDb });

    await expect(
      deleteProfileForActor(wrappedEnv, telegramDeletionActor(graph), deletionNow),
    ).resolves.toEqual({ kind: "guest", profile: null });
    expect(
      await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
    ).toBeNull();
  });
});
