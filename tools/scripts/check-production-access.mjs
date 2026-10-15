import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is the only SQL this diagnostic can send. It returns no content or player data.
const coverageSql = `SELECT c.case_date AS date, c.status AS status,
  COUNT(p.id) AS puzzle_count,
  SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) AS published_puzzle_count
FROM daily_cases c
LEFT JOIN daily_case_puzzles cp ON cp.case_id = c.id
LEFT JOIN puzzles p ON p.id = cp.puzzle_id
WHERE c.case_date >= ? AND c.case_date <= ?
GROUP BY c.case_date, c.status
ORDER BY c.case_date
LIMIT 15`;

class DiagnosticError extends Error {}

function ensure(condition, code) {
  if (!condition) throw new DiagnosticError(code);
}

function safeCode(error) {
  return error instanceof DiagnosticError ? error.message : "CHECK_FAILED";
}

function bindings(env) {
  const names = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "D1_DATABASE_ID",
    "TELEGRAM_BOT_TOKEN",
  ];
  ensure(
    names.every((name) => typeof env[name] === "string" && env[name].trim() !== ""),
    "MISSING_REQUIRED_BINDINGS",
  );
  ensure(/^[A-Za-z0-9_-]+$/.test(env.CLOUDFLARE_API_TOKEN), "INVALID_CLOUDFLARE_API_TOKEN");
  ensure(/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID), "INVALID_CLOUDFLARE_ACCOUNT_ID");
  ensure(
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(env.D1_DATABASE_ID),
    "INVALID_D1_DATABASE_ID",
  );
  ensure(/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN), "INVALID_TELEGRAM_BOT_TOKEN");
}

/** Read-only Cloudflare D1 coverage and Telegram bot access; never returns raw API payloads. */
export async function checkProductionAccess(
  env,
  { fetch: request = globalThis.fetch, now = () => new Date() } = {},
) {
  bindings(env);
  const start = now();
  ensure(start instanceof Date && Number.isFinite(start.getTime()), "INVALID_DATE");
  const dates = Array.from({ length: 15 }, (_, offset) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });

  async function call(service, url, options) {
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
    ensure(response?.status === 200, `${service}_HTTP_FAILED`);
    try {
      return await response.json();
    } catch {
      throw new DiagnosticError(`${service}_INVALID_JSON`);
    }
  }

  let d1;
  try {
    const data = await call(
      "D1",
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ sql: coverageSql, params: [dates[0], dates[14]] }),
      },
    );
    ensure(data?.success === true, "D1_QUERY_FAILED");
    ensure(Array.isArray(data.result) && data.result.length === 1, "D1_INVALID_RESPONSE");
    const result = data.result[0];
    ensure(result?.success === true, "D1_QUERY_FAILED");
    ensure(Array.isArray(result.results) && result.results.length <= 15, "D1_INVALID_RESPONSE");
    const rows = new Map();
    for (const row of result.results) {
      ensure(
        row !== null &&
          typeof row === "object" &&
          dates.includes(row.date) &&
          !rows.has(row.date) &&
          ["draft", "published", "retired"].includes(row.status) &&
          Number.isSafeInteger(row.puzzle_count) &&
          row.puzzle_count >= 0 &&
          Number.isSafeInteger(row.published_puzzle_count) &&
          row.published_puzzle_count >= 0 &&
          row.published_puzzle_count <= row.puzzle_count,
        "D1_INVALID_RESPONSE",
      );
      rows.set(row.date, {
        date: row.date,
        status: row.status,
        puzzleCount: row.puzzle_count,
        publishedPuzzleCount: row.published_puzzle_count,
      });
    }
    d1 = {
      ok: true,
      coverage: dates.map(
        (date) =>
          rows.get(date) ?? { date, status: "missing", puzzleCount: 0, publishedPuzzleCount: 0 },
      ),
    };
  } catch (error) {
    d1 = { ok: false, code: safeCode(error) };
  }

  let telegram;
  try {
    const data = await call(
      "TELEGRAM",
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`,
      {
        method: "GET",
        headers: { accept: "application/json" },
      },
    );
    ensure(data?.ok === true && data.result?.is_bot === true, "TELEGRAM_ACCESS_FAILED");
    telegram = { ok: true };
  } catch (error) {
    telegram = { ok: false, code: safeCode(error) };
  }
  return { ok: d1.ok && telegram.ok, d1, telegram };
}

export async function runCli(
  args,
  env,
  { log = console.log, errorLog = console.error, ...dependencies } = {},
) {
  try {
    ensure(args.length === 0, "UNEXPECTED_ARGUMENTS");
    const result = await checkProductionAccess(env, dependencies);
    log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    errorLog(JSON.stringify({ ok: false, code: safeCode(error) }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2), process.env);
}
