import assert from "node:assert/strict";
import test from "node:test";
import { checkProductionScoring, runCli } from "../scripts/check-scoring-production.mjs";

const env = {
  CLOUDFLARE_API_TOKEN: "private_scoring_cloudflare_token",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  API_ORIGIN: "https://api.example.test",
};
const date = "2026-10-15";
const secret = "PRIVATE_SCORING_SOLUTION_NEVER_LOG";
const caseId = "synthetic-case";
const puzzleId = `p-${caseId}-1-v1`;
const webOrigin = "https://chess.kosarevsky.dev";
const numberedUuid = (n) => `${String(n).padStart(8, "0")}-2222-4222-8222-222222222222`;
const localeMap = (fields) =>
  Object.fromEntries(
    ["ru", "zh"].map((locale) => [
      locale,
      Object.fromEntries(fields.map((field) => [field, `${locale}-${field}-${secret}`])),
    ]),
  );
const originalSolution = () => ({
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
});
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness({ count = 2, mutate, transport } = {}) {
  const requests = [];
  const actors = [];
  let uuidIndex = 0;
  let storedIdIndex = 100;
  function stateProgress(actor) {
    return {
      attemptCount: actor.solved ? actor.solveOrdinal : actor.attempts,
      assistanceCount: actor.clue ? 1 : 0,
      clueUnlocked: actor.clue,
      highestHintLevel: 0,
      earnedPoints: actor.solved ? actor.points : null,
      nextAttemptPoints: actor.solved ? 0 : actor.attempts === 0 ? 100 : actor.clue ? 35 : 70,
      legacySolved: false,
      awardAttemptId: actor.awardId,
      earnedHints: [],
    };
  }
  const zeroProgress = () => ({
    attemptCount: 0,
    assistanceCount: 0,
    clueUnlocked: false,
    highestHintLevel: 0,
    earnedPoints: null,
    nextAttemptPoints: 100,
    legacySolved: false,
    awardAttemptId: null,
    earnedHints: [],
  });
  function daily(actor) {
    return {
      id: caseId,
      date,
      title: actor.clue || actor.solved ? secret : "Daily case",
      localizations:
        actor.clue || actor.solved
          ? localeMap(["title"])
          : { ru: { title: "Задача дня" }, zh: { title: "每日棋题" } },
      puzzles: Array.from({ length: count }, (_, index) => ({
        id: `p-${caseId}-${index + 1}-v1`,
        version: 1,
        title: index === 0 && (actor.clue || actor.solved) ? secret : `Puzzle ${index + 1}`,
        prompt:
          index === 0 && (actor.clue || actor.solved)
            ? "Synthetic mandatory conditions"
            : "Reconstruct the last move.",
        postFen: "synthetic-position",
        retractingColor: "w",
        maxHints: 2,
        provenance: "Synthetic composition",
        license: "Synthetic license",
        localizations: {
          ru: {
            title:
              index === 0 && (actor.clue || actor.solved)
                ? `ru-title-${secret}`
                : `Задача ${index + 1}`,
            prompt:
              index === 0 && (actor.clue || actor.solved)
                ? "ru-prompt"
                : "Восстановите последний ход.",
            provenance: "ru-author",
            license: "ru-license",
          },
          zh: {
            title:
              index === 0 && (actor.clue || actor.solved)
                ? `zh-title-${secret}`
                : `棋题 ${index + 1}`,
            prompt: index === 0 && (actor.clue || actor.solved) ? "zh-prompt" : "还原上一步棋。",
            provenance: "zh-author",
            license: "zh-license",
          },
        },
      })),
      solvedPuzzleIds: actor.solved ? [puzzleId] : [],
      progressStates: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `p-${caseId}-${index + 1}-v1`,
          index === 0 ? stateProgress(actor) : zeroProgress(),
        ]),
      ),
    };
  }
  function stats(actor) {
    const complete = actor.solved && count === 1 ? 1 : 0;
    return {
      attempts: actor.attempts,
      hintsUsed: 0,
      solvedPuzzles: actor.solved ? 1 : 0,
      completedCases: complete,
      currentStreak: complete,
      bestStreak: complete,
      lastCompletedDate: complete ? date : null,
      points: actor.solved ? actor.points : 0,
    };
  }
  const deps = {
    now: () => new Date(`${date}T12:00:00Z`),
    uuid: () => numberedUuid(++uuidIndex),
    fetch: async (url, options) => {
      const parsed = new URL(url);
      const isD1 = parsed.hostname === "api.cloudflare.com";
      const path = parsed.pathname;
      const token = options.headers.authorization?.replace(/^Bearer /, "");
      let actor = actors.find((value) => value.token === token);
      const request = { url, isD1, path, actorIndex: actor?.index, ...options };
      requests.push(request);
      if (transport) await transport(request);
      const headers = { "access-control-allow-origin": webOrigin };
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
                  case_id: caseId,
                  puzzle_id: puzzleId,
                  prompt: "Synthetic mandatory conditions",
                  solution_json: JSON.stringify(originalSolution()),
                },
              ],
            },
          ],
        };
      else if (path === "/v1/sessions/guest") {
        status = 201;
        actor = {
          index: actors.length,
          token: String(actors.length + 1).repeat(43),
          attempts: 0,
          clue: false,
          solved: false,
          solveOrdinal: 0,
          points: null,
          awardId: null,
          attemptsByUuid: new Map(),
          clueRequests: 0,
          replays: 0,
          duplicateSolves: 0,
        };
        actors.push(actor);
        request.actorIndex = actor.index;
        payload = { kind: "guest", token: actor.token, expiresAt: "2027-01-01T00:00:00Z" };
      } else {
        assert(actor, "Mock requests must own a guest token");
        if (path === "/v1/me") payload = { kind: "guest", profile: null };
        else if (path === "/v1/daily") payload = daily(actor);
        else if (path === "/v1/me/stats") payload = stats(actor);
        else if (path === `/v1/cases/${caseId}/puzzles/${puzzleId}/clue`) {
          actor.clue = true;
          actor.clueRequests += 1;
          payload = {
            title: secret,
            prompt: "Synthetic mandatory conditions",
            localizations: {
              ru: { title: `ru-title-${secret}`, prompt: "ru-prompt" },
              zh: { title: `zh-title-${secret}`, prompt: "zh-prompt" },
            },
            progress: stateProgress(actor),
          };
        } else if (path === "/v1/attempts") {
          const body = JSON.parse(options.body);
          assert.equal(body.caseId, caseId);
          assert.equal(body.puzzleId, puzzleId);
          if (actor.attemptsByUuid.has(body.attemptUuid)) {
            actor.replays += 1;
            headers["idempotency-replayed"] = "true";
            payload = clone(actor.attemptsByUuid.get(body.attemptUuid));
          } else {
            actor.attempts += 1;
            status = 201;
            const correct = body.retraction.movedPiece.color === "w";
            const id = numberedUuid(++storedIdIndex);
            if (correct && !actor.solved) {
              actor.solved = true;
              actor.solveOrdinal = actor.attempts;
              actor.awardId = id;
              actor.points = actor.index === 0 ? 100 : 35;
            } else if (correct) actor.duplicateSolves += 1;
            payload = {
              id,
              attemptUuid: body.attemptUuid,
              correct,
              ...(correct
                ? { reveal: { ...originalSolution(), localizations: localeMap(["explanation"]) } }
                : {
                    contradiction: {
                      code: "WRONG_COLOR",
                      message: "Synthetic wrong color",
                      localizations: localeMap(["message"]),
                    },
                  }),
              progress: stateProgress(actor),
            };
            actor.attemptsByUuid.set(body.attemptUuid, clone(payload));
          }
        } else throw new Error(secret);
      }
      request.actorCount = actors.length;
      const replacement = mutate?.(request, payload, status, headers, actor);
      return replacement ?? new Response(JSON.stringify(payload), { status, headers });
    },
  };
  return {
    requests,
    actors,
    deps,
    run: (bindings = env) => checkProductionScoring(bindings, deps),
  };
}
function assertSafe(value) {
  const output = typeof value === "string" ? value : JSON.stringify(value);
  for (const text of [
    secret,
    caseId,
    puzzleId,
    "synthetic-position",
    "Nf3",
    "Synthetic mandatory conditions",
    "1".repeat(43),
    "2".repeat(43),
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.D1_DATABASE_ID,
    numberedUuid(1),
    numberedUuid(101),
  ])
    assert(!output.includes(text));
}

test("scoring checker isolates two actors, awards 100/35 and prevents replay/new-UUID farming", async () => {
  const check = harness();
  const result = await check.run();
  assert.deepEqual(result, {
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
  });
  assertSafe(result);
  assert.equal(check.actors.length, 2);
  assert.deepEqual(
    check.actors.map((actor) => actor.attempts),
    [2, 3],
  );
  assert.deepEqual(
    check.actors.map((actor) => actor.clueRequests),
    [0, 2],
  );
  assert.deepEqual(
    check.actors.map((actor) => actor.replays),
    [1, 1],
  );
  assert.deepEqual(
    check.actors.map((actor) => actor.duplicateSolves),
    [1, 1],
  );
  const api = check.requests.filter((request) => !request.isD1);
  for (const request of api) {
    assert.equal(request.headers.origin, webOrigin);
    assert.equal(request.headers["x-game-progress"], "1");
    assert.equal(request.headers["x-content-locales"], "1");
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert(request.signal instanceof AbortSignal);
  }
  const privileged = check.requests.filter((request) => request.isD1);
  assert.equal(privileged.length, 1);
  const query = JSON.parse(privileged[0].body);
  assert.deepEqual(query.params, [date]);
  assert.match(query.sql, /^SELECT\b/);
  assert.doesNotMatch(query.sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
  assert.match(query.sql, /AS puzzle_id/);
  assert.match(query.sql, /cp\.position = 1/);
  assert.equal(privileged[0].headers.authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  assert(
    api
      .filter((request) => request.path !== "/v1/sessions/guest")
      .every((request) => request.headers.authorization !== privileged[0].headers.authorization),
  );
});

test("scoring checker verifies completion stats for a one-puzzle day", async () => {
  const result = await harness({ count: 1 }).run();
  assert.deepEqual(result.points, [100, 35]);
  assertSafe(result);
});

test("scoring checker refuses malformed bindings and CLI arguments before sending credentials", async (t) => {
  const cases = [
    [[], {}, "MISSING_REQUIRED_BINDINGS"],
    [[secret], env, "UNEXPECTED_ARGUMENTS"],
    [[], { ...env, CLOUDFLARE_API_TOKEN: "bad token" }, "INVALID_CLOUDFLARE_API_TOKEN"],
    [[], { ...env, CLOUDFLARE_ACCOUNT_ID: secret }, "INVALID_CLOUDFLARE_ACCOUNT_ID"],
    [[], { ...env, D1_DATABASE_ID: secret }, "INVALID_D1_DATABASE_ID"],
    [
      [],
      { ...env, API_ORIGIN: "https://user:private@api.example.test/path" },
      "INVALID_API_ORIGIN",
    ],
    [[], { ...env, API_ORIGIN: "http://api.example.test" }, "INVALID_API_ORIGIN"],
  ];
  for (const [args, bindings, code] of cases)
    await t.test(code, async () => {
      let calls = 0;
      const output = [];
      assert.equal(
        await runCli(args, bindings, {
          fetch: async () => {
            calls++;
            throw new Error(secret);
          },
          log: (value) => output.push(value),
          errorLog: (value) => output.push(value),
        }),
        1,
      );
      assert.equal(calls, 0);
      assert.deepEqual(output.map(JSON.parse), [{ ok: false, code }]);
      assertSafe(output);
    });
});

test("scoring checker masks transport, payload, pricing, persistence and idempotency failures", async (t) => {
  const cases = [
    [
      "CORS",
      (r, _p, _s, h) => {
        if (!r.isD1) h["access-control-allow-origin"] = secret;
      },
      "API_CORS_FAILED",
    ],
    [
      "HTTP",
      (_r, _p, _s, h) => new Response(secret, { status: 500, headers: h }),
      "API_HTTP_FAILED",
    ],
    ["JSON", (_r, _p, s, h) => new Response(secret, { status: s, headers: h }), "API_INVALID_JSON"],
    [
      "fresh private fields",
      (r, p) => {
        if (r.path === "/v1/daily") p.puzzles[0].acceptedSolutions = [originalSolution()];
      },
      "FRESH_DAILY_FAILED",
    ],
    [
      "spoiler title",
      (r, p) => {
        if (r.path === "/v1/daily") p.title = secret;
      },
      "FRESH_DAILY_FAILED",
    ],
    ...["en", "ru", "zh"].map((locale) => [
      `spoiler conditions ${locale}`,
      (r, p) => {
        if (r.path === "/v1/daily") {
          if (locale === "en") p.puzzles[0].prompt = secret;
          else p.puzzles[0].localizations[locale].prompt = secret;
        }
      },
      "FRESH_DAILY_FAILED",
    ]),
    [
      "thematic ID",
      (r, p) => {
        if (r.path === "/v1/daily") p.puzzles[0].id = "thematic-private-id";
      },
      "FRESH_DAILY_FAILED",
    ],
    [
      "missing progress",
      (r, p) => {
        if (r.path === "/v1/daily") delete p.progressStates;
      },
      "FRESH_DAILY_FAILED",
    ],
    [
      "D1 failure",
      (r, p) => {
        if (r.isD1) p.success = false;
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "D1 different puzzle",
      (r, p) => {
        if (r.isD1) p.result[0].results[0].puzzle_id = secret;
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "D1 malformed solution",
      (r, p) => {
        if (r.isD1) p.result[0].results[0].solution_json = secret;
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "D1 extra private fields",
      (r, p) => {
        if (r.isD1) p.result[0].results[0].private = secret;
      },
      "D1_SOLUTION_FAILED",
    ],
    [
      "wrong reveal",
      (r, p) => {
        if (r.path === "/v1/attempts" && p.correct) p.reveal.previousFen = "changed";
      },
      "SCORING_SOLVE_FAILED",
    ],
    [
      "missing reveal locale",
      (r, p) => {
        if (r.path === "/v1/attempts" && p.correct) delete p.reveal.localizations.zh;
      },
      "SCORING_SOLVE_FAILED",
    ],
    [
      "fresh award",
      (r, p) => {
        if (r.path === "/v1/attempts" && p.correct) p.progress.earnedPoints = 99;
      },
      "SCORING_AWARD_FAILED",
    ],
    [
      "replay header",
      (r, _p, s, h) => {
        if (r.path === "/v1/attempts" && s === 200) delete h["idempotency-replayed"];
      },
      "SCORING_IDEMPOTENCY_FAILED",
    ],
    [
      "replay snapshot",
      (r, p, s) => {
        if (r.path === "/v1/attempts" && s === 200) p.progress.earnedPoints = 0;
      },
      "SCORING_IDEMPOTENCY_FAILED",
    ],
    [
      "new UUID farms",
      (r, p, _s, _h, a) => {
        if (r.path === "/v1/attempts" && a.duplicateSolves) p.progress.awardAttemptId = p.id;
      },
      "SCORING_DUPLICATE_AWARD_FAILED",
    ],
    [
      "stats farming",
      (r, p, _s, _h, a) => {
        if (r.path === "/v1/me/stats" && a.duplicateSolves) p.points *= 2;
      },
      "SCORING_STATS_FAILED",
    ],
    [
      "reload lost progress",
      (r, p, _s, _h, a) => {
        if (r.path === "/v1/daily" && a.solved) p.progressStates[puzzleId].earnedPoints = 0;
      },
      "SCORING_RELOAD_FAILED",
    ],
    [
      "reload lost original conditions",
      (r, p, _s, _h, a) => {
        if (r.path === "/v1/daily" && a.solved) p.puzzles[0].prompt = "Reconstruct the last move.";
      },
      "SCORING_RELOAD_FAILED",
    ],
    [
      "reload unrelated conditions leaked",
      (r, p, _s, _h, a) => {
        if (r.path === "/v1/daily" && a.solved) p.puzzles[1].prompt = secret;
      },
      "SCORING_RELOAD_FAILED",
    ],
    [
      "wrong attempt counted twice",
      (r, p) => {
        if (r.path === "/v1/attempts" && !p.correct) p.progress.attemptCount = 2;
      },
      "SCORING_WRONG_ATTEMPT_FAILED",
    ],
    [
      "wrong attempt leaks solution",
      (r, p) => {
        if (r.path === "/v1/attempts" && !p.correct) p.reveal = originalSolution();
      },
      "SCORING_WRONG_ATTEMPT_FAILED",
    ],
    [
      "clue incorrect deduction",
      (r, p) => {
        if (r.path.endsWith("/clue")) p.progress.nextAttemptPoints = 70;
      },
      "SCORING_CLUE_FAILED",
    ],
    [
      "clue returns different original conditions",
      (r, p) => {
        if (r.path.endsWith("/clue")) p.prompt = secret;
      },
      "SCORING_CLUE_FAILED",
    ],
    [
      "clue missing locale",
      (r, p) => {
        if (r.path.endsWith("/clue")) delete p.localizations.ru;
      },
      "SCORING_CLUE_FAILED",
    ],
    [
      "clue repeated deduction",
      (r, p, _s, _h, a) => {
        if (r.path.endsWith("/clue") && a.clueRequests === 2) p.progress.assistanceCount = 2;
      },
      "SCORING_CLUE_IDEMPOTENCY_FAILED",
    ],
    [
      "second actor awarded too much",
      (r, p) => {
        if (r.path === "/v1/attempts" && r.actorIndex === 1 && p.correct)
          p.progress.earnedPoints = 70;
      },
      "SCORING_AWARD_FAILED",
    ],
    [
      "actor isolation",
      (r, p, _s, _h, a) => {
        if (
          r.path === "/v1/me/stats" &&
          r.actorIndex === 0 &&
          r.actorCount === 2 &&
          a.duplicateSolves
        )
          p.points = 35;
      },
      "SCORING_STATS_FAILED",
    ],
  ];
  for (const [name, mutate, code] of cases)
    await t.test(name, async () => {
      const output = [];
      const check = harness({ mutate });
      assert.equal(
        await runCli([], env, {
          ...check.deps,
          log: (value) => output.push(value),
          errorLog: (value) => output.push(value),
        }),
        1,
      );
      assert.deepEqual(output.map(JSON.parse), [{ ok: false, code }]);
      assertSafe(output);
    });
});

test("scoring checker never exposes thrown transport or dependency exception text", async () => {
  for (const isD1 of [false, true]) {
    const output = [];
    const check = harness({
      transport: async (request) => {
        if (request.isD1 === isD1) throw new Error(secret);
      },
    });
    assert.equal(
      await runCli([], env, {
        ...check.deps,
        log: (value) => output.push(value),
        errorLog: (value) => output.push(value),
      }),
      1,
    );
    assert.deepEqual(output.map(JSON.parse), [
      { ok: false, code: isD1 ? "D1_TRANSPORT_FAILED" : "API_TRANSPORT_FAILED" },
    ]);
    assertSafe(output);
  }
  const output = [];
  assert.equal(
    await runCli([], env, {
      now: () => {
        throw new Error(secret);
      },
      log: (value) => output.push(value),
      errorLog: (value) => output.push(value),
    }),
    1,
  );
  assert.deepEqual(output.map(JSON.parse), [{ ok: false, code: "SCORING_CHECK_FAILED" }]);
  assertSafe(output);
});

test("scoring checker rejects reused attempt UUIDs and emits only a safe success summary", async () => {
  const output = [];
  const check = harness();
  assert.equal(
    await runCli([], env, {
      ...check.deps,
      uuid: () => numberedUuid(1),
      log: (value) => output.push(value),
      errorLog: (value) => output.push(value),
    }),
    1,
  );
  assert.deepEqual(output.map(JSON.parse), [{ ok: false, code: "INVALID_ATTEMPT_UUID" }]);
  assertSafe(output);
  const successful = [];
  const second = harness();
  assert.equal(
    await runCli([], env, {
      ...second.deps,
      log: (value) => successful.push(value),
      errorLog: (value) => successful.push(value),
    }),
    0,
  );
  assert.equal(successful.length, 1);
  assert.equal(JSON.parse(successful[0]).ok, true);
  assertSafe(successful);
});
