import assert from "node:assert/strict";
import test from "node:test";
import { runLocalizedCli } from "../scripts/check-localized-production-play.mjs";
import { checkProductionPlay, runCli } from "../scripts/check-production-play.mjs";

const env = {
  CLOUDFLARE_API_TOKEN: "private_cloudflare_token",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  API_ORIGIN: "https://api.example.test",
};
const token = "t".repeat(43);
const secret = "PRIVATE_SOLUTION_MUST_NOT_BE_PRINTED";
const date = "2026-10-15";
const attemptUuid = "22222222-2222-4222-8222-222222222222";
function solution() {
  return {
    retraction: {
      currentSquare: "f3",
      previousSquare: "g1",
      movedPiece: { color: "w", type: "n" },
      restoredPiece: null,
      special: "normal",
    },
    previousFen: secret,
    forwardSan: "Nf3",
    explanation: secret,
    historyConstraints: [],
  };
}
function daily(solved = false, count = 2) {
  return {
    id: "synthetic-case",
    date,
    title: "Synthetic",
    puzzles: Array.from({ length: count }, (_, i) => ({
      id: `p-synthetic-case-${i + 1}-v1`,
      version: 1,
      title: "Synthetic",
      prompt: solved && i === 0 ? "Synthetic unlocked conditions" : "Reconstruct the last move.",
      postFen: "synthetic-fen",
      retractingColor: "w",
      maxHints: 2,
      provenance: "Synthetic fixture",
      license: "Test fixture only",
    })),
    solvedPuzzleIds: solved ? ["p-synthetic-case-1-v1"] : [],
  };
}
function expectedStats(attempts = 0, count = 2) {
  const completed = attempts && count === 1 ? 1 : 0;
  return {
    attempts,
    hintsUsed: 0,
    solvedPuzzles: attempts ? 1 : 0,
    completedCases: completed,
    currentStreak: completed,
    bestStreak: completed,
    lastCompletedDate: completed ? date : null,
  };
}
function harness({ override, count = 2 } = {}) {
  const requests = [];
  let attempts = 0;
  let submissions = 0;
  const deps = {
    now: () => new Date(`${date}T12:00:00Z`),
    uuid: () => attemptUuid,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const isD1 = new URL(url).hostname === "api.cloudflare.com";
      const request = { url, path, isD1, ...options };
      requests.push(request);
      let status = 200;
      let payload;
      const headers = {
        "access-control-allow-origin": "https://agent-axiom.github.io",
        "cache-control": "no-store",
      };
      if (isD1)
        payload = {
          success: true,
          result: [
            {
              success: true,
              results: [
                {
                  case_id: "synthetic-case",
                  puzzle_id: "p-synthetic-case-1-v1",
                  solution_json: JSON.stringify(solution()),
                },
              ],
            },
          ],
        };
      else if (path === "/v1/sessions/guest") {
        status = 201;
        payload = { kind: "guest", token, expiresAt: "2027-01-01T00:00:00Z" };
      } else if (path === "/v1/me") payload = { kind: "guest", profile: null };
      else if (path === "/v1/daily") payload = daily(attempts > 0, count);
      else if (path === "/v1/me/stats") {
        payload = expectedStats(attempts, count);
        if (options.headers["x-game-progress"] === "1") payload.points = attempts ? 100 : 0;
      } else if (path.endsWith("/reveal")) {
        status = attempts ? 200 : 404;
        payload = attempts
          ? { reveal: solution() }
          : { error: { code: "REVEAL_NOT_FOUND", message: "No solved puzzle review is available.", requestId: "review-check" } };
      }
      else if (path === "/v1/attempts") {
        status = submissions++ === 0 ? 201 : 200;
        attempts = 1;
        if (status === 200) headers["idempotency-replayed"] = "true";
        payload = {
          id: "33333333-3333-4333-8333-333333333333",
          attemptUuid,
          correct: true,
          reveal: solution(),
        };
      } else throw new Error("Unexpected request");
      return override
        ? override(request, payload, status, headers)
        : new Response(JSON.stringify(payload), { status, headers });
    },
  };
  return { requests, deps, run: (bindings = env) => checkProductionPlay(bindings, deps) };
}
function assertSafe(value) {
  const text = JSON.stringify(value);
  for (const privateValue of [
    token,
    secret,
    attemptUuid,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.D1_DATABASE_ID,
    "synthetic-puzzle",
    "previousFen",
    "retraction",
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
}

test("synthetic guest solve and replay preserve progress without private output", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    date,
    puzzlesSolved: 1,
    attempts: 1,
    idempotencyVerified: true,
    earnedReviewVerified: true,
  });
  assertSafe(result);
  assert.equal(check.requests.length, 13);
  const d1 = check.requests.find((r) => r.isD1);
  const query = JSON.parse(d1.body);
  assert.match(query.sql, /^SELECT /);
  assert.match(query.sql, /cp.position = 1 AND s.sort_order = 1/);
  assert.match(query.sql, /LIMIT 1$/);
  assert.match(query.sql, /cp.position \|\| '-v' \|\| p.version/);
  assert.doesNotMatch(query.sql, /p.content_key AS puzzle_id/);
  assert.doesNotMatch(
    query.sql,
    /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|PRAGMA|players|sessions|attempts)\b|;/i,
  );
  assert.deepEqual(query.params, [date]);
  const posts = check.requests.filter((r) => r.path === "/v1/attempts");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);
  assert.deepEqual(JSON.parse(posts[0].body).retraction, solution().retraction);
  assert.equal(JSON.parse(posts[0].body).puzzleId, "p-synthetic-case-1-v1");
  const reviews = check.requests.filter((request) => request.path.endsWith("/reveal"));
  assert.equal(reviews.length, 2);
  assert.ok(check.requests.indexOf(reviews[0]) < check.requests.indexOf(d1));
  assert.ok(check.requests.indexOf(reviews[1]) > check.requests.indexOf(posts[0]));
  for (const review of reviews) {
    assert.equal(review.method, "GET");
    assert.equal(review.body, undefined);
    assert.equal(review.path, "/v1/cases/synthetic-case/puzzles/p-synthetic-case-1-v1/reveal");
  }
  assert.equal(check.requests.filter((request) => request.path === "/v1/me/stats" && request.headers["x-game-progress"] === "1").length, 2);
  for (const request of check.requests) {
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    if (request.isD1) {
      assert.equal(request.headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    } else if (request.path !== "/v1/sessions/guest") {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
    }
    assert.equal(request.url.includes(token), false);
  }
});
test("a one-puzzle case also verifies completion and streak statistics", async () => {
  assert.equal((await harness({ count: 1 }).run()).ok, true);
});

test("earned-review proof rejects premature access, missing routes, private leakage and changed solutions", async (t) => {
  const cases = [
    [
      "premature solution",
      (request, payload, status) => {
        if (request.path.endsWith("/reveal") && status === 404)
          return { status: 200, payload: { reveal: solution() } };
      },
      "API_HTTP_FAILED",
      true,
    ],
    [
      "old deployment has no review route",
      (request, payload, status) => {
        if (request.path.endsWith("/reveal") && status === 404) payload.error.code = "NOT_FOUND";
      },
      "UNSOLVED_REVIEW_FAILED",
      true,
    ],
    [
      "private answer in denied response",
      (request, payload, status) => {
        if (request.path.endsWith("/reveal") && status === 404) payload.reveal = solution();
      },
      "UNSOLVED_REVIEW_FAILED",
      true,
    ],
    [
      "changed earned explanation",
      (request, payload, status) => {
        if (request.path.endsWith("/reveal") && status === 200) payload.reveal.explanation = "wrong";
      },
      "EARNED_REVIEW_FAILED",
      false,
    ],
    [
      "unearned extra solutions",
      (request, payload, status) => {
        if (request.path.endsWith("/reveal") && status === 200) payload.acceptedSolutions = [solution()];
      },
      "EARNED_REVIEW_FAILED",
      false,
    ],
    [
      "cacheable earned response",
      (request, _payload, status, headers) => {
        if (request.path.endsWith("/reveal") && status === 200) delete headers["cache-control"];
      },
      "EARNED_REVIEW_FAILED",
      false,
    ],
    [
      "missing rating snapshot",
      (request, payload) => {
        if (request.path === "/v1/me/stats") delete payload.points;
      },
      "GUEST_STATS_FAILED",
      false,
    ],
  ];
  for (const [name, mutate, code, failsBeforePrivateRead] of cases) {
    await t.test(name, async () => {
      const output = [];
      const check = harness({
        override: (request, payload, status, headers) => {
          const changed = mutate(request, payload, status, headers);
          return new Response(JSON.stringify(changed?.payload ?? payload), {
            status: changed?.status ?? status, headers,
          });
        },
      });
      assert.equal(await runCli([], env, {
        ...check.deps, log: (value) => output.push(value), errorLog: (value) => output.push(value),
      }), 1);
      assert.deepEqual(output.map((value) => JSON.parse(value)), [{ ok: false, code }]);
      assertSafe(output);
      if (failsBeforePrivateRead) {
        assert.equal(check.requests.some((request) => request.isD1), false);
        assert.equal(check.requests.some((request) => request.path === "/v1/attempts"), false);
      }
    });
  }
});

test("earned-review proof detects attempts or points changing during a GET", async (t) => {
  for (const [field, code] of [["attempts", "GUEST_STATS_FAILED"], ["points", "EARNED_REVIEW_STATS_CHANGED"]]) {
    await t.test(field, async () => {
      let reviewed = false;
      const output = [];
      const check = harness({
        override: (request, payload, status, headers) => {
          if (request.path.endsWith("/reveal") && status === 200) reviewed = true;
          if (reviewed && request.path === "/v1/me/stats") payload[field] += 1;
          return new Response(JSON.stringify(payload), { status, headers });
        },
      });
      assert.equal(await runCli([], env, {
        ...check.deps, log: (value) => output.push(value), errorLog: (value) => output.push(value),
      }), 1);
      assert.deepEqual(output.map((value) => JSON.parse(value)), [{ ok: false, code }]);
      assertSafe(output);
    });
  }
});
test("bindings and destinations are rejected before creating a guest", async (t) => {
  for (const patch of [
    { API_ORIGIN: "http://api.example.test" },
    { API_ORIGIN: "https://user:secret@api.test" },
    { API_ORIGIN: "https://api.test/path" },
    { CLOUDFLARE_API_TOKEN: "" },
    { CLOUDFLARE_ACCOUNT_ID: secret },
    { D1_DATABASE_ID: secret },
  ]) {
    await t.test(Object.keys(patch)[0], async () => {
      const check = harness();
      await assert.rejects(check.run({ ...env, ...patch }));
      assert.equal(check.requests.length, 0);
    });
  }
});
test("upstream errors, daily leakage and replay regressions have safe failures", async (t) => {
  const cases = [
    [
      "transport",
      () => {
        throw new Error(`${secret} ${token}`);
      },
      "API_TRANSPORT_FAILED",
    ],
    ["HTTP", () => new Response(secret, { status: 500 }), "API_HTTP_FAILED"],
    [
      "JSON",
      (_request, _payload, status, headers) => new Response(secret, { status, headers }),
      "API_INVALID_JSON",
    ],
    [
      "private daily",
      (r, p, status, headers) => {
        if (r.path === "/v1/daily") p.puzzles[0].acceptedSolutions = [solution()];
        return new Response(JSON.stringify(p), { status, headers });
      },
      "PUBLIC_DAILY_FAILED",
    ],
    [
      "D1 failure",
      (r, p, status, headers) => {
        if (r.isD1) p = { success: false, errors: [secret] };
        return new Response(JSON.stringify(p), { status, headers });
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "wrong reveal",
      (r, p, status, headers) => {
        if (r.path === "/v1/attempts") p.reveal.explanation = "wrong";
        return new Response(JSON.stringify(p), { status, headers });
      },
      "CORRECT_ATTEMPT_FAILED",
    ],
    [
      "replay duplicates stats",
      (r, p, status, headers) => {
        if (r.path === "/v1/me/stats" && p.attempts === 1) p.attempts = 2;
        return new Response(JSON.stringify(p), { status, headers });
      },
      "GUEST_STATS_FAILED",
    ],
    [
      "replay header",
      (r, p, status, headers) => {
        if (r.path === "/v1/attempts" && status === 200) delete headers["idempotency-replayed"];
        return new Response(JSON.stringify(p), { status, headers });
      },
      "IDEMPOTENCY_FAILED",
    ],
  ];
  for (const [name, override, code] of cases) {
    await t.test(name, async () => {
      const output = [];
      const check = harness({ override });
      const status = await runCli([], env, {
        ...check.deps,
        log: (v) => output.push(v),
        errorLog: (v) => output.push(v),
      });
      assert.equal(status, 1);
      assert.equal(output.length, 1);
      assert.deepEqual(JSON.parse(output[0]), { ok: false, code });
      assertSafe(output[0]);
      if (name === "private daily")
        assert.equal(
          check.requests.some((r) => r.isD1),
          false,
        );
    });
  }
});

function localizationMap(fields) {
  return Object.fromEntries(
    ["ru", "zh"].map((locale) => [
      locale,
      Object.fromEntries(fields.map((field) => [field, `${locale} ${secret}`])),
    ]),
  );
}

function localizedHarness({ override } = {}) {
  const requests = [];
  let attempts = 0;
  let hints = 0;
  let solved = false;
  let correctPosts = 0;
  let uuidIndex = 0;
  const deps = {
    now: () => new Date(`${date}T12:00:00Z`),
    uuid: () => (uuidIndex++ === 0 ? "11111111-1111-4111-8111-111111111111" : attemptUuid),
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      const isD1 = new URL(url).hostname === "api.cloudflare.com";
      const request = { url, path, isD1, ...options };
      requests.push(request);
      const localized = options.headers["x-content-locales"] === "1";
      const headers = {
        "access-control-allow-origin": "https://agent-axiom.github.io",
        "cache-control": "no-store",
      };
      let status = 200;
      let payload;
      if (isD1)
        payload = {
          success: true,
          result: [
            {
              success: true,
              results: [
                {
                  case_id: "synthetic-case",
                  puzzle_id: "p-synthetic-case-1-v1",
                  solution_json: JSON.stringify(solution()),
                },
              ],
            },
          ],
        };
      else if (path === "/v1/sessions/guest") {
        status = 201;
        payload = { kind: "guest", token, expiresAt: "2027-01-01T00:00:00Z" };
      } else if (path === "/v1/me") payload = { kind: "guest", profile: null };
      else if (path === "/v1/daily") {
        payload = daily(solved);
        if (localized) {
          payload.localizations = localizationMap(["title"]);
          for (const puzzle of payload.puzzles) {
            puzzle.localizations = localizationMap(["title", "prompt", "provenance", "license"]);
            if (!solved || puzzle.id !== "p-synthetic-case-1-v1") {
              puzzle.localizations.ru.prompt = "Восстановите последний ход.";
              puzzle.localizations.zh.prompt = "还原上一步棋。";
            }
          }
        }
      } else if (path === "/v1/me/stats") {
        payload = { ...expectedStats(solved ? 1 : 0), attempts, hintsUsed: hints };
        if (options.headers["x-game-progress"] === "1") payload.points = solved ? 35 : 0;
      } else if (path.endsWith("/reveal")) {
        status = solved ? 200 : 404;
        payload = solved
          ? { reveal: solution() }
          : { error: { code: "REVEAL_NOT_FOUND", message: "No solved puzzle review is available.", requestId: "review-check" } };
        if (solved && localized) payload.reveal.localizations = localizationMap(["explanation"]);
      } else if (path.endsWith("/hints")) {
        hints = 1;
        payload = {
          level: 1,
          text: secret,
          exhausted: false,
          localizations: localizationMap(["text"]),
        };
      } else if (path === "/v1/attempts") {
        const body = JSON.parse(options.body);
        if (body.retraction.movedPiece.color === "b") {
          attempts += 1;
          status = 201;
          payload = {
            id: "44444444-4444-4444-8444-444444444444",
            attemptUuid: body.attemptUuid,
            correct: false,
            contradiction: {
              code: "WRONG_COLOR",
              message: "Wrong color",
              localizations: localizationMap(["message"]),
            },
          };
        } else {
          status = correctPosts++ === 0 ? 201 : 200;
          if (status === 201) attempts += 1;
          else headers["idempotency-replayed"] = "true";
          solved = true;
          payload = {
            id: "33333333-3333-4333-8333-333333333333",
            attemptUuid,
            correct: true,
            reveal: solution(),
          };
          if (localized) payload.reveal.localizations = localizationMap(["explanation"]);
        }
      } else throw new Error(secret);
      return override
        ? override(request, payload, status, headers)
        : new Response(JSON.stringify(payload), { status, headers });
    },
  };
  return {
    requests,
    deps,
    run: () => checkProductionPlay({ ...env, CHECK_LOCALIZATIONS: "true" }, deps),
  };
}

test("localized production flow earns one hint and replays the same correct attempt with English compatibility", async () => {
  const check = localizedHarness();
  const result = await check.run();
  assert.deepEqual(result, {
    ok: true,
    date,
    puzzlesSolved: 1,
    attempts: 2,
    hintsUsed: 1,
    locales: ["ru", "zh"],
    englishCompatible: true,
    idempotencyVerified: true,
    earnedReviewVerified: true,
  });
  assertSafe(result);
  const posts = check.requests.filter((request) => request.path === "/v1/attempts");
  assert.equal(posts.length, 4);
  assert.equal(JSON.parse(posts[0].body).retraction.movedPiece.color, "b");
  assert.equal(posts[1].body, posts[2].body);
  assert.equal(posts[2].body, posts[3].body);
  assert.equal(posts[2].headers["x-content-locales"], undefined);
  assert.equal(posts[1].headers["x-content-locales"], "1");
  assert.equal(posts[3].headers["x-content-locales"], "1");
  assert.equal(check.requests.filter((request) => request.path.endsWith("/hints")).length, 1);
});

test("localized private flow rejects leaks, missing translations and replay drift without printing payloads", async (t) => {
  const cases = [
    [
      "daily leak",
      (r, p) => {
        if (r.path === "/v1/daily") p.localizations.ru.hints = [secret];
      },
      "PUBLIC_DAILY_FAILED",
    ],
    [
      "early reveal",
      (r, p) => {
        if (r.path === "/v1/attempts" && p.correct === false) p.reveal = solution();
      },
      "LOCALIZED_CONTRADICTION_FAILED",
    ],
    [
      "missing hint language",
      (r, p) => {
        if (r.path.endsWith("/hints")) delete p.localizations.zh;
      },
      "LOCALIZED_HINT_FAILED",
    ],
    [
      "hint secret field",
      (r, p) => {
        if (r.path.endsWith("/hints")) p.localizations.ru.explanation = secret;
      },
      "LOCALIZED_HINT_FAILED",
    ],
    [
      "missing reveal language",
      (r, p) => {
        if (p.correct === true && p.reveal.localizations) delete p.reveal.localizations.zh;
      },
      "CORRECT_ATTEMPT_FAILED",
    ],
    [
      "earned review missing language",
      (r, p, status) => {
        if (r.path.endsWith("/reveal") && status === 200) delete p.reveal.localizations.zh;
      },
      "EARNED_REVIEW_FAILED",
    ],
    [
      "earned review translation drift",
      (r, p, status) => {
        if (r.path.endsWith("/reveal") && status === 200) p.reveal.localizations.ru.explanation = "wrong";
      },
      "EARNED_REVIEW_FAILED",
    ],
    [
      "English replay changed",
      (r, p, status) => {
        if (r.path === "/v1/attempts" && status === 200 && !r.headers["x-content-locales"])
          p.reveal.explanation = "changed";
      },
      "ENGLISH_REPLAY_FAILED",
    ],
    [
      "localized replay changed",
      (r, p, status) => {
        if (r.path === "/v1/attempts" && status === 200 && r.headers["x-content-locales"])
          p.reveal.localizations.zh.explanation = "changed";
      },
      "IDEMPOTENCY_FAILED",
    ],
    [
      "replay duplicate stats",
      (r, p) => {
        if (r.path === "/v1/me/stats" && p.attempts === 2) p.attempts = 3;
      },
      "GUEST_STATS_FAILED",
    ],
  ];
  for (const [name, mutate, code] of cases)
    await t.test(name, async () => {
      const output = [];
      const check = localizedHarness({
        override: (request, payload, status, headers) => {
          mutate(request, payload, status);
          return new Response(JSON.stringify(payload), { status, headers });
        },
      });
      assert.equal(
        await runCli(
          [],
          { ...env, CHECK_LOCALIZATIONS: "true" },
          {
            ...check.deps,
            log: (value) => output.push(value),
            errorLog: (value) => output.push(value),
          },
        ),
        1,
      );
      assert.deepEqual(JSON.parse(output[0]), { ok: false, code });
      assertSafe(output);
    });
});

test("localized wrapper skips bootstrap and unrelated imports before any credentialed request", async () => {
  for (const [purpose, envelope] of [
    ["launch", true],
    ["archive", true],
    ["localization", false],
  ]) {
    const output = [];
    let requests = 0;
    const status = await runLocalizedCli(
      [],
      {},
      {
        readFile: async () => JSON.stringify({ purpose }),
        access: async () => {
          if (!envelope) throw Object.assign(new Error(secret), { code: "ENOENT" });
        },
        fetch: async () => {
          requests += 1;
          throw new Error(secret);
        },
        log: (value) => output.push(value),
        errorLog: (value) => output.push(value),
      },
    );
    assert.equal(status, 0);
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(output[0]), {
      skipped: true,
      reason: "NO_LOCALIZATION_PUBLICATION",
    });
    assertSafe(output);
  }
});

test("localized wrapper explicitly enables the private flow after a localization publication", async () => {
  const check = localizedHarness();
  const output = [];
  const status = await runLocalizedCli([], env, {
    ...check.deps,
    readFile: async () => JSON.stringify({ purpose: "localization" }),
    access: async () => {},
    log: (value) => output.push(value),
    errorLog: (value) => output.push(value),
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output[0]).hintsUsed, 1);
  assert.deepEqual(JSON.parse(output[0]).locales, ["ru", "zh"]);
  assertSafe(output);
});

test("localized wrapper masks private configuration parse failures before any requests", async () => {
  const output = [];
  let requests = 0;
  const status = await runLocalizedCli([], env, {
    readFile: async () => secret,
    fetch: async () => {
      requests += 1;
      throw new Error(secret);
    },
    log: (value) => output.push(value),
    errorLog: (value) => output.push(value),
  });
  assert.equal(status, 1);
  assert.equal(requests, 0);
  assert.deepEqual(JSON.parse(output[0]), { ok: false, code: "LOCALIZED_PLAY_CHECK_FAILED" });
  assertSafe(output);
});

test("solving unlocks title and conditions while neutral puzzle aliases remain stable", async () => {
  const check = harness({
    override: (request, payload, status, headers) => {
      if (request.path === "/v1/daily" && payload.solvedPuzzleIds.length > 0) {
        payload.title = "Unlocked case title";
        payload.puzzles[0].title = "Unlocked composition title";
        payload.puzzles[0].prompt = "Unlocked composition conditions";
      }
      return new Response(JSON.stringify(payload), { status, headers });
    },
  });
  assert.equal((await check.run()).ok, true);
});

test("unlocking cannot change identity, board or metadata", async (t) => {
  for (const [field, value] of [
    ["id", "thematic-source-id"],
    ["postFen", secret],
    ["provenance", secret],
  ]) {
    await t.test(field, async () => {
      const check = harness({
        override: (request, payload, status, headers) => {
          if (request.path === "/v1/daily" && payload.solvedPuzzleIds.length > 0) {
            payload.puzzles[0][field] = value;
          }
          return new Response(JSON.stringify(payload), { status, headers });
        },
      });
      await assert.rejects(check.run(), { message: "RELOADED_DAILY_FAILED" });
    });
  }
});

test("localized title and conditions unlock together", async () => {
  const check = localizedHarness({
    override: (request, payload, status, headers) => {
      if (request.path === "/v1/daily" && payload.solvedPuzzleIds.length > 0) {
        payload.puzzles[0].localizations.ru.title = "Раскрытая композиция";
        payload.puzzles[0].localizations.zh.title = "已揭晓的棋题";
        payload.puzzles[0].localizations.ru.prompt = "Раскрытые условия";
        payload.puzzles[0].localizations.zh.prompt = "已揭示的条件";
      }
      return new Response(JSON.stringify(payload), { status, headers });
    },
  });
  assert.equal((await check.run()).ok, true);
});

test("solving one puzzle cannot unlock another puzzle's conditions", async () => {
  const check = harness({
    override: (request, payload, status, headers) => {
      if (request.path === "/v1/daily" && payload.solvedPuzzleIds.length > 0)
        payload.puzzles[1].prompt = "Unrelated private conditions";
      return new Response(JSON.stringify(payload), { status, headers });
    },
  });
  await assert.rejects(check.run(), { message: "RELOADED_DAILY_FAILED" });
});
