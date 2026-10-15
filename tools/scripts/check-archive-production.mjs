import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArguments } from "./check-deployment.mjs";

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

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function hasPrivateFields(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(([key, child]) => privateFields.has(key) || hasPrivateFields(child))
  );
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

/** Read every backfilled day through the same authenticated API the archive uses. */
export async function checkArchiveCoverage(
  { apiOrigin, webOrigin, from, through },
  { fetch: request = globalThis.fetch, now = () => new Date() } = {},
) {
  parseArguments(["--api-origin", apiOrigin, "--web-origin", webOrigin]);
  ensure(isoDate(from) && isoDate(through) && from <= through, "INVALID_ARCHIVE_RANGE");
  const count = (Date.parse(through) - Date.parse(from)) / 86_400_000 + 1;
  ensure(count <= 60 && through < now().toISOString().slice(0, 10), "INVALID_ARCHIVE_RANGE");
  let token;
  async function call(path, body) {
    let response;
    try {
      response = await request(`${apiOrigin}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: webOrigin,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("ARCHIVE_TRANSPORT_FAILED");
    }
    ensure(response.status === (body ? 201 : 200), "ARCHIVE_HTTP_FAILED");
    ensure(
      response.headers.get("access-control-allow-origin") === webOrigin,
      "ARCHIVE_CORS_FAILED",
    );
    ensure(
      (response.headers.get("cache-control") ?? "")
        .split(",")
        .some((part) => part.trim().toLowerCase() === "no-store"),
      "ARCHIVE_CACHE_FAILED",
    );
    try {
      return await response.json();
    } catch {
      throw new Error("ARCHIVE_JSON_FAILED");
    }
  }
  const session = await call("/v1/sessions/guest", { channel: "web" });
  ensure(
    session?.kind === "guest" &&
      typeof session.token === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(session.token) &&
      Date.parse(session.expiresAt) > now().getTime(),
    "ARCHIVE_SESSION_FAILED",
  );
  token = session.token;
  const before = now().toISOString().slice(0, 10);
  const archive = await call("/v1/archive");
  const after = now().toISOString().slice(0, 10);
  ensure(!hasPrivateFields(archive), "ARCHIVE_PRIVATE_FIELDS");
  ensure(
    keys(archive, ["today", "startsOn", "cases"]) &&
      [before, after].includes(archive.today) &&
      Array.isArray(archive.cases),
    "ARCHIVE_CATALOG_FAILED",
  );
  const catalog = new Map();
  let previousDate = "9999-12-31";
  for (const item of archive.cases) {
    ensure(
      keys(item, ["id", "date", "slug", "title", "puzzleCount", "solvedPuzzles", "completed"]) &&
        ["id", "slug", "title"].every(
          (key) => typeof item[key] === "string" && item[key].length > 0,
        ) &&
        isoDate(item.date) &&
        item.date <= archive.today &&
        item.date < previousDate &&
        Number.isSafeInteger(item.puzzleCount) &&
        item.puzzleCount > 0 &&
        item.solvedPuzzles === 0 &&
        item.completed === false,
      "ARCHIVE_CATALOG_FAILED",
    );
    previousDate = item.date;
    catalog.set(item.date, item);
  }
  ensure(archive.startsOn === (archive.cases.at(-1)?.date ?? null), "ARCHIVE_CATALOG_FAILED");
  const dates = Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10),
  );
  ensure(
    dates.every((date) => catalog.has(date)),
    "ARCHIVE_MISSING_DATES",
  );
  let puzzles = 0;
  for (let offset = 0; offset < dates.length; offset += 5) {
    const results = await Promise.all(
      dates.slice(offset, offset + 5).map(async (date) => {
        const daily = await call(`/v1/daily?date=${date}`);
        const item = catalog.get(date);
        ensure(!hasPrivateFields(daily), "ARCHIVE_PRIVATE_FIELDS");
        ensure(
          keys(daily, ["id", "date", "title", "puzzles", "solvedPuzzleIds"]) &&
            daily.date === date &&
            daily.id === item.id &&
            daily.title === item.title &&
            Array.isArray(daily.puzzles) &&
            daily.puzzles.length === item.puzzleCount &&
            daily.puzzles.every(
              (puzzle) =>
                keys(puzzle, [
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
                ["id", "title", "prompt", "postFen", "provenance", "license"].every(
                  (key) => typeof puzzle[key] === "string" && puzzle[key].length > 0,
                ) &&
                Number.isSafeInteger(puzzle.version) &&
                puzzle.version > 0 &&
                Number.isSafeInteger(puzzle.maxHints) &&
                puzzle.maxHints >= 0 &&
                ["w", "b"].includes(puzzle.retractingColor),
            ) &&
            new Set(daily.puzzles.map((puzzle) => puzzle.id)).size === daily.puzzles.length &&
            Array.isArray(daily.solvedPuzzleIds) &&
            daily.solvedPuzzleIds.length === 0,
          "ARCHIVE_DAILY_FAILED",
        );
        return daily.puzzles.length;
      }),
    );
    puzzles += results.reduce((sum, value) => sum + value, 0);
  }
  return { ok: true, from, through, cases: dates.length, puzzles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const request = JSON.parse(
      await readFile(resolve(root, "ops/content-key-request.json"), "utf8"),
    );
    let envelopePresent = true;
    try {
      await access(resolve(root, "ops/content-envelope.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      envelopePresent = false;
    }
    if (request.purpose !== "archive" || !envelopePresent) {
      console.log(JSON.stringify({ skipped: true, reason: "NO_ARCHIVE_PUBLICATION" }));
    } else {
      console.log(
        JSON.stringify(
          await checkArchiveCoverage({
            apiOrigin: process.env.API_ORIGIN,
            webOrigin: "https://agent-axiom.github.io",
            from: request.from,
            through: request.through,
          }),
        ),
      );
    }
  } catch (error) {
    // All request and response exceptions are replaced by fixed diagnostics.
    const code =
      error instanceof Error && /^ARCHIVE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "ARCHIVE_CHECK_FAILED";
    console.error(JSON.stringify({ ok: false, code }));
    process.exitCode = 1;
  }
}
