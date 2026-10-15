import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "./check-deployment.mjs";

const locales = ["ru", "zh"];
const privateFields = new Set([
  "acceptedSolutions",
  "previousFen",
  "forwardSan",
  "explanation",
  "historyConstraints",
  "hints",
  "contradictionExplanations",
  "retraction",
  "restoredPiece",
]);
const caseFields = ["id", "date", "slug", "title", "puzzleCount", "solvedPuzzles", "completed"];
const puzzleFields = [
  "id",
  "version",
  "title",
  "prompt",
  "postFen",
  "retractingColor",
  "maxHints",
  "provenance",
  "license",
];

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}
function keys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function safe(value) {
  return (
    value === null ||
    typeof value !== "object" ||
    Object.entries(value).every(([key, child]) => !privateFields.has(key) && safe(child))
  );
}
function isoDate(value) {
  const time =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Date.parse(`${value}T00:00:00Z`)
      : Number.NaN;
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function translated(value, fields, requireAll = true) {
  const present = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value) : null;
  ensure(present && present.every((locale) => locales.includes(locale)) &&
    (!requireAll || locales.every((locale) => present.includes(locale))),
  "LOCALES_TRANSLATIONS_FAILED");
  for (const locale of present) {
    ensure(
      keys(value[locale], fields) &&
        fields.every(
          (field) =>
            typeof value[locale][field] === "string" && value[locale][field].trim().length > 0,
        ),
      "LOCALES_TRANSLATIONS_FAILED",
    );
    ensure(
      (locale === "ru" ? /\p{Script=Cyrillic}/u : /\p{Script=Han}/u).test(
        value[locale][fields.includes("prompt") ? "prompt" : "title"],
      ),
      "LOCALES_TRANSLATIONS_FAILED",
    );
  }
}
function englishBase(value) {
  if (Array.isArray(value)) return value.map(englishBase);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "localizations")
        .map(([key, child]) => [key, englishBase(child)]),
    );
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function unchanged(english, localized) {
  ensure(
    JSON.stringify(canonical(english)) === JSON.stringify(canonical(englishBase(localized))),
    "LOCALES_ENGLISH_COMPATIBILITY_FAILED",
  );
}

/** Verify public translations and compatibility; never request hints, attempts or solutions. */
export async function checkLocalizationsCoverage(
  { apiOrigin, webOrigin, from = "2026-09-10", through },
  { fetch: request = globalThis.fetch, now = () => new Date() } = {},
) {
  parseArguments(["--api-origin", apiOrigin, "--web-origin", webOrigin]);
  const today = now().toISOString().slice(0, 10);
  through ??= today;
  ensure(
    isoDate(from) && isoDate(through) && from <= through && through <= today,
    "LOCALES_INVALID_RANGE",
  );
  const count = (Date.parse(through) - Date.parse(from)) / 86_400_000 + 1;
  ensure(count <= 366, "LOCALES_INVALID_RANGE");
  let token;
  async function call(path, localized = false, body) {
    let response;
    try {
      response = await request(`${apiOrigin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: webOrigin,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(localized ? { "x-content-locales": "1" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("LOCALES_TRANSPORT_FAILED");
    }
    ensure(response.status === (body ? 201 : 200), "LOCALES_HTTP_FAILED");
    ensure(
      response.headers.get("access-control-allow-origin") === webOrigin,
      "LOCALES_CORS_FAILED",
    );
    ensure(
      (response.headers.get("cache-control") ?? "")
        .split(",")
        .some((part) => part.trim().toLowerCase() === "no-store"),
      "LOCALES_CACHE_FAILED",
    );
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("LOCALES_JSON_FAILED");
    }
    ensure(safe(payload), "LOCALES_PRIVATE_FIELDS");
    return payload;
  }
  const session = await call("/v1/sessions/guest", false, { channel: "web" });
  ensure(
    session?.kind === "guest" &&
      typeof session.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(session.token) &&
      Date.parse(session.expiresAt) > now().getTime(),
    "LOCALES_SESSION_FAILED",
  );
  token = session.token;
  const before = now().toISOString().slice(0, 10);
  const [english, catalog] = await Promise.all([call("/v1/archive"), call("/v1/archive", true)]);
  const after = now().toISOString().slice(0, 10);
  ensure(
    keys(catalog, ["today", "startsOn", "cases"]) &&
      [before, after].includes(catalog.today) &&
      Array.isArray(catalog.cases),
    "LOCALES_CATALOG_FAILED",
  );
  let previous = "9999-12-31";
  const byDate = new Map();
  const outsideRangeCases = [];
  for (const item of catalog.cases) {
    const hasLocalizations = item !== null && typeof item === "object" && Object.hasOwn(item, "localizations");
    ensure(
      keys(item, [...caseFields, ...(hasLocalizations ? ["localizations"] : [])]) &&
        isoDate(item.date) &&
        item.date < previous &&
        item.date <= catalog.today &&
        ["id", "slug", "title"].every(
          (key) => typeof item[key] === "string" && item[key].length > 0,
        ) &&
        Number.isSafeInteger(item.puzzleCount) &&
        item.puzzleCount > 0 &&
        item.solvedPuzzles === 0 &&
        item.completed === false,
      "LOCALES_CATALOG_FAILED",
    );
    const inRange = item.date >= from && item.date <= through;
    if (inRange || hasLocalizations) {
      translated(item.localizations, ["title"], inRange);
    }
    if (!inRange) {
      const available = locales.filter((locale) => Object.hasOwn(item.localizations ?? {}, locale));
      if (available.length !== locales.length && outsideRangeCases.length < 60) {
        outsideRangeCases.push({ date: item.date, locales: available });
      }
    }
    previous = item.date;
    byDate.set(item.date, item);
  }
  ensure(catalog.startsOn === (catalog.cases.at(-1)?.date ?? null), "LOCALES_CATALOG_FAILED");
  unchanged(english, catalog);
  const dates = Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10),
  );
  ensure(
    dates.every((date) => byDate.has(date)),
    "LOCALES_MISSING_DATES",
  );
  let puzzles = 0;
  for (let start = 0; start < dates.length; start += 4) {
    const counts = await Promise.all(
      dates.slice(start, start + 4).map(async (date) => {
        const [base, daily] = await Promise.all([
          call(`/v1/daily?date=${date}`),
          call(`/v1/daily?date=${date}`, true),
        ]);
        const item = byDate.get(date);
        ensure(
          keys(daily, ["id", "date", "title", "puzzles", "solvedPuzzleIds", "localizations"]) &&
            daily.id === item.id &&
            daily.date === date &&
            daily.title === item.title &&
            Array.isArray(daily.puzzles) &&
            daily.puzzles.length === item.puzzleCount &&
            Array.isArray(daily.solvedPuzzleIds) &&
            daily.solvedPuzzleIds.length === 0,
          "LOCALES_DAILY_FAILED",
        );
        translated(daily.localizations, ["title"]);
        ensure(
          JSON.stringify(canonical(daily.localizations)) ===
            JSON.stringify(canonical(item.localizations)),
          "LOCALES_DAILY_FAILED",
        );
        for (const puzzle of daily.puzzles) {
          ensure(
            keys(puzzle, [...puzzleFields, "localizations"]) &&
              ["id", "title", "prompt", "postFen", "provenance", "license"].every(
                (key) => typeof puzzle[key] === "string" && puzzle[key].length > 0,
              ) &&
              Number.isSafeInteger(puzzle.version) &&
              puzzle.version > 0 &&
              Number.isSafeInteger(puzzle.maxHints) &&
              puzzle.maxHints >= 0 &&
              ["w", "b"].includes(puzzle.retractingColor),
            "LOCALES_DAILY_FAILED",
          );
          translated(puzzle.localizations, ["title", "prompt", "provenance", "license"]);
        }
        ensure(
          new Set(daily.puzzles.map((puzzle) => puzzle.id)).size === daily.puzzles.length,
          "LOCALES_DAILY_FAILED",
        );
        unchanged(base, daily);
        return daily.puzzles.length;
      }),
    );
    puzzles += counts.reduce((sum, value) => sum + value, 0);
  }
  return {
    ok: true,
    from,
    through,
    cases: dates.length,
    puzzles,
    locales,
    englishCompatible: true,
    ...(outsideRangeCases.length ? { outsideRangeCases } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const input = JSON.parse(await readFile(resolve(root, "ops/content-key-request.json"), "utf8"));
    let envelopePresent = true;
    try {
      await access(resolve(root, "ops/content-envelope.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      envelopePresent = false;
    }
    if (input.purpose !== "localization" || !envelopePresent) {
      console.log(JSON.stringify({ skipped: true, reason: "NO_LOCALIZATION_PUBLICATION" }));
    } else {
      console.log(
        JSON.stringify(
          await checkLocalizationsCoverage({
            apiOrigin: process.env.API_ORIGIN,
            webOrigin: "https://agent-axiom.github.io",
            from: "2026-09-10",
          }),
        ),
      );
    }
  } catch (error) {
    const code =
      error instanceof Error && /^LOCALES_[A-Z_]+$/.test(error.message)
        ? error.message
        : "LOCALES_CHECK_FAILED";
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  }
}
