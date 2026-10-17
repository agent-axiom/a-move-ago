import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Operational metadata only: never select puzzle JSON, clues, answers or actors.
const coverageSql = `SELECT c.case_date AS date, COUNT(cp.puzzle_id) AS puzzles,
  SUM(CASE WHEN p.status = 'published' AND EXISTS (
    SELECT 1 FROM puzzle_solutions s WHERE s.puzzle_id = p.id) THEN 1 ELSE 0 END) AS ready,
  (SELECT COUNT(*) FROM case_localizations cl WHERE cl.case_id = c.id
    AND cl.locale IN ('ru', 'zh')) AS case_locales,
  (SELECT COUNT(*) FROM daily_case_puzzles lp
    JOIN puzzle_localizations pl ON pl.puzzle_id = lp.puzzle_id
    WHERE lp.case_id = c.id AND pl.locale IN ('ru', 'zh')) AS puzzle_locales
FROM daily_cases c
LEFT JOIN daily_case_puzzles cp ON cp.case_id = c.id
LEFT JOIN puzzles p ON p.id = cp.puzzle_id
WHERE c.case_date >= ? AND c.case_date <= ? AND c.status = 'published'
GROUP BY c.id, c.case_date ORDER BY c.case_date`;

class CoverageError extends Error {}
function ensure(condition, code) {
  if (!condition) throw new CoverageError(code);
}
function isoDate(value) {
  const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validRow(value) {
  const fields = ["date", "puzzles", "ready", "case_locales", "puzzle_locales"];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field)) && isoDate(value.date)
    && fields.slice(1).every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0);
}

/** Read protected D1 metadata to verify dates the public API deliberately hides. */
export async function checkContentCoverage(
  { from, through, requireLocalizations = false, minimumFutureDays = 0 },
  { env = process.env, fetch: request = globalThis.fetch, now = () => new Date() } = {},
) {
  try {
    const today = now().toISOString().slice(0, 10);
    from ??= today;
    ensure(isoDate(from) && isoDate(through) && from <= today && through >= today,
      "COVERAGE_INVALID_RANGE");
    const cases = (Date.parse(through) - Date.parse(from)) / 86_400_000 + 1;
    const futureDays = (Date.parse(through) - Date.parse(today)) / 86_400_000;
    ensure(cases >= 1 && cases <= 366, "COVERAGE_INVALID_RANGE");
    ensure(typeof requireLocalizations === "boolean"
      && Number.isSafeInteger(minimumFutureDays) && minimumFutureDays >= 0
      && minimumFutureDays <= 365, "COVERAGE_INVALID_OPTIONS");
    ensure(futureDays >= minimumFutureDays, "COVERAGE_INSUFFICIENT_HORIZON");
    const { CLOUDFLARE_ACCOUNT_ID: account, D1_DATABASE_ID: database,
      CLOUDFLARE_API_TOKEN: token } = env;
    ensure(typeof account === "string" && /^[a-f0-9]{32}$/i.test(account)
      && typeof database === "string"
      && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(database)
      && typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token), "COVERAGE_INVALID_BINDINGS");
    let response;
    try {
      response = await request(
        `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
        { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ batch: [{ sql: coverageSql, params: [from, through] }] }),
          redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) },
      );
    } catch {
      throw new CoverageError("COVERAGE_TRANSPORT_FAILED");
    }
    ensure(response?.status === 200, "COVERAGE_HTTP_FAILED");
    let payload;
    try { payload = await response.json(); } catch { throw new CoverageError("COVERAGE_JSON_FAILED"); }
    const result = payload?.result;
    ensure(payload?.success === true && Array.isArray(result) && result.length === 1
      && result[0]?.success === true && Array.isArray(result[0].results), "COVERAGE_D1_FAILED");
    const rows = result[0].results;
    ensure(rows.length === cases, "COVERAGE_MISSING_DATES");
    let puzzles = 0;
    for (const [index, row] of rows.entries()) {
      ensure(validRow(row), "COVERAGE_INVALID_RESPONSE");
      const expectedDate = new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10);
      ensure(row.date === expectedDate, "COVERAGE_MISSING_DATES");
      ensure(row.puzzles > 0 && row.ready === row.puzzles, "COVERAGE_UNPLAYABLE_DAY");
      ensure(row.case_locales <= 2 && row.puzzle_locales <= row.puzzles * 2, "COVERAGE_INVALID_RESPONSE");
      if (requireLocalizations) {
        ensure(row.case_locales === 2 && row.puzzle_locales === row.puzzles * 2,
          "COVERAGE_MISSING_LOCALIZATIONS");
      }
      puzzles += row.puzzles;
    }
    return { ok: true, from, through, cases, puzzles, futureDays,
      ...(requireLocalizations ? { locales: ["en", "ru", "zh"] } : {}) };
  } catch (error) {
    throw error instanceof CoverageError ? error : new CoverageError("COVERAGE_CHECK_FAILED");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const input = JSON.parse(await readFile(resolve(root, "ops/content-key-request.json"), "utf8"));
    let envelopePresent = true;
    try { await access(resolve(root, "ops/content-envelope.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; envelopePresent = false; }
    if (!["schedule", "localization"].includes(input.purpose) || !envelopePresent) {
      console.log(JSON.stringify({ skipped: true, reason: "NO_SCHEDULE_PUBLICATION" }));
    } else if (isoDate(input.through) && input.through < new Date().toISOString().slice(0, 10)) {
      console.log(JSON.stringify({ skipped: true, reason: "SCHEDULE_ALREADY_ELAPSED" }));
    } else {
      console.log(JSON.stringify(await checkContentCoverage({
        through: input.through, requireLocalizations: input.purpose === "localization",
      })));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false,
      code: error instanceof CoverageError ? error.message : "COVERAGE_CHECK_FAILED" }));
    process.exitCode = 1;
  }
}
