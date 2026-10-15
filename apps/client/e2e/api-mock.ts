import type { Page, Route } from "@playwright/test";

const profile = {
  telegramUserId: "42",
  displayName: "profile-deletion-e2e-marker",
  username: "ada",
  avatarUrl: null,
};

const archiveToday = "2026-10-15";
const archiveCases = Array.from({ length: 37 }, (_, index) => {
  const date = new Date("2026-09-10T12:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + index);
  const day = date.toISOString().slice(0, 10);
  const title =
    day === "2026-09-10"
      ? "A quiet beginning"
      : day === "2026-10-14"
        ? "The missing tempo"
        : day === archiveToday
          ? "Today's synthetic case"
          : day > archiveToday
            ? "Future synthetic case"
            : `Training case ${index + 1}`;
  const puzzleCount = day === "2026-10-14" ? 2 : 1;
  const solvedPuzzles =
    day === "2026-10-14" ? 1 : index % 5 === 1 && day < archiveToday ? 1 : 0;
  return {
    id: `case-${day}`,
    date: day,
    slug: `synthetic-${day}`,
    title,
    puzzleCount,
    solvedPuzzles,
    completed: solvedPuzzles === puzzleCount,
  };
});

export interface ApiObservations {
  attemptBodies: Array<Record<string, unknown>>;
  guestChannels: string[];
  hintRequests: Array<{ attemptId: string; level: number }>;
  miniAppProofs: string[];
  dailyIdentities: Array<"guest" | "telegram">;
  dailyDates: Array<string | null>;
  archiveRequests: number;
  statsIdentities: Array<"guest" | "telegram">;
  profileDeleteRequests: Array<{ authorization: string | null; body: string | null }>;
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
    initialIdentity?: "guest" | "telegram";
    loseFirstProfileDeletionResponse?: boolean;
    archive?: boolean;
  } = {},
): Promise<ApiObservations> {
  const observed: ApiObservations = {
    attemptBodies: [],
    guestChannels: [],
    hintRequests: [],
    miniAppProofs: [],
    dailyIdentities: [],
    dailyDates: [],
    archiveRequests: 0,
    statsIdentities: [],
    profileDeleteRequests: [],
    statsRequests: 0,
  };
  let attemptLost = false;
  let hintLost = false;
  let identity: "guest" | "telegram" = options.initialIdentity ?? "guest";
  let profileDeletionResponseLost = false;

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
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
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
    if (url.pathname === "/v1/me" && request.method() === "DELETE") {
      observed.profileDeleteRequests.push({
        authorization: request.headers().authorization ?? null,
        body: request.postData(),
      });
      identity = "guest";
      if (options.loseFirstProfileDeletionResponse && !profileDeletionResponseLost) {
        profileDeletionResponseLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      await json(route, 200, { kind: "guest", profile: null });
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
    if (url.pathname === "/v1/archive" && request.method() === "GET") {
      observed.archiveRequests += 1;
      await json(route, 200, {
        today: archiveToday,
        startsOn: "2026-09-10",
        cases: archiveCases.filter((item) => item.date <= archiveToday).toReversed(),
      });
      return;
    }
    if (url.pathname === "/v1/daily" && request.method() === "GET") {
      observed.dailyIdentities.push(identity);
      observed.dailyDates.push(url.searchParams.get("date"));
      const archived = options.archive
        ? archiveCases.find((item) => item.date === (url.searchParams.get("date") ?? archiveToday))
        : null;
      if (options.archive && (!archived || archived.date > archiveToday)) {
        await json(route, 404, {
          error: {
            code: "DAILY_NOT_FOUND",
            message: "There is no published case for this date.",
            requestId: "synthetic-archive-request",
          },
        });
        return;
      }
      const puzzleId = (index: number) =>
        archived ? `synthetic-${archived.date}-${index}` : "opening-exd5";
      await json(route, 200, {
        id: archived?.id ?? "case-2026-08-03",
        date: archived?.date ?? "2026-08-03",
        title: archived?.title ?? "The missing pawn",
        puzzles: Array.from({ length: archived?.puzzleCount ?? 1 }, (_, index) => ({
          id: puzzleId(index),
          version: 1,
          title: "A pawn vanished",
          prompt: "What happened one move ago?",
          postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
          retractingColor: "w",
          maxHints: 2,
          provenance: "A MOVE AGO sample",
          license: "CC BY 4.0",
        })),
        solvedPuzzleIds: Array.from({ length: archived?.solvedPuzzles ?? 0 }, (_, index) =>
          puzzleId(index),
        ),
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
      observed.statsIdentities.push(identity);
      await json(
        route,
        200,
        identity === "telegram"
          ? {
              attempts: 2,
              hintsUsed: 1,
              solvedPuzzles: 7,
              completedCases: 5,
              currentStreak: 4,
              bestStreak: 9,
              lastCompletedDate: "2026-08-03",
            }
          : {
              attempts: 0,
              hintsUsed: 0,
              solvedPuzzles: 0,
              completedCases: 0,
              currentStreak: 0,
              bestStreak: 0,
              lastCompletedDate: null,
            },
      );
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
