import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalizationsCoverage } from "../scripts/check-localizations-production.mjs";

const options = {
  apiOrigin: "https://api.example.test", webOrigin: "https://game.example.test",
  from: "2026-09-10", through: "2026-09-11",
};
const secret = "PRIVATE_RESPONSE_MUST_STAY_PRIVATE";
const token = "a".repeat(43);
const now = () => new Date("2026-10-15T12:00:00Z");
const titles = { ru: { title: "Шахматная загадка" }, zh: { title: "国际象棋谜题" } };
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "localizations").map(([key, child]) => [key, strip(child)]));
  return value;
}
function harness(mutate = () => {}, override) {
  const cases = ["2026-09-11", "2026-09-10"].map((date) => ({
    id: `case-${date}`, date, slug: `case-${date}`, title: "A synthetic case",
    puzzleCount: 1, solvedPuzzles: 0, completed: false, localizations: structuredClone(titles),
  }));
  const localized = {
    "/v1/archive": { today: "2026-10-15", startsOn: "2026-09-10", cases },
  };
  for (const item of cases) localized[`/v1/daily?date=${item.date}`] = {
    id: item.id, date: item.date, title: item.title, solvedPuzzleIds: [],
    localizations: structuredClone(titles),
    puzzles: [{
      id: "synthetic", version: 1, title: "A synthetic puzzle", prompt: "Find the move.",
      postFen: "8/8/8/8/8/8/8/K6k w - - 0 1", retractingColor: "b", maxHints: 0,
      provenance: "Synthetic diagnostic fixture", license: "CC0-1.0",
      localizations: {
        ru: { title: "Шахматная загадка", prompt: "Восстановите последний ход.",
          provenance: "Учебный пример", license: "CC0-1.0" },
        zh: { title: "国际象棋谜题", prompt: "还原最后一步。", provenance: "教学示例", license: "CC0-1.0" },
      },
    }],
  };
  const english = strip(structuredClone(localized));
  mutate(localized, english);
  const requests = [];
  return {
    requests,
    run: (input = options) => checkLocalizationsCoverage(input, {
      now,
      fetch: async (url, init) => {
        const path = new URL(url).pathname + new URL(url).search;
        requests.push({ path, ...init });
        const body = path === "/v1/sessions/guest"
          ? { kind: "guest", token, expiresAt: "2026-10-16T00:00:00Z" }
          : (init.headers["x-content-locales"] ? localized : english)[path];
        const response = new Response(JSON.stringify(body), {
          status: init.method === "POST" ? 201 : 200,
          headers: { "access-control-allow-origin": options.webOrigin, "cache-control": "no-store" },
        });
        return override ? override(path, response) : response;
      },
    }),
  };
}

test("localization publication checks all public dates, opt-in maps and old English responses", async () => {
  const check = harness();
  assert.deepEqual(await check.run(), {
    ok: true, from: options.from, through: options.through, cases: 2, puzzles: 2,
    locales: ["ru", "zh"], englishCompatible: true,
  });
  assert.equal(check.requests.length, 7);
  assert.equal(check.requests.filter((item) => item.headers["x-content-locales"] === "1").length, 3);
  for (const request of check.requests) {
    assert.equal(request.headers.authorization,
      request.method === "POST" ? undefined : `Bearer ${token}`);
    assert.equal(request.path.startsWith("/v1/attempts"), false);
    assert.equal(request.headers.origin, options.webOrigin);
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
  }
});

test("localization publication rejects unknown language, incomplete maps, nested answers and English drift", async (t) => {
  const changes = [
    ["missing Chinese", (p) => { delete p["/v1/archive"].cases[0].localizations.zh; }, "LOCALES_TRANSLATIONS_FAILED"],
    ["unexpected locale", (p) => { p["/v1/archive"].cases[0].localizations.de = { title: "DE" }; }, "LOCALES_TRANSLATIONS_FAILED"],
    ["untranslated prompt", (p) => { p["/v1/daily?date=2026-09-10"].puzzles[0].localizations.ru.prompt = "Find the move."; }, "LOCALES_TRANSLATIONS_FAILED"],
    ["blank license", (p) => { p["/v1/daily?date=2026-09-10"].puzzles[0].localizations.zh.license = " "; }, "LOCALES_TRANSLATIONS_FAILED"],
    ["nested private answer", (p) => { p["/v1/daily?date=2026-09-10"].puzzles[0].localizations.ru.explanation = secret; }, "LOCALES_PRIVATE_FIELDS"],
    ["catalog private hint", (p) => { p["/v1/archive"].cases[0].localizations.zh.hints = [secret]; }, "LOCALES_PRIVATE_FIELDS"],
    ["English response drift", (_p, en) => { en["/v1/archive"].cases[0].title = "Changed title"; }, "LOCALES_ENGLISH_COMPATIBILITY_FAILED"],
    ["English client gets locales", (p, en) => { en["/v1/archive"].cases[0].localizations = p["/v1/archive"].cases[0].localizations; }, "LOCALES_ENGLISH_COMPATIBILITY_FAILED"],
    ["missing date", (p, en) => { p["/v1/archive"].cases.shift(); en["/v1/archive"].cases.shift(); }, "LOCALES_MISSING_DATES"],
    ["future date", (p) => { p["/v1/archive"].cases[0].date = "2026-10-16"; }, "LOCALES_CATALOG_FAILED"],
  ];
  for (const [name, change, code] of changes) await t.test(name, async () => {
    await assert.rejects(harness(change).run, (error) => {
      assert.equal(error.message, code);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(token), false);
      return true;
    });
  });
});

test("range and origin validation happens before session creation", async (t) => {
  for (const patch of [
    { from: "2026-09-31" }, { through: "2026-10-16" }, { from: "2026-09-12" },
    { from: "2024-01-01" }, { apiOrigin: "https://api.example.test/path" },
  ]) await t.test(JSON.stringify(patch), async () => {
    const check = harness();
    await assert.rejects(() => check.run({ ...options, ...patch }));
    assert.equal(check.requests.length, 0);
  });
});

test("network failures produce fixed diagnostics without returning response bodies", async (t) => {
  for (const [name, override, code] of [
    ["transport", () => { throw new Error(secret); }, "LOCALES_TRANSPORT_FAILED"],
    ["JSON", (_path, response) => ({ status: response.status, headers: response.headers,
      json: () => { throw new Error(secret); } }), "LOCALES_JSON_FAILED"],
    ["CORS", (_path, response) => { response.headers.delete("access-control-allow-origin"); return response; }, "LOCALES_CORS_FAILED"],
    ["cache", (_path, response) => { response.headers.set("cache-control", "public"); return response; }, "LOCALES_CACHE_FAILED"],
    ["HTTP", (_path, response) => new Response(secret, { status: 500, headers: response.headers }), "LOCALES_HTTP_FAILED"],
  ]) await t.test(name, async () => {
    await assert.rejects(harness(undefined, override).run, { message: code });
  });
});
