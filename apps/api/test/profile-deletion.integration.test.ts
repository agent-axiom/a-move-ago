import {
  ApiTransportError,
  createApiClient,
  OidcStartResponseSchema,
  TelegramSessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { TelegramOidcProvider } from "../src/auth/telegram-oidc";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import { linkGuestToPlayer } from "../src/services/account-link-service";
import { deleteProfileForActor } from "../src/services/profile-deletion-service";
import { verifiedOidcIdentity } from "./fixtures/telegram";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";
import {
  deletionNow,
  seedProfileDeletionGraph,
  telegramDeletionActor,
} from "./helpers/profile-deletion";

const app = createApp({ now: () => new Date(deletionNow * 1_000) });
const d1AuthSessionExpiry = 4_102_444_800; // 2100-01-01T00:00:00Z

// Auth-link SQL intentionally checks D1's unixepoch(), which a Date.now spy cannot freeze.
async function keepGuestActiveForD1Auth(sessionId: string): Promise<void> {
  const result = await testEnv.DB.prepare(
    `UPDATE sessions SET expires_at = ?
      WHERE id = ? AND kind = 'guest' AND player_id IS NULL`,
  )
    .bind(d1AuthSessionExpiry, sessionId)
    .run();
  expect(result.meta.changes).toBe(1);
}

async function remove(token: string, requestEnv: Env = testEnv): Promise<Response> {
  return app.fetch(
    new Request("https://api.test/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    requestEnv,
  );
}

function blockConcurrentBatches(expectedArrivals = 2): {
  requestEnv: Env;
  allArrived: Promise<void>;
  release: () => void;
  arrivalCount: () => number;
} {
  let arrivals = 0;
  let resolveAllArrived: (() => void) | undefined;
  let releaseBatches: (() => void) | undefined;
  const allArrived = new Promise<void>((resolve) => {
    resolveAllArrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseBatches = resolve;
  });
  const proxyDb = new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          arrivals += 1;
          if (arrivals === expectedArrivals) resolveAllArrived?.();
          await released;
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    requestEnv: Object.assign(Object.create(testEnv) as Env, { DB: proxyDb }),
    allArrived,
    release: () => releaseBatches?.(),
    arrivalCount: () => arrivals,
  };
}

async function playerIdForTelegramUser(telegramUserId: string): Promise<string> {
  const player = await testEnv.DB.prepare("SELECT id FROM players WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ id: string }>();
  if (!player) throw new Error(`Player ${telegramUserId} was not persisted.`);
  return player.id;
}

async function expectOldAttemptsAbsent(attemptIds: string[]): Promise<void> {
  for (const attemptId of attemptIds) {
    expect(
      await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?").bind(attemptId).first(),
    ).toBeNull();
  }
}

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(Date, "now").mockReturnValue(deletionNow * 1_000);
});

afterEach(() => vi.restoreAllMocks());

it("converges two same-token DELETE requests on one surviving guest", async () => {
  const graph = await seedProfileDeletionGraph();
  const batches = blockConcurrentBatches();
  const pendingResponses = [
    remove(graph.current.token, batches.requestEnv),
    remove(graph.current.token, batches.requestEnv),
  ];

  await batches.allArrived;
  expect(batches.arrivalCount()).toBe(2);
  batches.release();
  const responses = await Promise.all(pendingResponses);

  expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
  await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
    { kind: "guest", profile: null },
    { kind: "guest", profile: null },
  ]);
  expect(
    await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE id = ?")
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({ kind: "guest", player_id: null });
  expect(
    await testEnv.DB.prepare("SELECT count(*) AS count FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).toEqual({ count: 0 });
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("lets one of two linked sessions survive and invalidates the other", async () => {
  const graph = await seedProfileDeletionGraph();
  const batches = blockConcurrentBatches();
  const pendingResponses = [
    remove(graph.current.token, batches.requestEnv),
    remove(graph.other.token, batches.requestEnv),
  ];

  await batches.allArrived;
  expect(batches.arrivalCount()).toBe(2);
  batches.release();
  const responses = await Promise.all(pendingResponses);

  expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  const winningIndex = responses.findIndex((response) => response.status === 200);
  const survivingSessionId = winningIndex === 0 ? graph.current.sessionId : graph.other.sessionId;
  const competingRows = await testEnv.DB.prepare(
    `SELECT id, kind, player_id FROM sessions WHERE id IN (?, ?) ORDER BY id`,
  )
    .bind(graph.current.sessionId, graph.other.sessionId)
    .all<{ id: string; kind: string; player_id: string | null }>();
  expect(competingRows.results).toHaveLength(1);
  expect(competingRows.results[0]).toMatchObject({
    id: survivingSessionId,
    kind: "guest",
    player_id: null,
  });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
  ).toBeNull();
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("retries the same token after its committed DELETE response is lost", async () => {
  const graph = await seedProfileDeletionGraph();
  let loseResponse = true;
  let discardedResponse: { status: number; body: unknown } | undefined;
  const api = createApiClient({
    baseUrl: "https://api.test",
    getToken: () => graph.current.token,
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input, init), testEnv);
      if (loseResponse) {
        loseResponse = false;
        discardedResponse = { status: response.status, body: await response.clone().json() };
        throw new TypeError("response lost after commit");
      }
      return response;
    },
  });

  await expect(api.deleteProfile()).rejects.toBeInstanceOf(ApiTransportError);
  expect(discardedResponse).toEqual({
    status: 200,
    body: { kind: "guest", profile: null },
  });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
  ).toBeNull();
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
  await expect(api.deleteProfile()).resolves.toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE id = ?")
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({ kind: "guest", player_id: null });
});

it("recovers when D1 commits deletion before losing its batch acknowledgement", async () => {
  const graph = await seedProfileDeletionGraph();
  let loseAcknowledgement = true;
  const proxyDb = new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          if (loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new TypeError("D1 acknowledgement lost after commit");
          }
          return results;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const requestEnv = Object.assign(Object.create(testEnv) as Env, { DB: proxyDb });

  await expect(
    deleteProfileForActor(requestEnv, telegramDeletionActor(graph), deletionNow),
  ).resolves.toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?").bind(graph.playerId).first(),
  ).toBeNull();
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("creates a fresh player when a Mini App link commits after deletion", async () => {
  const graph = await seedProfileDeletionGraph();
  expect(verifiedOidcIdentity.telegramUserId).toBe(graph.telegramUserId);
  await keepGuestActiveForD1Auth(graph.independentGuest.sessionId);

  expect((await remove(graph.current.token)).status).toBe(200);
  const linked = TelegramSessionIssuedSchema.parse(
    await linkGuestToPlayer(
      testEnv,
      {
        sessionId: graph.independentGuest.sessionId,
        playerId: null,
        kind: "guest",
        channel: "telegram",
      },
      verifiedOidcIdentity,
      deletionNow + 1,
    ),
  );

  expect(linked.kind).toBe("telegram");
  const newPlayerId = await playerIdForTelegramUser(graph.telegramUserId);
  expect(newPlayerId).not.toBe(graph.playerId);
  expect(
    await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toEqual({ player_id: newPlayerId });
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("deletes a Mini App profile linked before the deletion commits", async () => {
  const graph = await seedProfileDeletionGraph();
  expect(verifiedOidcIdentity.telegramUserId).toBe(graph.telegramUserId);
  await keepGuestActiveForD1Auth(graph.independentGuest.sessionId);
  const linked = TelegramSessionIssuedSchema.parse(
    await linkGuestToPlayer(
      testEnv,
      {
        sessionId: graph.independentGuest.sessionId,
        playerId: null,
        kind: "guest",
        channel: "telegram",
      },
      verifiedOidcIdentity,
      deletionNow,
    ),
  );
  const linkedSession = await testEnv.DB.prepare(
    "SELECT id, kind, player_id FROM sessions WHERE token_hash = ?",
  )
    .bind(await hashSessionToken(linked.token, testEnv.SESSION_PEPPER))
    .first<{ id: string; kind: string; player_id: string | null }>();
  if (!linkedSession) throw new Error("Linked Mini App session was not persisted.");
  expect(linkedSession).toMatchObject({ kind: "telegram", player_id: graph.playerId });

  const response = await remove(linked.token);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(linkedSession.player_id)
      .first(),
  ).toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toBeNull();
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("retries OIDC completion when profile deletion commits after its identity read", async () => {
  const provider = {
    exchangeAndVerify: vi.fn(async () => verifiedOidcIdentity),
  } satisfies TelegramOidcProvider;
  const oidcApp = createApp({
    now: () => new Date(deletionNow * 1_000),
    oidcProvider: provider,
  });
  const graph = await seedProfileDeletionGraph();
  expect(verifiedOidcIdentity.telegramUserId).toBe(graph.telegramUserId);
  await testEnv.DB.prepare("UPDATE players SET oidc_audience = ? WHERE id = ?")
    .bind(verifiedOidcIdentity.oidc.audience, graph.playerId)
    .run();
  const webGuest = await issueGuest("web");
  await keepGuestActiveForD1Auth(webGuest.sessionId);
  const oidcAttemptId = "oidc-race-independent-attempt";
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
  )
    .bind(
      oidcAttemptId,
      crypto.randomUUID(),
      webGuest.sessionId,
      graph.content.caseId,
      graph.content.puzzleId,
      JSON.stringify({ retraction: graph.content.retraction }),
      JSON.stringify({ correct: false }),
      deletionNow,
    )
    .run();

  const startResponse = await oidcApp.fetch(
    new Request("https://api.test/v1/auth/telegram/oidc/start", {
      method: "POST",
      headers: {
        authorization: `Bearer ${webGuest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "web" }),
    }),
    testEnv,
  );
  expect(startResponse.status).toBe(200);
  const authorizationUrl = new URL(
    OidcStartResponseSchema.parse(await startResponse.json()).authorizationUrl,
  );
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("OIDC start did not return state.");

  let completionBatchCount = 0;
  const proxyDb = new Proxy(testEnv.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length === 4) {
            completionBatchCount += 1;
            if (completionBatchCount === 1) {
              await expect(
                deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
              ).resolves.toEqual({ kind: "guest", profile: null });
            }
          }
          return await target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const callbackEnv = Object.assign(Object.create(testEnv) as Env, { DB: proxyDb });
  const callbackResponse = await oidcApp.fetch(
    new Request(
      `https://api.test/v1/auth/telegram/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`,
    ),
    callbackEnv,
  );

  expect(callbackResponse.status).toBe(302);
  expect(completionBatchCount).toBe(2);
  expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  const location = callbackResponse.headers.get("location");
  if (!location) throw new Error("OIDC callback did not return a redirect.");
  const handoffCode = new URL(location).searchParams.get("handoff");
  if (!handoffCode) throw new Error("OIDC callback did not return a handoff.");

  const exchangeResponse = await oidcApp.fetch(
    new Request("https://api.test/v1/auth/session/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${webGuest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ handoffCode }),
    }),
    testEnv,
  );
  expect(exchangeResponse.status).toBe(200);
  TelegramSessionIssuedSchema.parse(await exchangeResponse.json());

  const newPlayerId = await playerIdForTelegramUser(graph.telegramUserId);
  expect(newPlayerId).not.toBe(graph.playerId);
  const newPlayerAttempts = await testEnv.DB.prepare(
    "SELECT id FROM attempts WHERE player_id = ? ORDER BY id",
  )
    .bind(newPlayerId)
    .all<{ id: string }>();
  expect(newPlayerAttempts.results).toEqual([{ id: oidcAttemptId }]);
  expect(
    await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toEqual({ player_id: null });
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});

it("finishes an OIDC flow started before deletion against a fresh player", async () => {
  const provider = {
    exchangeAndVerify: vi.fn(async () => verifiedOidcIdentity),
  } satisfies TelegramOidcProvider;
  const oidcApp = createApp({
    now: () => new Date(deletionNow * 1_000),
    oidcProvider: provider,
  });
  const graph = await seedProfileDeletionGraph();
  expect(verifiedOidcIdentity.telegramUserId).toBe(graph.telegramUserId);
  const webGuest = await issueGuest("web");
  await keepGuestActiveForD1Auth(webGuest.sessionId);
  const oidcAttemptId = "oidc-independent-attempt";
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
  )
    .bind(
      oidcAttemptId,
      crypto.randomUUID(),
      webGuest.sessionId,
      graph.content.caseId,
      graph.content.puzzleId,
      JSON.stringify({ retraction: graph.content.retraction }),
      JSON.stringify({ correct: false }),
      deletionNow,
    )
    .run();

  const startResponse = await oidcApp.fetch(
    new Request("https://api.test/v1/auth/telegram/oidc/start", {
      method: "POST",
      headers: {
        authorization: `Bearer ${webGuest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: "web" }),
    }),
    testEnv,
  );
  expect(startResponse.status).toBe(200);
  const authorizationUrl = new URL(
    OidcStartResponseSchema.parse(await startResponse.json()).authorizationUrl,
  );
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("OIDC start did not return state.");

  expect((await remove(graph.current.token)).status).toBe(200);
  const callbackResponse = await oidcApp.fetch(
    new Request(
      `https://api.test/v1/auth/telegram/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`,
    ),
    testEnv,
  );
  expect(callbackResponse.status).toBe(302);
  expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);
  const location = callbackResponse.headers.get("location");
  if (!location) throw new Error("OIDC callback did not return a redirect.");
  const handoffCode = new URL(location).searchParams.get("handoff");
  if (!handoffCode) throw new Error("OIDC callback did not return a handoff.");

  const exchangeResponse = await oidcApp.fetch(
    new Request("https://api.test/v1/auth/session/exchange", {
      method: "POST",
      headers: {
        authorization: `Bearer ${webGuest.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ handoffCode }),
    }),
    testEnv,
  );
  expect(exchangeResponse.status).toBe(200);
  TelegramSessionIssuedSchema.parse(await exchangeResponse.json());

  const newPlayerId = await playerIdForTelegramUser(graph.telegramUserId);
  expect(newPlayerId).not.toBe(graph.playerId);
  expect(
    await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind(oidcAttemptId)
      .first(),
  ).toEqual({ player_id: newPlayerId });
  expect(
    await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toEqual({ player_id: null });
  await expectOldAttemptsAbsent(graph.linkedAttemptIds);
});
