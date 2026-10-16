import type { EarnedHint, PuzzleProgress } from "@a-move-ago/api-contract";
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
  const solvedPuzzles = day === "2026-10-14" ? 1 : index % 5 === 1 && day < archiveToday ? 1 : 0;
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
  clueRequests: Array<{ caseId: string; puzzleId: string }>;
  miniAppProofs: string[];
  dailyIdentities: Array<"guest" | "telegram">;
  dailyDates: Array<string | null>;
  archiveRequests: number;
  statsIdentities: Array<"guest" | "telegram">;
  profileDeleteRequests: Array<{ authorization: string | null; body: string | null }>;
  statsRequests: number;
}

const contentText = {
  ru: {
    caseTitle: "Пропавшая пешка",
    firstCaseTitle: "Тихое начало",
    recentCaseTitle: "Потерянный темп",
    puzzleTitle: "Исчезнувшая пешка",
    prompt: "Последним ходом белых было взятие пешкой. Отмените его.",
    provenance: "Учебный пример A MOVE AGO",
    license: "CC BY 4.0",
    contradiction: "Этот ход не объясняет исчезновение пешки.",
    hint: "Пешка сменила вертикаль.",
    explanation: "Белая пешка с вертикали e взяла чёрную пешку на d5.",
  },
  zh: {
    caseTitle: "消失的兵",
    firstCaseTitle: "安静的开始",
    recentCaseTitle: "丢失的一步",
    puzzleTitle: "一枚兵消失了",
    prompt: "白方上一步用兵吃子。请撤回这一步。",
    provenance: "A MOVE AGO 教学示例",
    license: "CC BY 4.0",
    contradiction: "这一步无法解释兵为何消失。",
    hint: "一枚兵换了纵线。",
    explanation: "白方 e 线的兵吃掉了 d5 格的黑兵。",
  },
};

// Synthetic translations follow the same public/authorized projection as the API.
// Hidden hints and solutions are attached only to their existing authorized response.
function withLocalizations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withLocalizations);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const result = Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, withLocalizations(child)]),
  );
  const localizations = Object.fromEntries(
    Object.entries(contentText).map(([locale, text]) => {
      if (typeof object.postFen === "string")
        return [
          locale,
          {
            title: /^Puzzle \d+$/.test(String(object.title))
              ? `${locale === "ru" ? "Задача" : "棋题"} ${String(object.title).split(" ")[1]}`
              : text.puzzleTitle,
            prompt:
              object.prompt === "Reconstruct the last move."
                ? locale === "ru"
                  ? "Восстановите последний ход."
                  : "还原上一步棋。"
                : text.prompt,
            provenance: text.provenance,
            license: text.license,
          },
        ];
      if (typeof object.title === "string" && (Array.isArray(object.puzzles) || "slug" in object)) {
        const title =
          object.title === "Daily case"
            ? locale === "ru"
              ? "Задача дня"
              : "每日棋题"
            : object.title === "A quiet beginning"
              ? text.firstCaseTitle
              : object.title === "The missing tempo"
                ? text.recentCaseTitle
                : object.title === "The missing pawn"
                  ? text.caseTitle
                  : locale === "ru"
                    ? `Учебная задача ${String(object.date)}`
                    : `教学谜题 ${String(object.date)}`;
        return [locale, { title }];
      }
      if (
        typeof object.title === "string" &&
        typeof object.prompt === "string" &&
        "progress" in object
      ) {
        return [locale, { title: text.puzzleTitle, prompt: text.prompt }];
      }
      if (typeof object.previousFen === "string" && typeof object.explanation === "string") {
        return [locale, { explanation: text.explanation }];
      }
      if (typeof object.level === "number" && typeof object.text === "string") {
        return [locale, { text: text.hint }];
      }
      if (object.code === "NOT_THE_LAST_MOVE") return [locale, { message: text.contradiction }];
      return [locale, null];
    }),
  );
  return localizations.ru === null ? result : { ...result, localizations };
}

async function json(
  route: Route,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "idempotency-replayed",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(
      route.request().headers()["x-content-locales"] === "1" ? withLocalizations(value) : value,
    ),
  });
}

interface MockState {
  caseId: string;
  date: string;
  puzzleId: string;
  progress: PuzzleProgress;
}
interface MockActor {
  states: Map<string, MockState>;
  attempts: Map<string, { input: string; response: Record<string, unknown> }>;
  attemptsCount: number;
  hintsUsed: number;
  newSolves: Set<string>;
}
function actor(): MockActor {
  return {
    states: new Map(),
    attempts: new Map(),
    attemptsCount: 0,
    hintsUsed: 0,
    newSolves: new Set(),
  };
}
function potential(progress: PuzzleProgress) {
  if (progress.earnedPoints !== null) return 0;
  const base = [100, 70, 40, 20][Math.min(progress.attemptCount, 3)] ?? 20;
  return Math.max(1, Math.floor(base / 2 ** progress.assistanceCount));
}
function snapshot(progress: PuzzleProgress): PuzzleProgress {
  return structuredClone({ ...progress, nextAttemptPoints: potential(progress) });
}

export async function installApiMock(
  page: Page,
  options: {
    loseFirstAttempt?: boolean;
    loseFirstHint?: boolean;
    loseFirstClue?: boolean;
    initialIdentity?: "guest" | "telegram";
    loseFirstProfileDeletionResponse?: boolean;
    archive?: boolean;
  } = {},
): Promise<ApiObservations> {
  const observed: ApiObservations = {
    attemptBodies: [],
    guestChannels: [],
    hintRequests: [],
    clueRequests: [],
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
  let clueLost = false;
  let identity: "guest" | "telegram" = options.initialIdentity ?? "guest";
  let profileDeletionResponseLost = false;
  let guest = actor();
  const telegram = actor();
  let wrongIds = 0;
  let correctIds = 0;
  const active = () => (identity === "guest" ? guest : telegram);
  const defaultCase = {
    id: "case-2026-08-03",
    date: "2026-08-03",
    slug: "case-2026-08-03",
    title: "The missing pawn",
    puzzleCount: 1,
    solvedPuzzles: 0,
    completed: false,
  };
  const cases = options.archive
    ? archiveCases.filter((item) => item.date <= archiveToday)
    : [defaultCase];
  function stateFor(item: typeof defaultCase, index: number): MockState {
    const puzzleId = `p-${item.id}-${index + 1}-v1`;
    const existing = active().states.get(puzzleId);
    if (existing) return existing;
    const legacySolved = index < item.solvedPuzzles;
    const state: MockState = {
      caseId: item.id,
      date: item.date,
      puzzleId,
      progress: {
        attemptCount: legacySolved ? 1 : 0,
        assistanceCount: 0,
        clueUnlocked: legacySolved,
        highestHintLevel: 0,
        earnedPoints: legacySolved ? 0 : null,
        nextAttemptPoints: legacySolved ? 0 : 100,
        legacySolved,
        awardAttemptId: null,
        earnedHints: [],
      },
    };
    active().states.set(puzzleId, state);
    return state;
  }
  function statesFor(item: typeof defaultCase) {
    return Array.from({ length: item.puzzleCount }, (_, index) => stateFor(item, index));
  }
  function entitled(state: MockState) {
    return state.progress.clueUnlocked || state.progress.earnedPoints !== null;
  }
  function publicTitle(item: typeof defaultCase) {
    return statesFor(item).every(entitled) ? item.title : "Daily case";
  }
  function findState(caseId: unknown, puzzleId: unknown) {
    const item = cases.find((candidate) => candidate.id === caseId);
    if (!item) return undefined;
    return statesFor(item).find(
      (state) =>
        state.puzzleId === puzzleId || (item.id === defaultCase.id && puzzleId === "opening-exd5"),
    );
  }
  function stats() {
    const current = active();
    const solved = [...current.newSolves]
      .map((id) => current.states.get(id))
      .filter((state) => state !== undefined);
    const completed = cases.filter(
      (item) =>
        statesFor(item).every((state) => state.progress.earnedPoints !== null) &&
        solved.some((state) => state.caseId === item.id),
    );
    const baseline =
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
          };
    return {
      ...baseline,
      attempts: baseline.attempts + current.attemptsCount,
      hintsUsed: baseline.hintsUsed + current.hintsUsed,
      solvedPuzzles: baseline.solvedPuzzles + solved.length,
      completedCases: baseline.completedCases + completed.length,
      bestStreak: Math.max(baseline.bestStreak, completed.length ? 1 : 0),
      lastCompletedDate:
        completed
          .map((item) => item.date)
          .sort()
          .at(-1) ?? baseline.lastCompletedDate,
    };
  }

  await page.route("https://telegram.org/js/telegram-web-app.js?63", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: "window.Telegram={WebApp:{platform:'unknown'}};",
    });
  });
  await page.route("https://api.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const includeProgress = request.headers()["x-game-progress"] === "1";
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers":
            "authorization,content-type,x-content-locales,x-game-progress",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        },
      });
      return;
    }
    if (url.pathname === "/v1/sessions/guest" && request.method() === "POST") {
      observed.guestChannels.push((request.postDataJSON() as { channel: string }).channel);
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
      guest = actor();
      telegram.states.clear();
      telegram.attempts.clear();
      telegram.newSolves.clear();
      telegram.attemptsCount = 0;
      telegram.hintsUsed = 0;
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
        cases: archiveCases
          .filter((item) => item.date <= archiveToday)
          .toReversed()
          .map((item) => {
            const states = statesFor(item);
            const solvedPuzzles = states.filter(
              (state) => state.progress.earnedPoints !== null,
            ).length;
            return {
              ...item,
              slug: `case-${item.date}`,
              title: publicTitle(item),
              solvedPuzzles,
              completed: solvedPuzzles === item.puzzleCount,
            };
          }),
      });
      return;
    }
    if (url.pathname === "/v1/daily" && request.method() === "GET") {
      observed.dailyIdentities.push(identity);
      observed.dailyDates.push(url.searchParams.get("date"));
      const item = options.archive
        ? cases.find(
            (candidate) => candidate.date === (url.searchParams.get("date") ?? archiveToday),
          )
        : defaultCase;
      if (!item) {
        await json(route, 404, {
          error: {
            code: "DAILY_NOT_FOUND",
            message: "There is no published case for this date.",
            requestId: "synthetic-archive-request",
          },
        });
        return;
      }
      const states = statesFor(item);
      await json(route, 200, {
        id: item.id,
        date: item.date,
        title: publicTitle(item),
        puzzles: states.map((state, index) => ({
          id: state.puzzleId,
          version: 1,
          title: entitled(state) ? "A pawn vanished" : `Puzzle ${index + 1}`,
          prompt: entitled(state)
            ? "The last move was a white pawn capture. Retract it."
            : "Reconstruct the last move.",
          postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
          retractingColor: "w",
          maxHints: 2,
          provenance: "A MOVE AGO sample",
          license: "CC BY 4.0",
        })),
        solvedPuzzleIds: states
          .filter((state) => state.progress.earnedPoints !== null)
          .map((state) => state.puzzleId),
        ...(includeProgress
          ? {
              progressStates: Object.fromEntries(
                states.map((state) => [state.puzzleId, snapshot(state.progress)]),
              ),
            }
          : {}),
      });
      return;
    }
    const clue = url.pathname.match(/^\/v1\/cases\/([^/]+)\/puzzles\/([^/]+)\/clue$/);
    if (clue && request.method() === "POST") {
      const caseId = decodeURIComponent(clue[1] ?? "");
      const puzzleId = decodeURIComponent(clue[2] ?? "");
      observed.clueRequests.push({ caseId, puzzleId });
      const state = findState(caseId, puzzleId);
      if (!state) throw new Error("Unexpected synthetic clue identity");
      if (!state.progress.clueUnlocked && state.progress.earnedPoints === null) {
        state.progress.clueUnlocked = true;
        state.progress.assistanceCount += 1;
      }
      if (options.loseFirstClue && !clueLost) {
        clueLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      await json(route, 200, {
        title: "A pawn vanished",
        prompt: "The last move was a white pawn capture. Retract it.",
        progress: snapshot(state.progress),
      });
      return;
    }
    if (url.pathname === "/v1/attempts" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      observed.attemptBodies.push(body);
      const current = active();
      const key = String(body.attemptUuid);
      const replay = current.attempts.get(key);
      if (replay) {
        if (replay.input !== JSON.stringify(body))
          throw new Error("Synthetic idempotency conflict");
        const { progress, ...base } = replay.response;
        await json(route, 200, includeProgress ? { ...base, progress } : base, {
          "idempotency-replayed": "true",
        });
        return;
      }
      const state = findState(body.caseId, body.puzzleId);
      if (!state) throw new Error("Unexpected synthetic attempt identity");
      const move = body.retraction as {
        currentSquare: string;
        previousSquare: string;
        restoredPiece: unknown;
      };
      const correct =
        move.currentSquare === "d5" && move.previousSquare === "e4" && move.restoredPiece !== null;
      const id = correct
        ? correctIds++ === 0
          ? "11111111-1111-4111-8111-111111111111"
          : `22222222-2222-4222-8222-${String(correctIds).padStart(12, "0")}`
        : wrongIds++ === 0
          ? "33333333-3333-4333-8333-333333333333"
          : `44444444-4444-4444-8444-${String(wrongIds).padStart(12, "0")}`;
      const available = potential(state.progress);
      current.attemptsCount += 1;
      if (state.progress.earnedPoints === null) {
        state.progress.attemptCount += 1;
        if (correct) {
          state.progress.earnedPoints = available;
          state.progress.awardAttemptId = id;
          current.newSolves.add(state.puzzleId);
        }
      }
      const response: Record<string, unknown> = {
        id,
        attemptUuid: body.attemptUuid,
        correct,
        ...(correct
          ? {
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
              contradiction: {
                code: "NOT_THE_LAST_MOVE",
                message: "That does not explain the missing pawn.",
              },
            }),
        progress: snapshot(state.progress),
      };
      current.attempts.set(key, {
        input: JSON.stringify(body),
        response: structuredClone(response),
      });
      if (options.loseFirstAttempt && !attemptLost) {
        attemptLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      const { progress, ...base } = response;
      await json(route, 201, includeProgress ? { ...base, progress } : base);
      return;
    }
    const hint = url.pathname.match(/^\/v1\/attempts\/([^/]+)\/hints$/);
    if (hint && request.method() === "POST") {
      const attemptId = decodeURIComponent(hint[1] ?? "");
      const body = request.postDataJSON() as { level: number };
      observed.hintRequests.push({ attemptId, level: body.level });
      const attempt = [...active().attempts.values()].find(
        (entry) => entry.response.id === attemptId,
      );
      if (!attempt) throw new Error("Unexpected synthetic hint attempt");
      const input = JSON.parse(attempt.input) as { caseId: string; puzzleId: string };
      const state = findState(input.caseId, input.puzzleId);
      if (!state) throw new Error("Missing synthetic hint state");
      let earned = state.progress.earnedHints.find((item) => item.level === body.level);
      if (!earned) {
        earned = {
          level: body.level,
          text: "A pawn changed files.",
          exhausted: body.level >= 2,
        } satisfies EarnedHint;
        state.progress.earnedHints.push(earned);
        state.progress.highestHintLevel = body.level;
        state.progress.assistanceCount += 1;
        active().hintsUsed += 1;
      }
      if (options.loseFirstHint && !hintLost) {
        hintLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      await json(route, 200, {
        ...earned,
        ...(includeProgress ? { progress: snapshot(state.progress) } : {}),
      });
      return;
    }
    if (url.pathname === "/v1/me/stats" && request.method() === "GET") {
      observed.statsRequests += 1;
      observed.statsIdentities.push(identity);
      const points = [...active().states.values()].reduce(
        (sum, state) => sum + (state.progress.earnedPoints ?? 0),
        0,
      );
      await json(route, 200, { ...stats(), ...(includeProgress ? { points } : {}) });
      return;
    }
    if (url.pathname === "/v1/auth/telegram/mini-app" && request.method() === "POST") {
      observed.miniAppProofs.push((request.postDataJSON() as { initData: string }).initData);
      for (const [key, state] of guest.states) {
        if (!telegram.states.has(key)) telegram.states.set(key, state);
      }
      for (const [key, attempt] of guest.attempts) telegram.attempts.set(key, attempt);
      for (const id of guest.newSolves) telegram.newSolves.add(id);
      telegram.attemptsCount += guest.attemptsCount;
      telegram.hintsUsed += guest.hintsUsed;
      guest = actor();
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
      error: { code: "NOT_FOUND", message: "Mock route not found.", requestId: "e2e-request" },
    });
  });
  return observed;
}
