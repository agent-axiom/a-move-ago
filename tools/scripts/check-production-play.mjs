import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Privileged read only; the public API must never provide this solution before a correct attempt.
const solutionSql = `SELECT c.id AS case_id, ('p-' || c.id || '-' || cp.position || '-v' || p.version) AS puzzle_id, s.solution_json
FROM daily_cases c
JOIN daily_case_puzzles cp ON cp.case_id = c.id
JOIN puzzles p ON p.id = cp.puzzle_id
JOIN puzzle_solutions s ON s.puzzle_id = p.id
WHERE c.case_date = ? AND c.status = 'published' AND p.status = 'published'
  AND cp.position = 1 AND s.sort_order = 1
LIMIT 1`;
const webOrigin = "https://agent-axiom.github.io";
const counters = [
  "attempts",
  "hintsUsed",
  "solvedPuzzles",
  "completedCases",
  "currentStreak",
  "bestStreak",
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
function englishSolution(value) {
  if (value === null || typeof value !== "object") return value;
  const { localizations: _translations, ...base } = value;
  return base;
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
  const fields = ["retraction", "previousFen", "forwardSan", "explanation", "historyConstraints"];
  if (!keys(value, fields)) return false;
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
    ["previousFen", "forwardSan", "explanation"].every((key) => nonempty(value[key])) &&
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
function validDaily(value, date, localized = false) {
  return (
    keys(value, [
      "id",
      "date",
      "title",
      "puzzles",
      "solvedPuzzleIds",
      ...(localized ? ["localizations"] : []),
    ]) &&
    (!localized || translated(value.localizations, ["title"])) &&
    nonempty(value.id) &&
    nonempty(value.title) &&
    value.date === date &&
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
          ...(localized ? ["localizations"] : []),
        ]) &&
        (!localized || translated(p.localizations, ["title", "prompt", "provenance", "license"])) &&
        ["id", "title", "prompt", "postFen", "provenance", "license"].every((key) =>
          nonempty(p[key]),
        ) &&
        ["w", "b"].includes(p.retractingColor) &&
        Number.isSafeInteger(p.version) &&
        p.version > 0 &&
        Number.isSafeInteger(p.maxHints) &&
        p.maxHints >= 0,
    ) &&
    new Set(value.puzzles.map((p) => p.id)).size === value.puzzles.length &&
    Array.isArray(value.solvedPuzzleIds)
  );
}

function neutralPrompt(puzzle, localized) {
  return (
    puzzle.prompt === "Reconstruct the last move." &&
    (!localized ||
      (puzzle.localizations.ru.prompt === "Восстановите последний ход." &&
        puzzle.localizations.zh.prompt === "还原上一步棋。"))
  );
}

// Solving unlocks only that puzzle's title and conditions; other content stays immutable.
function stablePublicPuzzle(puzzle, unlocked) {
  if (!unlocked) return puzzle;
  const { title: _title, prompt: _prompt, localizations, ...base } = puzzle;
  return {
    ...base,
    ...(localizations
      ? {
          localizations: Object.fromEntries(
            Object.entries(localizations).map(([locale, value]) => {
              const { title: _localizedTitle, prompt: _localizedPrompt, ...text } = value;
              return [locale, text];
            }),
          ),
        }
      : {}),
  };
}

/** Creates one synthetic guest and one correct attempt; replay must preserve its statistics. */
export async function checkProductionPlay(
  env,
  { fetch: request = globalThis.fetch, now = () => new Date(), uuid = randomUUID } = {},
) {
  validateBindings(env);
  const localized = env.CHECK_LOCALIZATIONS === "true";
  const date = now().toISOString().slice(0, 10);
  let token;
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
    if (service === "API") {
      ensure(response.headers.get("access-control-allow-origin") === webOrigin, "API_CORS_FAILED");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new DiagnosticError(`${service}_INVALID_JSON`);
    }
    return { data, headers: response.headers };
  }
  async function api(path, body, status = 200, includeLocalizations = localized) {
    return call(
      "API",
      `${env.API_ORIGIN}${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: webOrigin,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(includeLocalizations ? { "x-content-locales": "1" } : {}),
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
    validDaily(daily, date, localized) &&
      daily.solvedPuzzleIds.length === 0 &&
      daily.puzzles.every((puzzle) => neutralPrompt(puzzle, localized)),
    "PUBLIC_DAILY_FAILED",
  );
  async function stats(expected) {
    const { data } = await api("/v1/me/stats");
    ensure(
      keys(data, [...counters, "lastCompletedDate"]) && isDeepStrictEqual(data, expected),
      "GUEST_STATS_FAILED",
    );
    return data;
  }
  const empty = { ...Object.fromEntries(counters.map((key) => [key, 0])), lastCompletedDate: null };
  await stats(empty);
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
    row?.case_id === daily.id &&
      row.puzzle_id === daily.puzzles[0].id &&
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
  let wrongAttemptUuid;
  if (localized) {
    ensure(daily.puzzles[0].maxHints >= 1, "LOCALIZED_HINT_UNAVAILABLE");
    const wrong = {
      attemptUuid: uuid(),
      caseId: daily.id,
      puzzleId: daily.puzzles[0].id,
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
    ensure(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(wrong.attemptUuid),
      "INVALID_ATTEMPT_UUID",
    );
    wrongAttemptUuid = wrong.attemptUuid;
    const { data: incorrect } = await api("/v1/attempts", wrong, 201);
    ensure(
      keys(incorrect, ["id", "attemptUuid", "correct", "contradiction"]) &&
        typeof incorrect.id === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(incorrect.id) &&
        incorrect.attemptUuid === wrong.attemptUuid &&
        incorrect.correct === false &&
        keys(incorrect.contradiction, ["code", "message", "localizations"]) &&
        incorrect.contradiction.code === "WRONG_COLOR" &&
        nonempty(incorrect.contradiction.message) &&
        translated(incorrect.contradiction.localizations, ["message"]),
      "LOCALIZED_CONTRADICTION_FAILED",
    );
    const { data: hint } = await api(`/v1/attempts/${incorrect.id}/hints`, { level: 1 });
    ensure(
      keys(hint, ["level", "text", "exhausted", "localizations"]) &&
        hint.level === 1 &&
        nonempty(hint.text) &&
        typeof hint.exhausted === "boolean" &&
        translated(hint.localizations, ["text"]),
      "LOCALIZED_HINT_FAILED",
    );
    await stats({ ...empty, attempts: 1, hintsUsed: 1 });
  }
  const attempt = {
    attemptUuid: uuid(),
    caseId: daily.id,
    puzzleId: daily.puzzles[0].id,
    retraction: solution.retraction,
  };
  ensure(
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attempt.attemptUuid),
    "INVALID_ATTEMPT_UUID",
  );
  ensure(attempt.attemptUuid !== wrongAttemptUuid, "INVALID_ATTEMPT_UUID");
  const { data: correct } = await api("/v1/attempts", attempt, 201);
  ensure(
    keys(correct, ["id", "attemptUuid", "correct", "reveal"]) &&
      typeof correct.id === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(correct.id) &&
      correct.attemptUuid === attempt.attemptUuid &&
      correct.correct === true &&
      (localized
        ? keys(correct.reveal, [
            "retraction",
            "previousFen",
            "forwardSan",
            "explanation",
            "historyConstraints",
            "localizations",
          ]) &&
          translated(correct.reveal.localizations, ["explanation"]) &&
          validSolution(englishSolution(correct.reveal))
        : validSolution(correct.reveal)) &&
      isDeepStrictEqual(englishSolution(correct.reveal), solution),
    "CORRECT_ATTEMPT_FAILED",
  );
  const completed = daily.puzzles.length === 1 ? 1 : 0;
  const expected = {
    attempts: localized ? 2 : 1,
    hintsUsed: localized ? 1 : 0,
    solvedPuzzles: 1,
    completedCases: completed,
    currentStreak: completed,
    bestStreak: completed,
    lastCompletedDate: completed ? date : null,
  };
  await stats(expected);
  if (localized) {
    const englishReplay = await api("/v1/attempts", attempt, 200, false);
    ensure(
      englishReplay.headers.get("idempotency-replayed") === "true" &&
        keys(englishReplay.data, ["id", "attemptUuid", "correct", "reveal"]) &&
        englishReplay.data.id === correct.id &&
        englishReplay.data.attemptUuid === attempt.attemptUuid &&
        englishReplay.data.correct === true &&
        validSolution(englishReplay.data.reveal) &&
        isDeepStrictEqual(englishReplay.data.reveal, solution),
      "ENGLISH_REPLAY_FAILED",
    );
  }
  const replay = await api("/v1/attempts", attempt);
  ensure(
    replay.headers.get("idempotency-replayed") === "true" &&
      isDeepStrictEqual(replay.data, correct),
    "IDEMPOTENCY_FAILED",
  );
  const { data: reloaded } = await api(dailyPath);
  ensure(
    validDaily(reloaded, date, localized) &&
      reloaded.id === daily.id &&
      isDeepStrictEqual(
        reloaded.puzzles.map((puzzle) =>
          stablePublicPuzzle(puzzle, puzzle.id === attempt.puzzleId),
        ),
        daily.puzzles.map((puzzle) => stablePublicPuzzle(puzzle, puzzle.id === attempt.puzzleId)),
      ) &&
      isDeepStrictEqual(reloaded.solvedPuzzleIds, [attempt.puzzleId]),
    "RELOADED_DAILY_FAILED",
  );
  await stats(expected);
  if (localized) {
    return {
      ok: true,
      date,
      puzzlesSolved: 1,
      attempts: 2,
      hintsUsed: 1,
      locales: ["ru", "zh"],
      englishCompatible: true,
      idempotencyVerified: true,
    };
  }
  return { ok: true, date, puzzlesSolved: 1, attempts: 1, idempotencyVerified: true };
}

export async function runCli(
  args,
  env,
  { log = console.log, errorLog = console.error, ...deps } = {},
) {
  try {
    ensure(args.length === 0, "UNEXPECTED_ARGUMENTS");
    log(JSON.stringify(await checkProductionPlay(env, deps)));
    return 0;
  } catch (error) {
    errorLog(
      JSON.stringify({
        ok: false,
        code: error instanceof DiagnosticError ? error.message : "PLAY_CHECK_FAILED",
      }),
    );
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
