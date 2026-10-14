import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: check-deployment --api-origin <origin> --web-origin <origin>";
const privateFields = new Set([
  "acceptedSolutions",
  "previousFen",
  "forwardSan",
  "explanation",
  "historyConstraints",
  "hints",
  "contradictionExplanations",
]);

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

function hasKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nonempty(value) {
  return typeof value === "string" && value.length > 0;
}

function futureIsoDate(value, now) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    return false;
  }
  const time = Date.parse(value);
  return time > now.getTime() && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function canonicalOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_ORIGIN");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  ensure(
    url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      (url.protocol === "https:" || (local && url.protocol === "http:")),
    "INVALID_ORIGIN",
  );
  return value;
}

function hasPrivateFields(value) {
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => privateFields.has(key) || hasPrivateFields(child),
  );
}

function includesHeader(value, token) {
  return (value ?? "")
    .toLowerCase()
    .split(",")
    .some((item) => item.trim() === token);
}

/** Exercises deployed API and D1 with one empty guest; never submits attempts or Telegram proof. */
export async function checkDeployment(
  { apiOrigin, webOrigin },
  { fetch: request = globalThis.fetch, now = () => new Date(), timeoutMs = 10_000 } = {},
) {
  canonicalOrigin(apiOrigin);
  canonicalOrigin(webOrigin);
  let token;

  async function call(path, { method = "GET", body, preflight } = {}) {
    const headers = { origin: webOrigin, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token && !preflight) headers.authorization = `Bearer ${token}`;
    if (preflight) {
      headers["access-control-request-method"] = preflight.method;
      headers["access-control-request-headers"] = preflight.headers;
    }
    let response;
    try {
      response = await request(`${apiOrigin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`TRANSPORT_FAILED ${method} ${path}`);
    }
    ensure(
      response.headers.get("access-control-allow-origin") === webOrigin,
      `CORS_FAILED ${path}`,
    );
    if (preflight) {
      ensure(response.status === 204, `PREFLIGHT_FAILED ${path}`);
      ensure(
        includesHeader(
          response.headers.get("access-control-allow-methods"),
          preflight.method.toLowerCase(),
        ),
        `CORS_METHOD_FAILED ${path}`,
      );
      ensure(
        includesHeader(response.headers.get("access-control-allow-headers"), preflight.headers),
        `CORS_HEADERS_FAILED ${path}`,
      );
      return;
    }
    const status = path === "/v1/sessions/guest" ? 201 : 200;
    ensure(response.status === status, `HTTP_${response.status} ${method} ${path}`);
    if (method === "POST" || path === "/v1/me") {
      ensure(
        includesHeader(response.headers.get("cache-control"), "no-store"),
        `CACHE_POLICY_FAILED ${path}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`INVALID_JSON ${path}`);
    }
  }

  const health = await call("/v1/healthz");
  ensure(health?.ok === true, "HEALTH_FAILED");
  await call("/v1/sessions/guest", {
    method: "OPTIONS",
    preflight: { method: "POST", headers: "content-type" },
  });
  await call("/v1/daily", {
    method: "OPTIONS",
    preflight: { method: "GET", headers: "authorization" },
  });
  const session = await call("/v1/sessions/guest", { method: "POST", body: { channel: "web" } });
  ensure(
    hasKeys(session, ["kind", "token", "expiresAt"]) &&
      session.kind === "guest" &&
      typeof session.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(session.token) &&
      futureIsoDate(session.expiresAt, now()),
    "GUEST_SESSION_FAILED",
  );
  token = session.token;
  const me = await call("/v1/me");
  ensure(
    hasKeys(me, ["kind", "profile"]) && me.kind === "guest" && me.profile === null,
    "GUEST_IDENTITY_FAILED",
  );
  const stats = await call("/v1/me/stats");
  const counters = [
    "attempts",
    "hintsUsed",
    "solvedPuzzles",
    "completedCases",
    "currentStreak",
    "bestStreak",
  ];
  ensure(
    hasKeys(stats, [...counters, "lastCompletedDate"]) &&
      counters.every((key) => stats[key] === 0) &&
      stats.lastCompletedDate === null,
    "GUEST_STATS_FAILED",
  );
  const dayBefore = now().toISOString().slice(0, 10);
  const daily = await call("/v1/daily");
  const dayAfter = now().toISOString().slice(0, 10);
  ensure(daily?.date === dayBefore || daily?.date === dayAfter, "CURRENT_DAILY_FAILED");
  ensure(!hasPrivateFields(daily), "PRIVATE_DAILY_FIELDS");
  ensure(
    hasKeys(daily, ["id", "date", "title", "puzzles", "solvedPuzzleIds"]) &&
      nonempty(daily.id) &&
      nonempty(daily.title) &&
      Array.isArray(daily.puzzles) &&
      daily.puzzles.length > 0 &&
      daily.puzzles.every(
        (puzzle) =>
          hasKeys(puzzle, [
            "id",
            "version",
            "title",
            "prompt",
            "postFen",
            "retractingColor",
            "maxHints",
            "provenance",
            "license",
          ]) &&
          ["id", "title", "prompt", "postFen", "provenance", "license"].every((key) =>
            nonempty(puzzle[key]),
          ) &&
          Number.isInteger(puzzle.version) &&
          puzzle.version > 0 &&
          ["w", "b"].includes(puzzle.retractingColor) &&
          Number.isInteger(puzzle.maxHints) &&
          puzzle.maxHints >= 0,
      ) &&
      Array.isArray(daily.solvedPuzzleIds) &&
      daily.solvedPuzzleIds.length === 0,
    "DAILY_PAYLOAD_FAILED",
  );
  return { ok: true, date: daily.date, puzzleCount: daily.puzzles.length };
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const key =
      flag === "--api-origin" ? "apiOrigin" : flag === "--web-origin" ? "webOrigin" : null;
    const value = args[index + 1];
    ensure(key !== null && !Object.hasOwn(options, key) && typeof value === "string", usage);
    options[key] = canonicalOrigin(value);
  }
  ensure(typeof options.apiOrigin === "string" && typeof options.webOrigin === "string", usage);
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkDeployment(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    // Only our fixed diagnostic codes reach logs; never print response bodies or credentials.
    console.error(`Deployment check failed: ${error instanceof Error ? error.message : "UNKNOWN"}`);
    process.exitCode = 1;
  }
}
