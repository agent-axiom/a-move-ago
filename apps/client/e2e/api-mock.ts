import type { Page, Route } from "@playwright/test";

const profile = {
  telegramUserId: "42",
  displayName: "Ada",
  username: "ada",
  avatarUrl: null,
};

export interface ApiObservations {
  attemptBodies: Array<Record<string, unknown>>;
  guestChannels: string[];
  hintRequests: Array<{ attemptId: string; level: number }>;
  miniAppProofs: string[];
  statsRequests: number;
}

async function json(route: Route, status: number, value: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  });
}

export async function installApiMock(
  page: Page,
  options: {
    loseFirstAttempt?: boolean;
    loseFirstHint?: boolean;
  } = {},
): Promise<ApiObservations> {
  const observed: ApiObservations = {
    attemptBodies: [],
    guestChannels: [],
    hintRequests: [],
    miniAppProofs: [],
    statsRequests: 0,
  };
  let attemptLost = false;
  let hintLost = false;
  let identity: "guest" | "telegram" = "guest";

  await page.route("https://telegram.org/js/telegram-web-app.js?63", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.Telegram={WebApp:{platform:'unknown'}};",
    });
  });
  await page.route("https://api.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
      });
      return;
    }
    if (url.pathname === "/v1/sessions/guest" && request.method() === "POST") {
      const body = request.postDataJSON() as { channel: string };
      observed.guestChannels.push(body.channel);
      await json(route, 201, {
        token: "g".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "guest",
      });
      return;
    }
    if (url.pathname === "/v1/me" && request.method() === "GET") {
      await json(
        route,
        200,
        identity === "guest" ? { kind: "guest", profile: null } : { kind: "telegram", profile },
      );
      return;
    }
    if (url.pathname === "/v1/daily" && request.method() === "GET") {
      await json(route, 200, {
        id: "case-2026-08-03",
        date: "2026-08-03",
        title: "The missing pawn",
        puzzles: [
          {
            id: "opening-exd5",
            version: 1,
            title: "A pawn vanished",
            prompt: "What happened one move ago?",
            postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
            retractingColor: "w",
            maxHints: 2,
            provenance: "A MOVE AGO sample",
            license: "CC BY 4.0",
          },
        ],
        solvedPuzzleIds: [],
      });
      return;
    }
    if (url.pathname === "/v1/attempts" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      observed.attemptBodies.push(body);
      if (options.loseFirstAttempt && !attemptLost) {
        attemptLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      const move = body.retraction as {
        currentSquare: string;
        previousSquare: string;
        restoredPiece: unknown;
      };
      const correct =
        move.currentSquare === "d5" && move.previousSquare === "e4" && move.restoredPiece !== null;
      await json(
        route,
        201,
        correct
          ? {
              id: "11111111-1111-4111-8111-111111111111",
              attemptUuid: body.attemptUuid,
              correct: true,
              reveal: {
                retraction: body.retraction,
                previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
                forwardSan: "exd5",
                explanation: "The white e-pawn captured the black pawn on d5.",
                historyConstraints: [
                  { kind: "previous-castling", value: "KQkq" },
                  { kind: "previous-en-passant", value: "d6" },
                ],
              },
            }
          : {
              id: "33333333-3333-4333-8333-333333333333",
              attemptUuid: body.attemptUuid,
              correct: false,
              contradiction: {
                code: "NOT_THE_LAST_MOVE",
                message: "That does not explain the missing pawn.",
              },
            },
      );
      return;
    }
    const hint = url.pathname.match(/^\/v1\/attempts\/([^/]+)\/hints$/);
    if (hint && request.method() === "POST") {
      const body = request.postDataJSON() as { level: number };
      observed.hintRequests.push({
        attemptId: decodeURIComponent(hint[1] ?? ""),
        level: body.level,
      });
      if (options.loseFirstHint && !hintLost) {
        hintLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      await json(route, 200, {
        level: body.level,
        text: "A pawn changed files.",
        exhausted: false,
      });
      return;
    }
    if (url.pathname === "/v1/me/stats" && request.method() === "GET") {
      observed.statsRequests += 1;
      await json(route, 200, {
        attempts: 2,
        hintsUsed: 1,
        solvedPuzzles: 7,
        completedCases: 5,
        currentStreak: 4,
        bestStreak: 9,
        lastCompletedDate: "2026-08-03",
      });
      return;
    }
    if (url.pathname === "/v1/auth/telegram/mini-app" && request.method() === "POST") {
      const body = request.postDataJSON() as { initData: string };
      observed.miniAppProofs.push(body.initData);
      identity = "telegram";
      await json(route, 200, {
        token: "t".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "telegram",
        profile,
      });
      return;
    }
    await json(route, 404, {
      error: {
        code: "NOT_FOUND",
        message: "Mock route not found.",
        requestId: "e2e-request",
      },
    });
  });
  return observed;
}
