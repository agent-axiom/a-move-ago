import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// This privileged query stays read-only. Solutions exist in memory, never in output.
const solutionSql = `SELECT c.id AS case_id,
  ('p-' || c.id || '-' || cp.position || '-v' || p.version) AS puzzle_id,
  json_extract(p.public_json, '$.prompt') AS prompt, s.solution_json
FROM daily_cases c
JOIN daily_case_puzzles cp ON cp.case_id = c.id
JOIN puzzles p ON p.id = cp.puzzle_id
JOIN puzzle_solutions s ON s.puzzle_id = p.id
WHERE c.case_date = ? AND c.status = 'published' AND p.status = 'published'
  AND cp.position = 1 AND s.sort_order = 1
LIMIT 1`;
const webOrigin = "https://chess.kosarevsky.dev";
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const statisticCounters = [
  "attempts",
  "hintsUsed",
  "solvedPuzzles",
  "completedCases",
  "currentStreak",
  "bestStreak",
  "points",
];
class DiagnosticError extends Error {}
function ensure(condition, code) {
  if (!condition) throw new DiagnosticError(code);
}
function keys(value, names) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((key) => Object.hasOwn(value, key))
  );
}
function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}
function translated(value, fields) {
  return (
    keys(value, ["ru", "zh"]) &&
    ["ru", "zh"].every(
      (locale) =>
        keys(value[locale], fields) && fields.every((field) => nonempty(value[locale][field])),
    )
  );
}
function piece(value, restored = false) {
  return (
    keys(value, restored ? ["color", "type", "square"] : ["color", "type"]) &&
    ["w", "b"].includes(value.color) &&
    (restored ? ["p", "n", "b", "r", "q"] : ["p", "n", "b", "r", "q", "k"]).includes(value.type) &&
    (!restored || /^[a-h][1-8]$/.test(value.square))
  );
}
function validSolution(value) {
  if (
    !keys(value, ["retraction", "previousFen", "forwardSan", "explanation", "historyConstraints"])
  )
    return false;
  const r = value.retraction;
  return (
    keys(r, ["currentSquare", "previousSquare", "movedPiece", "restoredPiece", "special"]) &&
    /^[a-h][1-8]$/.test(r.currentSquare) &&
    /^[a-h][1-8]$/.test(r.previousSquare) &&
    r.currentSquare !== r.previousSquare &&
    piece(r.movedPiece) &&
    (r.restoredPiece === null || piece(r.restoredPiece, true)) &&
    ["normal", "castle-kingside", "castle-queenside", "en-passant", "unpromotion"].includes(
      r.special,
    ) &&
    ["previousFen", "forwardSan", "explanation"].every((field) => nonempty(value[field])) &&
    Array.isArray(value.historyConstraints) &&
    value.historyConstraints.every(
      (constraint) =>
        keys(constraint, ["kind", "value"]) &&
        ["previous-castling", "previous-en-passant"].includes(constraint.kind) &&
        nonempty(constraint.value),
    )
  );
}
function validateBindings(env) {
  ensure(
    ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "API_ORIGIN"].every(
      (name) => nonempty(env[name]) && env[name].trim() !== "",
    ),
    "MISSING_REQUIRED_BINDINGS",
  );
  ensure(/^[A-Za-z0-9_-]+$/.test(env.CLOUDFLARE_API_TOKEN), "INVALID_CLOUDFLARE_API_TOKEN");
  ensure(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID), "INVALID_CLOUDFLARE_ACCOUNT_ID");
  ensure(
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(env.D1_DATABASE_ID),
    "INVALID_D1_DATABASE_ID",
  );
  let origin;
  try {
    origin = new URL(env.API_ORIGIN);
  } catch {
    throw new DiagnosticError("INVALID_API_ORIGIN");
  }
  ensure(
    origin.protocol === "https:" &&
      origin.origin === env.API_ORIGIN &&
      origin.username === "" &&
      origin.password === "",
    "INVALID_API_ORIGIN",
  );
}
function progress(
  attemptCount = 0,
  assistanceCount = 0,
  earnedPoints = null,
  awardAttemptId = null,
) {
  return {
    attemptCount,
    assistanceCount,
    clueUnlocked: assistanceCount === 1,
    highestHintLevel: 0,
    earnedPoints,
    nextAttemptPoints:
      earnedPoints === null ? (attemptCount === 0 ? 100 : assistanceCount ? 35 : 70) : 0,
    legacySolved: false,
    awardAttemptId,
    earnedHints: [],
  };
}
function validDaily(value, date) {
  return (
    keys(value, [
      "id",
      "date",
      "title",
      "puzzles",
      "solvedPuzzleIds",
      "localizations",
      "progressStates",
    ]) &&
    value.date === date &&
    nonempty(value.id) &&
    nonempty(value.title) &&
    translated(value.localizations, ["title"]) &&
    Array.isArray(value.puzzles) &&
    value.puzzles.length > 0 &&
    value.puzzles.every(
      (p) =>
        keys(p, [
          "id",
          "version",
          "title",
          "prompt",
          "postFen",
          "retractingColor",
          "maxHints",
          "provenance",
          "license",
          "localizations",
        ]) &&
        ["id", "title", "prompt", "postFen", "provenance", "license"].every((field) =>
          nonempty(p[field]),
        ) &&
        Number.isSafeInteger(p.version) &&
        p.version > 0 &&
        ["w", "b"].includes(p.retractingColor) &&
        Number.isSafeInteger(p.maxHints) &&
        p.maxHints >= 0 &&
        translated(p.localizations, ["title", "prompt", "provenance", "license"]),
    ) &&
    value.puzzles.every((p, index) => p.id === `p-${value.id}-${index + 1}-v${p.version}`) &&
    new Set(value.puzzles.map((p) => p.id)).size === value.puzzles.length &&
    Array.isArray(value.solvedPuzzleIds) &&
    keys(
      value.progressStates,
      value.puzzles.map((p) => p.id),
    )
  );
}
function stablePublicPuzzle(puzzle, unlocked) {
  if (!unlocked) return puzzle;
  const { title: _title, prompt: _prompt, localizations, ...base } = puzzle;
  return {
    ...base,
    localizations: Object.fromEntries(
      Object.entries(localizations).map(([locale, value]) => {
        const { title: _localizedTitle, prompt: _localizedPrompt, ...text } = value;
        return [locale, text];
      }),
    ),
  };
}

/** Two isolated guests verify first-solve pricing, clue deductions, durable awards and replay safety. */
export async function checkProductionScoring(
  env,
  { fetch: request = globalThis.fetch, now = () => new Date(), uuid = randomUUID } = {},
) {
  validateBindings(env);
  const date = now().toISOString().slice(0, 10);
  const issuedUuids = new Set();
  function nextUuid() {
    const value = uuid();
    ensure(
      typeof value === "string" && uuidPattern.test(value) && !issuedUuids.has(value),
      "INVALID_ATTEMPT_UUID",
    );
    issuedUuids.add(value);
    return value;
  }
  async function call(service, url, options = {}, status = 200) {
    let response;
    try {
      response = await request(url, {
        ...options,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DiagnosticError(`${service}_TRANSPORT_FAILED`);
    }
    ensure(response?.status === status, `${service}_HTTP_FAILED`);
    if (service === "API")
      ensure(response.headers.get("access-control-allow-origin") === webOrigin, "API_CORS_FAILED");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new DiagnosticError(`${service}_INVALID_JSON`);
    }
    return { data, headers: response.headers };
  }
  async function createActor() {
    let token;
    async function api(path, body, status = 200) {
      return call(
        "API",
        `${env.API_ORIGIN}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: webOrigin,
            accept: "application/json",
            "x-game-progress": "1",
            "x-content-locales": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        status,
      );
    }
    const { data: session } = await api("/v1/sessions/guest", { channel: "web" }, 201);
    ensure(
      keys(session, ["kind", "token", "expiresAt"]) &&
        session.kind === "guest" &&
        typeof session.token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(session.token) &&
        typeof session.expiresAt === "string" &&
        Date.parse(session.expiresAt) > now().getTime(),
      "GUEST_SESSION_FAILED",
    );
    token = session.token;
    const { data: identity } = await api("/v1/me");
    ensure(
      keys(identity, ["kind", "profile"]) && identity.kind === "guest" && identity.profile === null,
      "GUEST_IDENTITY_FAILED",
    );
    const dailyPath = `/v1/daily?date=${date}`;
    const { data: daily } = await api(dailyPath);
    ensure(
      validDaily(daily, date) &&
        daily.solvedPuzzleIds.length === 0 &&
        daily.title === "Daily case" &&
        daily.localizations.ru.title === "Задача дня" &&
        daily.localizations.zh.title === "每日棋题" &&
        daily.puzzles.every(
          (p, index) =>
            p.title === `Puzzle ${index + 1}` &&
            p.localizations.ru.title === `Задача ${index + 1}` &&
            p.localizations.zh.title === `棋题 ${index + 1}` &&
            p.prompt === "Reconstruct the last move." &&
            p.localizations.ru.prompt === "Восстановите последний ход." &&
            p.localizations.zh.prompt === "还原上一步棋。",
        ) &&
        daily.puzzles.every((p) => isDeepStrictEqual(daily.progressStates[p.id], progress())),
      "FRESH_DAILY_FAILED",
    );
    const first = daily.puzzles[0];
    function expectedStats(attempts, points, solved = false) {
      const complete = solved && daily.puzzles.length === 1 ? 1 : 0;
      return {
        attempts,
        hintsUsed: 0,
        solvedPuzzles: solved ? 1 : 0,
        completedCases: complete,
        currentStreak: complete,
        bestStreak: complete,
        lastCompletedDate: complete ? date : null,
        points,
      };
    }
    async function stats(attempts, points, solved = false) {
      const { data } = await api("/v1/me/stats");
      ensure(
        keys(data, [...statisticCounters, "lastCompletedDate"]) &&
          isDeepStrictEqual(data, expectedStats(attempts, points, solved)),
        "SCORING_STATS_FAILED",
      );
    }
    async function reload(expected, solved, clue) {
      const { data } = await api(dailyPath);
      const unlocked = expected.clueUnlocked || solved;
      ensure(
        validDaily(data, date) &&
          data.id === daily.id &&
          data.puzzles.length === daily.puzzles.length &&
          isDeepStrictEqual(
            data.puzzles.map((p) => stablePublicPuzzle(p, p.id === first.id && unlocked)),
            daily.puzzles.map((p) => stablePublicPuzzle(p, p.id === first.id && unlocked)),
          ) &&
          (!unlocked || data.puzzles[0].prompt === row.prompt) &&
          (!clue ||
            (data.puzzles[0].title === clue.title &&
              ["ru", "zh"].every(
                (locale) =>
                  data.puzzles[0].localizations[locale].title ===
                    clue.localizations[locale].title &&
                  data.puzzles[0].localizations[locale].prompt ===
                    clue.localizations[locale].prompt,
              ))) &&
          isDeepStrictEqual(data.solvedPuzzleIds, solved ? [first.id] : []) &&
          data.puzzles.every((p) =>
            isDeepStrictEqual(data.progressStates[p.id], p.id === first.id ? expected : progress()),
          ),
        "SCORING_RELOAD_FAILED",
      );
    }
    await stats(0, 0);
    return { api, daily, first, stats, reload };
  }
  const fresh = await createActor();
  const { data: stored } = await call(
    "D1",
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql: solutionSql, params: [date] }),
    },
  );
  ensure(
    stored?.success === true &&
      Array.isArray(stored.result) &&
      stored.result.length === 1 &&
      stored.result[0]?.success === true &&
      Array.isArray(stored.result[0].results) &&
      stored.result[0].results.length === 1,
    "D1_SOLUTION_FAILED",
  );
  const row = stored.result[0].results[0];
  ensure(
    keys(row, ["case_id", "puzzle_id", "prompt", "solution_json"]) &&
      row.case_id === fresh.daily.id &&
      row.puzzle_id === fresh.first.id &&
      nonempty(row.prompt) &&
      typeof row.solution_json === "string",
    "D1_SOLUTION_FAILED",
  );
  let solution;
  try {
    solution = JSON.parse(row.solution_json);
  } catch {
    throw new DiagnosticError("D1_SOLUTION_FAILED");
  }
  ensure(validSolution(solution), "D1_SOLUTION_FAILED");

  async function solveAndReplay(actor, attemptCount, assistanceCount, points, priorAttempts) {
    const attempt = {
      attemptUuid: nextUuid(),
      caseId: actor.daily.id,
      puzzleId: actor.first.id,
      retraction: solution.retraction,
    };
    const { data: correct } = await actor.api("/v1/attempts", attempt, 201);
    ensure(
      keys(correct, ["id", "attemptUuid", "correct", "reveal", "progress"]) &&
        typeof correct.id === "string" &&
        uuidPattern.test(correct.id) &&
        correct.attemptUuid === attempt.attemptUuid &&
        correct.correct === true &&
        keys(correct.reveal, [
          "retraction",
          "previousFen",
          "forwardSan",
          "explanation",
          "historyConstraints",
          "localizations",
        ]) &&
        translated(correct.reveal.localizations, ["explanation"]),
      "SCORING_SOLVE_FAILED",
    );
    const { localizations: _translations, ...englishReveal } = correct.reveal;
    ensure(
      validSolution(englishReveal) && isDeepStrictEqual(englishReveal, solution),
      "SCORING_SOLVE_FAILED",
    );
    const earned = progress(attemptCount, assistanceCount, points, correct.id);
    ensure(isDeepStrictEqual(correct.progress, earned), "SCORING_AWARD_FAILED");
    await actor.stats(priorAttempts + 1, points, true);
    const replay = await actor.api("/v1/attempts", attempt);
    ensure(
      replay.headers.get("idempotency-replayed") === "true" &&
        isDeepStrictEqual(replay.data, correct),
      "SCORING_IDEMPOTENCY_FAILED",
    );
    await actor.stats(priorAttempts + 1, points, true);
    const repeatAttemptUuid = nextUuid();
    const duplicate = await actor.api(
      "/v1/attempts",
      { ...attempt, attemptUuid: repeatAttemptUuid },
      201,
    );
    ensure(
      keys(duplicate.data, ["id", "attemptUuid", "correct", "reveal", "progress"]) &&
        typeof duplicate.data.id === "string" &&
        uuidPattern.test(duplicate.data.id) &&
        duplicate.data.id !== correct.id &&
        duplicate.data.correct === true &&
        duplicate.data.attemptUuid === repeatAttemptUuid &&
        isDeepStrictEqual(duplicate.data.reveal, correct.reveal) &&
        isDeepStrictEqual(duplicate.data.progress, earned),
      "SCORING_DUPLICATE_AWARD_FAILED",
    );
    await actor.stats(priorAttempts + 2, points, true);
    await actor.reload(earned, true);
    return earned;
  }
  const freshEarned = await solveAndReplay(fresh, 1, 0, 100, 0);
  const assisted = await createActor();
  ensure(
    assisted.daily.id === fresh.daily.id && assisted.first.id === fresh.first.id,
    "ACTOR_DAILY_MISMATCH",
  );
  const wrong = {
    attemptUuid: nextUuid(),
    caseId: assisted.daily.id,
    puzzleId: assisted.first.id,
    retraction: {
      ...solution.retraction,
      movedPiece: {
        ...solution.retraction.movedPiece,
        color: solution.retraction.movedPiece.color === "w" ? "b" : "w",
      },
      restoredPiece: null,
      special: "normal",
    },
  };
  const { data: incorrect } = await assisted.api("/v1/attempts", wrong, 201);
  ensure(
    keys(incorrect, ["id", "attemptUuid", "correct", "contradiction", "progress"]) &&
      typeof incorrect.id === "string" &&
      uuidPattern.test(incorrect.id) &&
      incorrect.attemptUuid === wrong.attemptUuid &&
      incorrect.correct === false &&
      keys(incorrect.contradiction, ["code", "message", "localizations"]) &&
      incorrect.contradiction.code === "WRONG_COLOR" &&
      nonempty(incorrect.contradiction.message) &&
      translated(incorrect.contradiction.localizations, ["message"]) &&
      isDeepStrictEqual(incorrect.progress, progress(1)),
    "SCORING_WRONG_ATTEMPT_FAILED",
  );
  await assisted.stats(1, 0);
  const cluePath = `/v1/cases/${encodeURIComponent(assisted.daily.id)}/puzzles/${encodeURIComponent(assisted.first.id)}/clue`;
  const { data: clue } = await assisted.api(cluePath, {});
  ensure(
    keys(clue, ["title", "prompt", "localizations", "progress"]) &&
      nonempty(clue.title) &&
      clue.prompt === row.prompt &&
      translated(clue.localizations, ["title", "prompt"]) &&
      isDeepStrictEqual(clue.progress, progress(1, 1)),
    "SCORING_CLUE_FAILED",
  );
  const repeatedClue = await assisted.api(cluePath, {});
  ensure(isDeepStrictEqual(repeatedClue.data, clue), "SCORING_CLUE_IDEMPOTENCY_FAILED");
  await assisted.stats(1, 0);
  await assisted.reload(progress(1, 1), false, clue);
  await solveAndReplay(assisted, 2, 1, 35, 1);
  // The other actor's clue and attempts must never alter an existing award.
  await fresh.stats(2, 100, true);
  await fresh.reload(freshEarned, true);
  return {
    ok: true,
    date,
    actors: 2,
    puzzlesSolved: 2,
    points: [100, 35],
    idempotencyVerified: true,
    cluePenaltyVerified: true,
    duplicateAwardsPrevented: true,
    reloadVerified: true,
    actorIsolationVerified: true,
    conditionsHidden: true,
    clueConditionsVerified: true,
  };
}

export async function runCli(
  args,
  env,
  { log = console.log, errorLog = console.error, ...deps } = {},
) {
  try {
    ensure(args.length === 0, "UNEXPECTED_ARGUMENTS");
    log(JSON.stringify(await checkProductionScoring(env, deps)));
    return 0;
  } catch (error) {
    errorLog(
      JSON.stringify({
        ok: false,
        code: error instanceof DiagnosticError ? error.message : "SCORING_CHECK_FAILED",
      }),
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
