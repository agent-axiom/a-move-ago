import {
  AttemptResultSchema,
  ErrorEnvelopeSchema,
  MeResponseSchema,
  OidcStartResponseSchema,
  SessionIssuedSchema,
  StatsResponseSchema,
  TelegramSessionIssuedSchema,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { TelegramOidcProvider } from "../src/auth/telegram-oidc";
import {
  makePuzzleFixture,
  openingPuzzleFixture,
  type PuzzleFixture,
  seedContentFixture,
} from "./fixtures/content";
import { signedMiniAppData, verifiedOidcIdentity } from "./fixtures/telegram";
import { resetDatabase, testEnv } from "./helpers/http";

type TestApp = ReturnType<typeof createApp>;

const now = new Date("2026-08-04T12:00:00.000Z");
const telegramProfile = {
  telegramUserId: "987654321",
  displayName: "Ada Lovelace",
  username: "ada",
  avatarUrl: "https://cdn.example/avatar.jpg",
};
const oidcPuzzleFixture = makePuzzleFixture({
  rowId: "oidc-opening:v1",
  contentKey: "oidc-opening",
  publicId: "oidc-opening",
  title: "The second missing move",
});

function fakeProvider() {
  return {
    exchangeAndVerify: vi.fn(async () => verifiedOidcIdentity),
  } satisfies TelegramOidcProvider;
}

async function appRequest(
  app: TestApp,
  path: string,
  init: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: HeadersInit;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const requestInit: RequestInit = { headers };
  if (init.method) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.body);
  }
  return await app.fetch(new Request(`https://api.test${path}`, requestInit), testEnv);
}

async function appJson(app: TestApp, path: string, init: Parameters<typeof appRequest>[2] = {}) {
  const response = await appRequest(app, path, init);
  return { response, body: (await response.json()) as unknown };
}

async function issueGuest(app: TestApp, channel: "web" | "telegram") {
  const result = await appJson(app, "/v1/sessions/guest", {
    method: "POST",
    body: { channel },
  });
  expect(result.response.status).toBe(201);
  return SessionIssuedSchema.parse(result.body);
}

async function submitCorrectAttempt(
  app: TestApp,
  token: string,
  fixture: { caseId: string; puzzle: PuzzleFixture },
  attemptUuid: string,
) {
  const result = await appJson(app, "/v1/attempts", {
    method: "POST",
    token,
    body: {
      attemptUuid,
      caseId: fixture.caseId,
      puzzleId: fixture.puzzle.contentKey,
      retraction: fixture.puzzle.solution.retraction,
    },
  });
  expect(result.response.status).toBe(201);
  const attempt = AttemptResultSchema.parse(result.body);
  expect(attempt).toMatchObject({ attemptUuid, correct: true });
  return attempt;
}

async function readStats(app: TestApp, token: string) {
  const result = await appJson(app, "/v1/me/stats", { token });
  expect(result.response.status).toBe(200);
  return StatsResponseSchema.parse(result.body);
}

async function expectApiError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ErrorEnvelopeSchema.parse(await response.json()).error.code).toBe(code);
}

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(Date, "now").mockReturnValue(now.getTime());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Telegram authentication journeys", () => {
  it("converges Mini App and OIDC guest history on one Telegram player and isolates logout", async () => {
    const provider = fakeProvider();
    const app = createApp({ now: () => now, oidcProvider: provider });
    const miniContent = await seedContentFixture(testEnv.DB, {
      id: "mini-app-case",
      date: "2026-08-03",
      slug: "mini-app-case",
      puzzle: openingPuzzleFixture,
    });
    const oidcContent = await seedContentFixture(testEnv.DB, {
      id: "oidc-case",
      date: "2026-08-04",
      slug: "oidc-case",
      puzzle: oidcPuzzleFixture,
    });

    const miniAttemptUuid = crypto.randomUUID();
    const miniGuest = await issueGuest(app, "telegram");
    await submitCorrectAttempt(app, miniGuest.token, miniContent, miniAttemptUuid);
    const initData = await signedMiniAppData({
      botToken: testEnv.TELEGRAM_BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
    });
    const miniLogin = await appJson(app, "/v1/auth/telegram/mini-app", {
      method: "POST",
      token: miniGuest.token,
      body: { initData },
    });
    expect(miniLogin.response.status).toBe(200);
    const miniSession = TelegramSessionIssuedSchema.parse(miniLogin.body);
    expect(miniSession.profile).toEqual(telegramProfile);
    await expectApiError(
      await appRequest(app, "/v1/me", { token: miniGuest.token }),
      401,
      "INVALID_SESSION",
    );
    expect(
      MeResponseSchema.parse((await appJson(app, "/v1/me", { token: miniSession.token })).body),
    ).toEqual({ kind: "telegram", profile: telegramProfile });
    expect(await readStats(app, miniSession.token)).toEqual({
      attempts: 1,
      hintsUsed: 0,
      solvedPuzzles: 1,
      completedCases: 1,
      currentStreak: 1,
      bestStreak: 1,
      lastCompletedDate: "2026-08-03",
    });

    const oidcAttemptUuid = crypto.randomUUID();
    const webGuest = await issueGuest(app, "web");
    await submitCorrectAttempt(app, webGuest.token, oidcContent, oidcAttemptUuid);
    const start = await appJson(app, "/v1/auth/telegram/oidc/start", {
      method: "POST",
      token: webGuest.token,
      body: { channel: "web" },
    });
    expect(start.response.status).toBe(200);
    const authorizationUrl = new URL(OidcStartResponseSchema.parse(start.body).authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("OIDC start did not return state.");

    const callback = await appRequest(
      app,
      `/v1/auth/telegram/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`,
    );
    expect(callback.status).toBe(302);
    const location = callback.headers.get("location");
    if (!location) throw new Error("OIDC callback did not return a redirect.");
    const handoffCode = new URL(location).searchParams.get("handoff");
    if (!handoffCode) throw new Error("OIDC callback did not return a handoff.");
    expect(provider.exchangeAndVerify).toHaveBeenCalledTimes(1);

    const thief = await issueGuest(app, "web");
    await expectApiError(
      await appRequest(app, "/v1/auth/session/exchange", {
        method: "POST",
        token: thief.token,
        body: { handoffCode },
      }),
      401,
      "HANDOFF_INVALID",
    );

    const exchange = await appJson(app, "/v1/auth/session/exchange", {
      method: "POST",
      token: webGuest.token,
      body: { handoffCode },
    });
    expect(exchange.response.status).toBe(200);
    const oidcSession = TelegramSessionIssuedSchema.parse(exchange.body);
    expect(oidcSession.profile).toEqual(telegramProfile);
    await expectApiError(
      await appRequest(app, "/v1/auth/session/exchange", {
        method: "POST",
        token: webGuest.token,
        body: { handoffCode },
      }),
      401,
      "INVALID_SESSION",
    );
    await expectApiError(
      await appRequest(app, "/v1/me", { token: webGuest.token }),
      401,
      "INVALID_SESSION",
    );
    expect(
      MeResponseSchema.parse((await appJson(app, "/v1/me", { token: oidcSession.token })).body),
    ).toEqual({ kind: "telegram", profile: telegramProfile });

    const linkedStats = {
      attempts: 2,
      hintsUsed: 0,
      solvedPuzzles: 2,
      completedCases: 2,
      currentStreak: 2,
      bestStreak: 2,
      lastCompletedDate: "2026-08-04",
    };
    expect(await readStats(app, oidcSession.token)).toEqual(linkedStats);
    expect(await readStats(app, miniSession.token)).toEqual(linkedStats);

    const players = await testEnv.DB.prepare(
      `SELECT id, telegram_user_id, oidc_subject
         FROM players
        WHERE telegram_user_id = ?`,
    )
      .bind("987654321")
      .all<{ id: string; telegram_user_id: string; oidc_subject: string | null }>();
    expect(players.results).toHaveLength(1);
    expect(players.results[0]).toMatchObject({
      telegram_user_id: "987654321",
      oidc_subject: "telegram-subject-987654321",
    });
    const playerId = players.results[0]?.id;
    expect(playerId).toEqual(expect.any(String));

    const attempts = await testEnv.DB.prepare(
      `SELECT attempt_uuid, player_id, correct
         FROM attempts
        ORDER BY attempt_uuid`,
    ).all<{ attempt_uuid: string; player_id: string | null; correct: number }>();
    expect(attempts.results.map((attempt) => attempt.attempt_uuid).sort()).toEqual(
      [miniAttemptUuid, oidcAttemptUuid].sort(),
    );
    expect(attempts.results).toHaveLength(2);
    for (const attempt of attempts.results) {
      expect(attempt.player_id).toBe(playerId);
      expect(attempt.correct).toBe(1);
    }

    const logout = await appJson(app, "/v1/auth/logout", {
      method: "POST",
      token: oidcSession.token,
    });
    expect(logout.response.status).toBe(200);
    const isolatedGuest = SessionIssuedSchema.parse(logout.body);
    expect(isolatedGuest.kind).toBe("guest");
    await expectApiError(
      await appRequest(app, "/v1/me", { token: oidcSession.token }),
      401,
      "INVALID_SESSION",
    );
    expect(
      MeResponseSchema.parse((await appJson(app, "/v1/me", { token: isolatedGuest.token })).body),
    ).toEqual({ kind: "guest", profile: null });
    expect(await readStats(app, isolatedGuest.token)).toEqual({
      attempts: 0,
      hintsUsed: 0,
      solvedPuzzles: 0,
      completedCases: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
    });
    expect(await readStats(app, miniSession.token)).toEqual(linkedStats);
  });

  it("returns 404 for all three non-contract auth aliases", async () => {
    const app = createApp({ oidcProvider: fakeProvider() });
    for (const [path, method] of [
      ["/v1/auth/start", "POST"],
      ["/v1/auth/callback", "GET"],
      ["/v1/auth/telegram/oidc/session/exchange", "POST"],
    ] as const) {
      await expectApiError(await appRequest(app, path, { method }), 404, "NOT_FOUND");
    }
  });
});
