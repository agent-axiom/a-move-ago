import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { checkContentCoverage } from "../scripts/check-content-coverage.mjs";

const secret = "PRIVATE_DATA_MUST_NOT_APPEAR";
const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
  CLOUDFLARE_API_TOKEN: "private-token",
};
const now = () => new Date("2026-10-17T12:00:00Z");
const options = { through: "2027-01-31", minimumFutureDays: 90 };

function harness(mutate = () => {}, responseOverride) {
  const rows = Array.from({ length: 107 }, (_, index) => ({
    date: new Date(Date.parse("2026-10-17") + index * 86_400_000).toISOString().slice(0, 10),
    puzzles: 1,
    ready: 1,
    case_locales: 2,
    puzzle_locales: 2,
  }));
  const payload = { success: true, result: [{ success: true, results: rows }] };
  mutate(payload, rows);
  const requests = [];
  return {
    requests,
    run: (input = options, bindings = env) =>
      checkContentCoverage(input, {
        env: bindings,
        now,
        fetch: async (url, init) => {
          requests.push({ url, ...init });
          return responseOverride ? responseOverride() : new Response(JSON.stringify(payload));
        },
      }),
  };
}

test("verifies every published date and reports only a safe aggregate including future coverage", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), {
    ok: true,
    from: "2026-10-17",
    through: "2027-01-31",
    cases: 107,
    puzzles: 107,
    futureDays: 106,
  });
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.redirect, "error");
  assert.equal(request.cache, "no-store");
  assert.ok(request.signal instanceof AbortSignal);
  const { batch } = JSON.parse(request.body);
  assert.equal(batch.length, 1);
  assert.match(batch[0].sql, /^SELECT /);
  assert.doesNotMatch(
    batch[0].sql,
    /(?:public_json|private_json|solution_json|hint|player|session|attempt)/i,
  );
  assert.deepEqual(batch[0].params, ["2026-10-17", "2027-01-31"]);
});

test("English publication may precede translations, and the final localization check requires both languages", async () => {
  const english = harness((_payload, rows) => {
    for (const row of rows) {
      row.case_locales = 0;
      row.puzzle_locales = 0;
    }
  });
  assert.equal((await english.run()).ok, true);
  await assert.rejects(
    english.run({ ...options, requireLocalizations: true }),
    /COVERAGE_MISSING_LOCALIZATIONS/,
  );
  assert.deepEqual((await harness().run({ ...options, requireLocalizations: true })).locales, [
    "en",
    "ru",
    "zh",
  ]);
});

test("missing, duplicated, retired, empty or partially published days fail closed", async (t) => {
  const changes = [
    ["missing day", (_p, r) => r.splice(45, 1), "COVERAGE_MISSING_DATES"],
    [
      "duplicate date",
      (_p, r) => {
        r[46].date = r[45].date;
      },
      "COVERAGE_MISSING_DATES",
    ],
    [
      "unexpected date",
      (_p, r) => {
        r[0].date = "2026-10-16";
      },
      "COVERAGE_MISSING_DATES",
    ],
    [
      "bad calendar date",
      (_p, r) => {
        r[1].date = "2026-11-31";
      },
      "COVERAGE_INVALID_RESPONSE",
    ],
    [
      "empty day",
      (_p, r) => {
        r[50].puzzles = 0;
        r[50].ready = 0;
      },
      "COVERAGE_UNPLAYABLE_DAY",
    ],
    [
      "incomplete puzzle",
      (_p, r) => {
        r[50].ready = 0;
      },
      "COVERAGE_UNPLAYABLE_DAY",
    ],
    [
      "fractional count",
      (_p, r) => {
        r[50].puzzles = 1.5;
      },
      "COVERAGE_INVALID_RESPONSE",
    ],
    [
      "negative count",
      (_p, r) => {
        r[50].case_locales = -1;
      },
      "COVERAGE_INVALID_RESPONSE",
    ],
    [
      "extra locale rows",
      (_p, r) => {
        r[50].puzzle_locales = 3;
      },
      "COVERAGE_INVALID_RESPONSE",
    ],
    [
      "private field",
      (_p, r) => {
        r[0].solution_json = secret;
      },
      "COVERAGE_INVALID_RESPONSE",
    ],
    [
      "failed batch",
      (p) => {
        p.result[0].success = false;
      },
      "COVERAGE_D1_FAILED",
    ],
    [
      "failed response",
      (p) => {
        p.success = false;
        p.errors = [secret];
      },
      "COVERAGE_D1_FAILED",
    ],
  ];
  for (const [name, change, code] of changes)
    await t.test(name, async () => {
      await assert.rejects(harness(change).run(), (error) => {
        assert.equal(error.message, code);
        assert.equal(error.message.includes(secret), false);
        return true;
      });
    });
});

test("range, horizon and binding errors are rejected before any request", async (t) => {
  for (const patch of [
    { through: "2026-11-31" },
    { through: "2026-10-16" },
    { from: "2026-10-18" },
    { from: "2025-01-01" },
    { through: "2026-12-01" },
    { minimumFutureDays: -1 },
    { requireLocalizations: "yes" },
  ])
    await t.test(JSON.stringify(patch), async () => {
      const h = harness();
      await assert.rejects(h.run({ ...options, ...patch }), /COVERAGE_(?:INVALID|INSUFFICIENT)_/);
      assert.equal(h.requests.length, 0);
    });
  for (const name of Object.keys(env)) {
    const h = harness();
    await assert.rejects(h.run(options, { ...env, [name]: "" }), /COVERAGE_INVALID_BINDINGS/);
    assert.equal(h.requests.length, 0);
  }
});

test("HTTP, JSON and transport failures cannot expose upstream response text or credentials", async (t) => {
  for (const [name, override, code] of [
    ["HTTP", () => new Response(secret, { status: 403 }), "COVERAGE_HTTP_FAILED"],
    ["JSON", () => new Response(secret), "COVERAGE_JSON_FAILED"],
    [
      "network",
      () => {
        throw new Error(`${secret} ${env.CLOUDFLARE_API_TOKEN}`);
      },
      "COVERAGE_TRANSPORT_FAILED",
    ],
  ])
    await t.test(name, async () => {
      await assert.rejects(harness(undefined, override).run(), (error) => {
        assert.equal(error.message, code);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(env.CLOUDFLARE_API_TOKEN), false);
        return true;
      });
    });
});

test("the real D1 query detects retired puzzles, missing solutions and incomplete translations", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of ["0001_initial", "0003_content_localizations"]) {
      db.exec(
        await readFile(new URL(`../../apps/api/migrations/${name}.sql`, import.meta.url), "utf8"),
      );
    }
    const digest = "a".repeat(64);
    for (const [index, date] of ["2026-10-17", "2026-10-18"].entries()) {
      const id = `c${index}`;
      const puzzle = `p${index}`;
      db.prepare(`INSERT INTO daily_cases(id,case_date,slug,title,status,published_at,created_at,updated_at)
        VALUES (?,?,?,?,'published',1,1,1)`).run(id, date, id, secret);
      db.prepare(`INSERT INTO puzzles(id,content_key,version,content_digest,status,public_json,provenance,license,created_at,updated_at)
        VALUES (?,?,1,?,'published',?,'Synthetic','CC0',1,1)`).run(
        puzzle,
        puzzle,
        digest,
        JSON.stringify({ title: secret }),
      );
      db.prepare(
        "INSERT INTO daily_case_puzzles(case_id,puzzle_id,position,act_json) VALUES (?,?,1,'{}')",
      ).run(id, puzzle);
      db.prepare(`INSERT INTO puzzle_solutions(id,puzzle_id,solution_key,solution_json,contradiction_json,sort_order)
        VALUES (?,?,?,?,'{}',1)`).run(
        puzzle,
        puzzle,
        puzzle,
        JSON.stringify({ explanation: secret }),
      );
      for (const locale of ["ru", "zh"]) {
        db.prepare("INSERT INTO case_localizations VALUES (?,?,?,?,?)").run(
          id,
          locale,
          secret,
          digest,
          digest,
        );
        db.prepare("INSERT INTO puzzle_localizations VALUES (?,?,?,?,?,?)").run(
          puzzle,
          locale,
          "{}",
          JSON.stringify({ explanation: secret }),
          digest,
          digest,
        );
      }
    }
    const run = () =>
      checkContentCoverage(
        { through: "2026-10-18", requireLocalizations: true },
        {
          env,
          now,
          fetch: async (_url, init) => {
            const { batch } = JSON.parse(init.body);
            const results = db.prepare(batch[0].sql).all(...batch[0].params);
            assert.equal(JSON.stringify(results).includes(secret), false);
            return new Response(
              JSON.stringify({ success: true, result: [{ success: true, results }] }),
            );
          },
        },
      );
    assert.equal((await run()).puzzles, 2);
    db.exec("UPDATE puzzles SET status = 'retired' WHERE id = 'p1'");
    await assert.rejects(run(), /COVERAGE_UNPLAYABLE_DAY/);
    db.exec("UPDATE puzzles SET status = 'published' WHERE id = 'p1'");
    db.exec("DELETE FROM puzzle_localizations WHERE puzzle_id = 'p1' AND locale = 'zh'");
    await assert.rejects(run(), /COVERAGE_MISSING_LOCALIZATIONS/);
    db.exec("DELETE FROM puzzle_solutions WHERE puzzle_id = 'p1'");
    await assert.rejects(run(), /COVERAGE_UNPLAYABLE_DAY/);
    db.exec("UPDATE daily_cases SET status = 'retired' WHERE id = 'c1'");
    await assert.rejects(run(), /COVERAGE_MISSING_DATES/);
  } finally {
    db.close();
  }
});
