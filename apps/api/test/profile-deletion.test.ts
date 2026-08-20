import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { cleanupExpired } from "../src/scheduled";
import { deleteProfileForActor } from "../src/services/profile-deletion-service";
import { authenticatedJson, issueGuest, requestJson, resetDatabase, testEnv } from "./helpers/http";
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

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(Date, "now").mockReturnValue(deletionNow * 1_000);
});

afterEach(async () => {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_profile_delete_player").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_abort_profile_delete_player").run();
  vi.restoreAllMocks();
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

describe("DELETE /v1/me", () => {
  it("returns a no-store guest response and safely repeats with the same token", async () => {
    const graph = await seedProfileDeletionGraph();
    const first = await authenticatedJson("/v1/me", graph.current.token, { method: "DELETE" });
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toEqual({ kind: "guest", profile: null });
    expect(JSON.stringify(first.body)).not.toMatch(
      /deleted|count|row|987654321|Deletion Marker Ada/i,
    );

    const second = await authenticatedJson("/v1/me", graph.current.token, { method: "DELETE" });
    expect(second.response.status).toBe(200);
    expect(second.body).toEqual({ kind: "guest", profile: null });
    expect(
      await testEnv.DB.prepare("SELECT count(*) AS count FROM players WHERE id = ?")
        .bind(graph.playerId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("invalidates every other Telegram token linked to the deleted player", async () => {
    const graph = await seedProfileDeletionGraph();
    await authenticatedJson("/v1/me", graph.current.token, { method: "DELETE" });
    const response = await authenticatedJson("/v1/me", graph.other.token);
    expect(response.response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
  });

  it("runs bearer, exact Origin, limiter, then deletion in that order", async () => {
    const graph = await seedProfileDeletionGraph();
    const limit = vi.fn(async () => ({ success: true }));
    const requestEnv = Object.assign(Object.create(testEnv) as Env, {
      AUTH_RATE_LIMITER: { limit },
    });

    const missingBearer = await requestJson(
      "/v1/me",
      { method: "DELETE", headers: { origin: "https://evil.test" } },
      requestEnv,
    );
    expect(missingBearer.response.status).toBe(401);
    expect(limit).not.toHaveBeenCalled();

    const denied = await authenticatedJson(
      "/v1/me",
      graph.current.token,
      { method: "DELETE", headers: { origin: "https://evil.test" } },
      requestEnv,
    );
    expect(denied.response.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    expect(limit).not.toHaveBeenCalled();

    const allowed = await authenticatedJson(
      "/v1/me",
      graph.current.token,
      { method: "DELETE", headers: { origin: "https://agent-axiom.github.io" } },
      requestEnv,
    );
    expect(allowed.response.status).toBe(200);
    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: `profile-delete:${graph.current.sessionId}` });
  });

  it("returns 429 before mutation and applies the limiter to guest no-op retries", async () => {
    const graph = await seedProfileDeletionGraph();
    const deniedLimit = vi.fn(async () => ({ success: false }));
    const requestEnv = Object.assign(Object.create(testEnv) as Env, {
      AUTH_RATE_LIMITER: { limit: deniedLimit },
    });
    const before = await testEnv.DB.prepare(
      "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
    )
      .bind(graph.current.sessionId)
      .first();

    const limited = await authenticatedJson(
      "/v1/me",
      graph.current.token,
      { method: "DELETE" },
      requestEnv,
    );
    expect(limited.response.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(
      await testEnv.DB.prepare(
        "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
      )
        .bind(graph.current.sessionId)
        .first(),
    ).toEqual(before);

    const guest = await issueGuest("web");
    const guestLimited = await authenticatedJson(
      "/v1/me",
      guest.token,
      { method: "DELETE" },
      requestEnv,
    );
    expect(guestLimited.response.status).toBe(429);
    expect(deniedLimit).toHaveBeenLastCalledWith({
      key: `profile-delete:${guest.sessionId}`,
    });
  });

  it.each(["revoked", "expired"] as const)(
    "rejects a %s bearer before the limiter or deletion",
    async (state) => {
      const graph = await seedProfileDeletionGraph();
      const limit = vi.fn(async () => ({ success: true }));
      const requestEnv = Object.assign(Object.create(testEnv) as Env, {
        AUTH_RATE_LIMITER: { limit },
      });
      const column = state === "revoked" ? "revoked_at" : "expires_at";
      const value = state === "revoked" ? deletionNow - 1 : deletionNow;
      await testEnv.DB.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`)
        .bind(value, graph.current.sessionId)
        .run();

      const response = await authenticatedJson(
        "/v1/me",
        graph.current.token,
        { method: "DELETE" },
        requestEnv,
      );

      expect(response.response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
      expect(limit).not.toHaveBeenCalled();
      expect(
        await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
          .bind(graph.playerId)
          .first(),
      ).toEqual({ id: graph.playerId });
    },
  );

  it("rejects an unknown bearer before the limiter", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const requestEnv = Object.assign(Object.create(testEnv) as Env, {
      AUTH_RATE_LIMITER: { limit },
    });

    const response = await authenticatedJson(
      "/v1/me",
      "A".repeat(43),
      { method: "DELETE" },
      requestEnv,
    );

    expect(response.response.status).toBe(401);
    expect(response.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
    expect(limit).not.toHaveBeenCalled();
  });

  it("terminates exact CORS preflight before auth, origin checks, limiting, or deletion", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const requestEnv = Object.assign(Object.create(testEnv) as Env, {
      AUTH_RATE_LIMITER: { limit },
    });
    const allowed = await app.fetch(
      new Request("https://api.test/v1/me", {
        method: "OPTIONS",
        headers: { origin: "https://agent-axiom.github.io" },
      }),
      requestEnv,
    );
    const denied = await app.fetch(
      new Request("https://api.test/v1/me", {
        method: "OPTIONS",
        headers: { origin: "https://agent-axiom.github.io.evil.test" },
      }),
      requestEnv,
    );

    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://agent-axiom.github.io",
    );
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET,POST,DELETE,OPTIONS");
    expect(denied.status).toBe(204);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-methods")).toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it("returns a generic internal error and rolls back when deletion is incomplete", async () => {
    const graph = await seedProfileDeletionGraph();
    await testEnv.DB.prepare(
      `CREATE TRIGGER test_ignore_profile_delete_player
         BEFORE DELETE ON players
         WHEN OLD.id = '${graph.playerId}'
         BEGIN
           SELECT RAISE(IGNORE);
         END`,
    ).run();

    const response = await authenticatedJson("/v1/me", graph.current.token, {
      method: "DELETE",
    });

    expect(response.response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error.",
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /987654321|Deletion Marker Ada|delete_marker|player|attempt|row|SQL/i,
    );
    expect(
      await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
    ).toEqual({ id: graph.playerId });
  });

  it("logs only path-level deletion metadata without profile or query details", async () => {
    const graph = await seedProfileDeletionGraph();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    const response = await authenticatedJson(
      "/v1/me?telegramUserId=attacker-controlled",
      graph.current.token,
      { method: "DELETE" },
    );

    expect(response.response.status).toBe(200);
    expect(response.body).toEqual({ kind: "guest", profile: null });
    const deletionLogs = logs.filter((line) => line.includes('"method":"DELETE"'));
    expect(deletionLogs).toHaveLength(1);
    expect(JSON.parse(deletionLogs[0] ?? "{}")).toMatchObject({
      method: "DELETE",
      path: "/v1/me",
      status: 200,
      sessionKind: "telegram",
    });
    const serialized = logs.join("\n");
    for (const secret of [
      graph.current.token,
      graph.current.tokenHash,
      graph.playerId,
      graph.telegramUserId,
      "Deletion Marker Ada",
      "delete_marker",
      "delete-marker.png",
      "attacker-controlled",
      "deletedRows",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
