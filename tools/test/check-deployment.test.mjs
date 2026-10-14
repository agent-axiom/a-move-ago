import assert from "node:assert/strict";
import test from "node:test";
import { checkDeployment, parseArguments } from "../scripts/check-deployment.mjs";

const origins = { apiOrigin: "https://api.example.test", webOrigin: "https://game.example.test" };
const token = "a".repeat(43);
const fixedNow = new Date("2026-10-14T12:00:00.000Z");
const sensitive = "PRIVATE_RESPONSE_MUST_NOT_REACH_LOGS";

function fixtures() {
  return {
    "/v1/healthz": { ok: true },
    "/v1/sessions/guest": {
      token,
      expiresAt: "2026-12-01T00:00:00.000Z",
      kind: "guest",
    },
    "/v1/me": { kind: "guest", profile: null },
    "/v1/me/stats": {
      attempts: 0,
      hintsUsed: 0,
      solvedPuzzles: 0,
      completedCases: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
    },
    "/v1/daily": {
      id: "case-2026-10-14",
      date: "2026-10-14",
      title: "The missing pawn",
      puzzles: [
        {
          id: "opening-exd5",
          version: 1,
          title: "The missing pawn",
          prompt: "What happened one move ago?",
          postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
          retractingColor: "w",
          maxHints: 2,
          provenance: "Original sample",
          license: "CC-BY-4.0",
        },
      ],
      solvedPuzzleIds: [],
    },
  };
}

function deployment({ payloads = fixtures(), override, now = () => fixedNow } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const headers = new Headers(options.headers);
    const request = { url, path, ...options, headers };
    requests.push(request);
    const preflight = options.method === "OPTIONS";
    const responseHeaders = new Headers({
      "access-control-allow-origin": origins.webOrigin,
      "cache-control": "no-store",
      "content-type": "application/json",
      ...(preflight
        ? {
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Content-Type, Authorization",
          }
        : {}),
    });
    const response = preflight
      ? new Response(null, { status: 204, headers: responseHeaders })
      : new Response(JSON.stringify(payloads[path]), {
          status: path === "/v1/sessions/guest" ? 201 : 200,
          headers: responseHeaders,
        });
    return override ? await override(request, response) : response;
  };
  return {
    requests,
    run: () => checkDeployment(origins, { fetch, now, timeoutMs: 500 }),
  };
}

async function rejectsWithoutSecrets(run, diagnostic) {
  await assert.rejects(run, (error) => {
    assert.match(error.message, diagnostic);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(sensitive), false);
    return true;
  });
}

test("a release check completes the guest journey with a safe summary", async () => {
  const harness = deployment();
  const result = await harness.run();
  assert.deepEqual(result, { ok: true, date: "2026-10-14", puzzleCount: 1 });
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.deepEqual(
    harness.requests.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /v1/healthz",
      "OPTIONS /v1/sessions/guest",
      "OPTIONS /v1/daily",
      "POST /v1/sessions/guest",
      "GET /v1/me",
      "GET /v1/me/stats",
      "GET /v1/daily",
    ],
  );
  for (const request of harness.requests) {
    const authenticated = request.method === "GET" && request.path !== "/v1/healthz";
    assert.equal(request.headers.get("authorization"), authenticated ? `Bearer ${token}` : null);
    assert.equal(request.headers.get("origin"), origins.webOrigin);
    assert.equal(request.redirect, "error");
    assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.url.includes(token), false);
    assert.equal(request.body?.includes(token) ?? false, false);
  }
  const guestRequest = harness.requests.find(({ method }) => method === "POST");
  assert.deepEqual(JSON.parse(guestRequest.body), { channel: "web" });
  assert.equal(harness.requests[1].headers.get("access-control-request-method"), "POST");
  assert.equal(harness.requests[1].headers.get("access-control-request-headers"), "content-type");
  assert.equal(harness.requests[2].headers.get("access-control-request-headers"), "authorization");
});

test("a check logs neither its session token nor raw response payloads", async () => {
  const output = [];
  const oldLog = console.log;
  const oldError = console.error;
  try {
    console.log = (...args) => output.push(args);
    console.error = (...args) => output.push(args);
    await deployment().run();
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
  assert.deepEqual(output, []);
});

test("content and database failures reject release without exposing response bodies", async (t) => {
  const cases = [
    { path: "/v1/daily", status: 404 },
    { path: "/v1/me/stats", status: 500 },
  ];
  for (const { path, status } of cases) {
    await t.test(`${status} on ${path}`, async () => {
      const harness = deployment({
        override: (request, response) => {
          if (request.method === "GET" && request.path === path) {
            return new Response(JSON.stringify({ error: { message: `${sensitive} ${token}` } }), {
              status,
              headers: response.headers,
            });
          }
          return response;
        },
      });
      await rejectsWithoutSecrets(harness.run, new RegExp(`HTTP_${status}`));
    });
  }
});

test("the browser must be allowed to create and authenticate a guest", async (t) => {
  const cases = [
    {
      name: "wildcard origin",
      method: "GET",
      path: "/v1/healthz",
      header: "access-control-allow-origin",
      value: "*",
      diagnostic: /CORS_FAILED/,
    },
    {
      name: "missing origin",
      method: "GET",
      path: "/v1/daily",
      header: "access-control-allow-origin",
      value: null,
      diagnostic: /CORS_FAILED/,
    },
    {
      name: "POST disallowed",
      method: "OPTIONS",
      path: "/v1/sessions/guest",
      header: "access-control-allow-methods",
      value: "GET",
      diagnostic: /CORS_METHOD_FAILED/,
    },
    {
      name: "bearer header disallowed",
      method: "OPTIONS",
      path: "/v1/daily",
      header: "access-control-allow-headers",
      value: "Content-Type",
      diagnostic: /CORS_HEADERS_FAILED/,
    },
    {
      name: "session is cacheable",
      method: "POST",
      path: "/v1/sessions/guest",
      header: "cache-control",
      value: "public, max-age=60",
      diagnostic: /CACHE_POLICY_FAILED/,
    },
    {
      name: "identity is cacheable",
      method: "GET",
      path: "/v1/me",
      header: "cache-control",
      value: null,
      diagnostic: /CACHE_POLICY_FAILED/,
    },
  ];
  for (const { name, method, path, header, value, diagnostic } of cases) {
    await t.test(name, async () => {
      const harness = deployment({
        override: (request, response) => {
          if (request.method === method && request.path === path) {
            if (value === null) response.headers.delete(header);
            else response.headers.set(header, value);
          }
          return response;
        },
      });
      await rejectsWithoutSecrets(harness.run, diagnostic);
    });
  }
});

test("daily responses cannot leak answers, hints, or nested private data", async (t) => {
  const fields = [
    "acceptedSolutions",
    "previousFen",
    "forwardSan",
    "explanation",
    "historyConstraints",
    "hints",
    "contradictionExplanations",
  ];
  for (const field of fields) {
    await t.test(field, async () => {
      const payloads = fixtures();
      payloads["/v1/daily"].puzzles[0].debug = { nested: [{ [field]: sensitive }] };
      await rejectsWithoutSecrets(deployment({ payloads }).run, /PRIVATE_DAILY_FIELDS/);
    });
  }
});

test("malformed or expired guest credentials never become authorization headers", async (t) => {
  for (const [name, patch] of [
    ["short token", { token: "short" }],
    ["header injection", { token: `${token}\r\nX-Leak: ${sensitive}` }],
    ["non-string token", { token: { sensitive } }],
    ["expired session", { expiresAt: fixedNow.toISOString() }],
    ["wrong identity kind", { kind: "telegram" }],
    ["unparseable expiry", { expiresAt: "tomorrow" }],
    ["non-contract expiry", { expiresAt: "December 1, 2027" }],
    ["impossible calendar expiry", { expiresAt: "2026-11-31T00:00:00.000Z" }],
  ]) {
    await t.test(name, async () => {
      const payloads = fixtures();
      Object.assign(payloads["/v1/sessions/guest"], patch);
      const harness = deployment({ payloads });
      await rejectsWithoutSecrets(harness.run, /GUEST_SESSION_FAILED/);
      assert.ok(harness.requests.every(({ headers }) => !headers.has("authorization")));
    });
  }
});

test("fresh guest identity, zero progress, and playable daily data are required", async (t) => {
  const cases = [
    {
      name: "unhealthy API",
      mutate: (payloads) => {
        payloads["/v1/healthz"].ok = false;
      },
      diagnostic: /HEALTH_FAILED/,
    },
    {
      name: "linked identity",
      mutate: (payloads) => {
        payloads["/v1/me"].profile = { telegramUserId: sensitive };
      },
      diagnostic: /GUEST_IDENTITY_FAILED/,
    },
    {
      name: "inherited progress",
      mutate: (payloads) => {
        payloads["/v1/me/stats"].attempts = 1;
      },
      diagnostic: /GUEST_STATS_FAILED/,
    },
    {
      name: "stale daily",
      mutate: (payloads) => {
        payloads["/v1/daily"].date = "2026-10-13";
      },
      diagnostic: /CURRENT_DAILY_FAILED/,
    },
    {
      name: "empty daily",
      mutate: (payloads) => {
        payloads["/v1/daily"].puzzles = [];
      },
      diagnostic: /DAILY_PAYLOAD_FAILED/,
    },
    {
      name: "missing position",
      mutate: (payloads) => {
        delete payloads["/v1/daily"].puzzles[0].postFen;
      },
      diagnostic: /DAILY_PAYLOAD_FAILED/,
    },
    {
      name: "already solved",
      mutate: (payloads) => {
        payloads["/v1/daily"].solvedPuzzleIds = ["opening-exd5"];
      },
      diagnostic: /DAILY_PAYLOAD_FAILED/,
    },
    {
      name: "missing public metadata",
      mutate: (payloads) => {
        for (const key of ["version", "title", "prompt", "provenance", "license"]) {
          delete payloads["/v1/daily"].puzzles[0][key];
        }
      },
      diagnostic: /DAILY_PAYLOAD_FAILED/,
    },
  ];
  for (const { name, mutate, diagnostic } of cases) {
    await t.test(name, async () => {
      const payloads = fixtures();
      mutate(payloads);
      await rejectsWithoutSecrets(deployment({ payloads }).run, diagnostic);
    });
  }
});

test("transport, redirects, and body failures have safe diagnostics", async (t) => {
  const cases = [
    {
      name: "transport",
      override: () => {
        throw new Error(`${token} ${sensitive}`);
      },
      diagnostic: /TRANSPORT_FAILED/,
    },
    {
      name: "redirect",
      override: () => {
        throw new TypeError(`redirect to https://elsewhere.test/${token}`);
      },
      diagnostic: /TRANSPORT_FAILED/,
    },
    {
      name: "invalid JSON",
      override: (_request, response) => {
        return new Response(`<html>${sensitive}</html>`, { headers: response.headers });
      },
      diagnostic: /INVALID_JSON/,
    },
    {
      name: "body interrupted",
      override: (_request, response) => ({
        status: response.status,
        headers: response.headers,
        json: async () => {
          throw new Error(`${token} ${sensitive}`);
        },
      }),
      diagnostic: /INVALID_JSON/,
    },
  ];
  for (const { name, override, diagnostic } of cases) {
    await t.test(name, async () => {
      await rejectsWithoutSecrets(deployment({ override }).run, diagnostic);
    });
  }
});

test("UTC midnight permits the date on either side of the daily request", async (t) => {
  for (const dailyDate of ["2026-10-14", "2026-10-15"]) {
    await t.test(dailyDate, async () => {
      const payloads = fixtures();
      payloads["/v1/daily"].date = dailyDate;
      const times = [
        "2026-10-14T23:59:59.000Z",
        "2026-10-14T23:59:59.999Z",
        "2026-10-15T00:00:00.001Z",
      ];
      const result = await deployment({ payloads, now: () => new Date(times.shift()) }).run();
      assert.equal(result.date, dailyDate);
    });
  }
});

test("CLI accepts canonical HTTPS and explicit local development origins", () => {
  assert.deepEqual(
    parseArguments(["--web-origin", origins.webOrigin, "--api-origin", origins.apiOrigin]),
    origins,
  );
  assert.deepEqual(
    parseArguments([
      "--api-origin",
      "http://127.0.0.1:8787",
      "--web-origin",
      "http://localhost:5173",
    ]),
    {
      apiOrigin: "http://127.0.0.1:8787",
      webOrigin: "http://localhost:5173",
    },
  );
});

test("CLI rejects unsafe destinations and ambiguous invocation before any requests", async (t) => {
  for (const value of [
    "http://api.example.test",
    "https://user:password@api.example.test",
    "https://api.example.test/",
    "https://api.example.test/other",
    "https://api.example.test?token=secret",
    "https://api.example.test#fragment",
    "https://api.example.test@attacker.test/path",
    "file:///tmp/example",
  ]) {
    await t.test(value, () => {
      assert.throws(
        () => parseArguments(["--api-origin", value, "--web-origin", origins.webOrigin]),
        /INVALID_ORIGIN/,
      );
    });
  }
  for (const args of [
    [],
    ["--api-origin", origins.apiOrigin],
    ["--api-origin"],
    ["--api-origin", origins.apiOrigin, "--web-origin"],
    [
      "--api-origin",
      origins.apiOrigin,
      "--api-origin",
      origins.apiOrigin,
      "--web-origin",
      origins.webOrigin,
    ],
    ["--api-origin", origins.apiOrigin, "--web-origin", origins.webOrigin, "--unknown", sensitive],
  ]) {
    assert.throws(
      () => parseArguments(args),
      (error) => {
        assert.match(error.message, /Usage:/);
        assert.equal(error.message.includes(sensitive), false);
        return true;
      },
    );
  }
  let requests = 0;
  await assert.rejects(
    () =>
      checkDeployment(
        { ...origins, apiOrigin: "http://remote.test" },
        {
          fetch: () => {
            requests += 1;
          },
        },
      ),
    /INVALID_ORIGIN/,
  );
  assert.equal(requests, 0);
});
