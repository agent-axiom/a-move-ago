import assert from "node:assert/strict";
import { constants, createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishRuStore, RuStorePublishError, runCli } from "../scripts/publish-rustore.mjs";

const packageName = "com.agentaxiom.amoveago";
const origin = "https://public-api.rustore.ru";
const path = `/public/v1/application/${packageName}/version`;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyBase64 = pair.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
const keyId = "synthetic-rustore-key";
const token = "PRIVATE_RUSTORE_JWE_MUST_NOT_BE_LOGGED";
const secret = "PRIVATE_UPSTREAM_MESSAGE_MUST_NOT_BE_LOGGED";
const apkBytes = Buffer.from("PK\x03\x04synthetic-apk-fixture");
const now = () => new Date("2026-10-18T12:34:56.789Z");
const old = { versionId: 100, versionName: "1.0.0", versionCode: 1, versionStatus: "ACTIVE" };
const submitted = {
  versionId: 201,
  versionName: "1.1.0",
  versionCode: 2,
  versionStatus: "AUTO_CHECK",
};

function ok(body) {
  return Response.json({ code: "OK", body });
}

function page(content, pageNumber = 0, totalElements = content.length, size = 100) {
  return {
    content,
    pageNumber,
    pageSize: size,
    totalElements,
    totalPages: Math.ceil(totalElements / size),
  };
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "a-move-ago-rustore-"));
  const apkPath = join(directory, "signed-release.apk");
  const notesPath = join(directory, "release-notes.txt");
  try {
    await writeFile(apkPath, apkBytes);
    await writeFile(notesPath, "Original chess puzzles.\nImproved archive navigation.\n");
    await run({
      keyId,
      privateKeyBase64,
      apkPath,
      notesPath,
      versionName: "1.1.0",
      versionCode: 2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function harness({ all = [old], releases = all, override } = {}) {
  const calls = [];
  async function request(url, init) {
    const parsed = new URL(url);
    let stage;
    let body;
    if (parsed.pathname === "/public/auth/") {
      stage = "auth";
      body = { jwe: token, ttl: 900 };
    } else if (parsed.searchParams.has("ids")) {
      stage = "verify";
      body = page([submitted]);
    } else if (init.method === "GET") {
      stage = "list";
      body = page(parsed.searchParams.get("filterTestingType") === "ALL" ? all : releases);
    } else if (parsed.pathname.endsWith("/apk")) {
      stage = "upload";
      body = { permissions: {} };
    } else if (parsed.pathname.endsWith("/commit")) {
      stage = "commit";
      body = null;
    } else {
      stage = "create";
      body = 201;
    }
    const call = { url, parsed, init, stage };
    calls.push(call);
    const overridden = await override?.(call, body);
    return overridden ?? ok(body);
  }
  return { calls, runtime: { fetch: request, now } };
}

function noSecret(value) {
  const text = JSON.stringify(value);
  for (const hidden of [token, secret, privateKeyBase64]) {
    assert.equal(text.includes(hidden), false);
  }
}

test("signs RuStore auth correctly and uploads once before submission and readback", async () => {
  await fixture(async (options) => {
    const check = harness();
    const result = await publishRuStore(options, check.runtime);
    assert.deepEqual(result, {
      ok: true,
      packageName,
      versionId: 201,
      versionCode: 2,
      versionName: "1.1.0",
      status: "AUTO_CHECK",
      alreadySubmitted: false,
      outcome: "submitted_for_moderation",
      localApkSha256: createHash("sha256").update(apkBytes).digest("hex"),
      bytes: apkBytes.length,
    });
    noSecret(result);
    assert.deepEqual(
      check.calls.map((call) => call.stage),
      ["auth", "list", "list", "create", "upload", "commit", "verify"],
    );
    const auth = JSON.parse(check.calls[0].init.body);
    assert.deepEqual(Object.keys(auth).sort(), ["keyId", "signature", "timestamp"]);
    assert.equal(auth.timestamp, "2026-10-18T12:34:56.789Z");
    assert.equal(auth.keyId, keyId);
    assert.equal(
      verify(
        "sha512",
        Buffer.from(keyId + auth.timestamp),
        { key: pair.publicKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(auth.signature, "base64"),
      ),
      true,
    );
    assert.equal(check.calls[0].url, `${origin}/public/auth/`);
    assert.equal(check.calls[1].url, `${origin}${path}?page=0&size=100&filterTestingType=ALL`);
    assert.equal(check.calls[2].url, `${origin}${path}?page=0&size=100&filterTestingType=RELEASE`);
    assert.deepEqual(JSON.parse(check.calls[3].init.body), {
      whatsNew: "Original chess puzzles.\nImproved archive navigation.",
      publishType: "INSTANTLY",
    });
    const upload = check.calls[4];
    assert.equal(upload.url, `${origin}${path}/201/apk?isMainApk=true`);
    assert.ok(upload.init.body instanceof FormData);
    assert.deepEqual([...upload.init.body.keys()], ["file"]);
    const file = upload.init.body.get("file");
    assert.equal(file.name, "app-release.apk");
    assert.equal(file.type, "application/vnd.android.package-archive");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), apkBytes);
    assert.equal(upload.init.headers["content-type"], undefined);
    assert.equal(check.calls[5].url, `${origin}${path}/201/commit?priorityUpdate=0`);
    assert.equal(check.calls[5].init.body, undefined);
    assert.equal(check.calls[6].url, `${origin}${path}?ids=201`);
    for (const call of check.calls) {
      assert.equal(call.parsed.origin, origin);
      assert.equal(call.init.redirect, "error");
      assert.equal(call.init.cache, "no-store");
      assert.ok(call.init.signal instanceof AbortSignal);
      assert.equal(call.init.headers["Public-Token"], call.stage === "auth" ? undefined : token);
      assert.equal(call.url.includes(token), false);
      assert.notEqual(call.init.method, "DELETE");
    }
  });
});

test("invalid credentials and release metadata fail before authentication", async (t) => {
  await fixture(async (options) => {
    for (const patch of [
      { keyId: undefined },
      { keyId: " " },
      { privateKeyBase64: undefined },
      { privateKeyBase64: "not valid base64" },
      { privateKeyBase64: Buffer.from("invalid DER").toString("base64") },
      { versionCode: 0 },
      { versionCode: "2.0" },
      { versionCode: "01" },
      { versionCode: 2_147_483_648 },
      { versionName: "" },
      { versionName: "1.1\nPRIVATE" },
      { versionName: " padded " },
    ]) {
      await t.test(Object.keys(patch)[0] + JSON.stringify(patch.versionCode ?? ""), async () => {
        const check = harness();
        await assert.rejects(
          publishRuStore({ ...options, ...patch }, check.runtime),
          RuStorePublishError,
        );
        assert.equal(check.calls.length, 0);
      });
    }
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const check = harness();
    await assert.rejects(
      publishRuStore(
        {
          ...options,
          privateKeyBase64: ec.privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
        },
        check.runtime,
      ),
      { code: "INVALID_PRIVATE_KEY" },
    );
    assert.equal(check.calls.length, 0);
  });
});

test("validates artifact files and release notes before authentication", async (t) => {
  for (const scenario of [
    "missing",
    "extension",
    "empty",
    "directory",
    "oversized",
    "empty notes",
    "long notes",
    "invalid UTF8",
  ]) {
    await t.test(scenario, async () =>
      fixture(async (options) => {
        if (scenario === "missing") options.apkPath += ".missing.apk";
        if (scenario === "extension") options.apkPath = options.notesPath;
        if (scenario === "empty") await writeFile(options.apkPath, "");
        if (scenario === "directory") {
          await rm(options.apkPath);
          await mkdir(options.apkPath);
        }
        if (scenario === "oversized") await truncate(options.apkPath, 5_000_000_001);
        if (scenario === "empty notes") await writeFile(options.notesPath, " \n");
        if (scenario === "long notes") await writeFile(options.notesPath, "a".repeat(5_001));
        if (scenario === "invalid UTF8") await writeFile(options.notesPath, Buffer.from([0xff]));
        const check = harness();
        await assert.rejects(publishRuStore(options, check.runtime), RuStorePublishError);
        assert.equal(check.calls.length, 0);
      }),
    );
  }
});

test("blocks unsafe release transitions before creating a version", async (t) => {
  const cases = [
    ["first release", [], [], "FIRST_VERSION_REQUIRED"],
    ["alpha only", [old], [], "FIRST_VERSION_REQUIRED"],
    [
      "manual draft",
      [old, { versionId: 101, versionName: null, versionCode: null, versionStatus: "DRAFT" }],
      [old],
      "EXISTING_DRAFT_REQUIRES_CONSOLE",
    ],
    [
      "moderation",
      [old, { ...submitted, versionCode: 3, versionStatus: "MODERATION" }],
      [old],
      "RELEASE_IN_PROGRESS",
    ],
    [
      "ready",
      [old, { ...submitted, versionStatus: "READY_FOR_PUBLICATION" }],
      [old],
      "RELEASE_IN_PROGRESS",
    ],
    [
      "partial rollout",
      [{ ...old, versionStatus: "PARTIAL_ACTIVE" }],
      [{ ...old, versionStatus: "PARTIAL_ACTIVE" }],
      "FIRST_VERSION_REQUIRED",
    ],
    [
      "downgrade",
      [old, { ...submitted, versionCode: 4, versionStatus: "ARCHIVED" }],
      [old],
      "VERSION_CODE_NOT_INCREMENTED",
    ],
    [
      "code conflict",
      [{ ...old, versionCode: 2 }],
      [{ ...old, versionCode: 2 }],
      "VERSION_CODE_NOT_INCREMENTED",
    ],
  ];
  for (const [name, all, releases, code] of cases) {
    await t.test(name, async () =>
      fixture(async (options) => {
        const check = harness({ all, releases });
        await assert.rejects(publishRuStore(options, check.runtime), { code });
        assert.ok(check.calls.every((call) => ["auth", "list"].includes(call.stage)));
      }),
    );
  }
});

test("an exact submitted production release is idempotent without mutations", async (t) => {
  for (const versionStatus of ["TAKEN_FOR_MODERATION", "MODERATION", "AUTO_CHECK", "ACTIVE"]) {
    await t.test(versionStatus, async () =>
      fixture(async (options) => {
        const check = harness({ all: [old, { ...submitted, versionStatus }] });
        const result = await publishRuStore(options, check.runtime);
        assert.equal(result.alreadySubmitted, true);
        assert.equal(result.outcome, "existing_version_already_submitted");
        assert.equal(result.remoteArtifactVerified, false);
        assert.equal(result.versionId, 201);
        assert.ok(check.calls.every((call) => ["auth", "list"].includes(call.stage)));
      }),
    );
  }
});

test("all pages are inspected, including alpha drafts on a later page", async () => {
  await fixture(async (options) => {
    const draft = {
      versionId: 103,
      versionName: null,
      versionCode: null,
      versionStatus: "DRAFT",
      testingType: "alpha",
    };
    const check = harness({
      override: (call) => {
        if (call.stage !== "list") return;
        const pageNumber = Number(call.parsed.searchParams.get("page"));
        return ok(
          page(
            pageNumber === 0
              ? [old, { ...old, versionId: 102, versionStatus: "ARCHIVED" }]
              : [draft],
            pageNumber,
            3,
            2,
          ),
        );
      },
    });
    await assert.rejects(publishRuStore(options, check.runtime), {
      code: "EXISTING_DRAFT_REQUIRES_CONSOLE",
      versionId: 103,
    });
    assert.deepEqual(
      check.calls.map((call) => call.stage),
      ["auth", "list", "list"],
    );
    assert.equal(check.calls[2].parsed.searchParams.get("page"), "1");
  });
});

test("excessive, inconsistent, duplicate or incomplete version pages fail closed", async (t) => {
  for (const [name, response] of [
    ["too many pages", page([old], 0, 2_100, 100)],
    ["missing entries", page([old], 0, 2, 100)],
    ["wrong page", page([old], 1)],
    ["duplicate IDs", page([old, old])],
    ["unknown state", page([{ ...old, versionStatus: secret }])],
    ["inconsistent metadata", { ...page([old]), totalPages: 2 }],
  ]) {
    await t.test(name, async () =>
      fixture(async (options) => {
        const check = harness({
          override: (call) => (call.stage === "list" ? ok(response) : undefined),
        });
        await assert.rejects(publishRuStore(options, check.runtime), RuStorePublishError);
        assert.ok(check.calls.every((call) => ["auth", "list"].includes(call.stage)));
      }),
    );
  }
});

test("rejects upstream failures at every API stage without leaking content", async (t) => {
  for (const stage of ["auth", "list", "create", "upload", "commit", "verify"]) {
    for (const failure of ["HTTP", "JSON", "provider"]) {
      await t.test(`${stage} ${failure}`, async () =>
        fixture(async (options) => {
          const check = harness({
            override: (call) => {
              if (call.stage !== stage) return;
              if (failure === "HTTP") return new Response(secret, { status: 503 });
              if (failure === "JSON") return new Response(`${secret} ${token}`);
              return Response.json({ code: "ERROR", body: { secret, token } });
            },
          });
          const errors = [];
          const env = {
            RUSTORE_KEY_ID: options.keyId,
            RUSTORE_PRIVATE_KEY_BASE64: options.privateKeyBase64,
            RUSTORE_APK_PATH: options.apkPath,
            RUSTORE_NOTES_PATH: options.notesPath,
            RUSTORE_VERSION_NAME: options.versionName,
            RUSTORE_VERSION_CODE: String(options.versionCode),
          };
          assert.equal(
            await runCli([], env, {
              ...check.runtime,
              errorLog: (value) => errors.push(value),
              log: () => assert.fail("Failure must not report success"),
            }),
            1,
          );
          assert.equal(errors.length, 1);
          noSecret(errors);
          const result = JSON.parse(errors[0]);
          assert.equal(result.stage, stage);
          assert.equal(check.calls.filter((call) => call.stage === stage).length, 1);
          assert.ok(check.calls.every((call) => call.init.method !== "DELETE"));
        }),
      );
    }
  }
});

test("never retries or removes an ambiguous mutation", async (t) => {
  for (const stage of ["create", "upload", "commit"]) {
    await t.test(stage, async () =>
      fixture(async (options) => {
        const check = harness({
          override: (call) => {
            if (call.stage === stage) throw new Error(`${secret} ${privateKeyBase64} ${token}`);
          },
        });
        await assert.rejects(publishRuStore(options, check.runtime), (error) => {
          assert.ok(error instanceof RuStorePublishError);
          assert.equal(error.stage, stage);
          assert.equal(error.reviewRequired, true);
          assert.equal(error.versionId, stage === "create" ? undefined : 201);
          noSecret(error);
          return true;
        });
        assert.equal(check.calls.filter((call) => call.stage === stage).length, 1);
        assert.ok(check.calls.every((call) => call.init.method !== "DELETE"));
      }),
    );
  }
});

test("accepts OK upload and commit envelopes without unused body fields", async () => {
  await fixture(async (options) => {
    const check = harness({
      override: (call) =>
        ["upload", "commit"].includes(call.stage) ? Response.json({ code: "OK" }) : undefined,
    });
    assert.equal((await publishRuStore(options, check.runtime)).alreadySubmitted, false);
  });
});

test("rejects malformed auth and changed snapshots before creating a draft", async (t) => {
  for (const [name, override, code] of [
    [
      "invalid token lifetime",
      (call) => (call.stage === "auth" ? ok({ jwe: token, ttl: 901 }) : undefined),
      "AUTH_RESPONSE_INVALID",
    ],
    [
      "control characters in token",
      (call) => (call.stage === "auth" ? ok({ jwe: `${token}\n`, ttl: 900 }) : undefined),
      "AUTH_RESPONSE_INVALID",
    ],
    [
      "changed release status",
      (call) =>
        call.stage === "list" && call.parsed.searchParams.get("filterTestingType") === "RELEASE"
          ? ok(page([{ ...old, versionStatus: "DRAFT" }]))
          : undefined,
      "VERSION_LIST_CHANGED",
    ],
  ]) {
    await t.test(name, async () =>
      fixture(async (options) => {
        const check = harness({ override });
        await assert.rejects(publishRuStore(options, check.runtime), { code });
        assert.ok(check.calls.every((call) => ["auth", "list"].includes(call.stage)));
      }),
    );
  }
});

test("does not start a mutation that cannot finish inside the token lifetime", async () => {
  await fixture(async (options) => {
    let current = now();
    const check = harness({
      override: (call) => {
        if (
          call.stage === "list" &&
          call.parsed.searchParams.get("filterTestingType") === "RELEASE"
        ) {
          current = new Date(now().getTime() + 890_000);
        }
      },
    });
    check.runtime.now = () => current;
    await assert.rejects(publishRuStore(options, check.runtime), {
      code: "AUTH_TOKEN_EXPIRED",
      stage: "create",
    });
    assert.ok(check.calls.every((call) => ["auth", "list"].includes(call.stage)));
  });
});

test("an unconfirmed create or submission is not treated as success", async (t) => {
  for (const [name, override, code] of [
    [
      "ambiguous create shape",
      (call) => (call.stage === "create" ? ok({ versionId: 201 }) : undefined),
      "CREATE_RESPONSE_UNCONFIRMED",
    ],
    [
      "existing version ID",
      (call) => (call.stage === "create" ? ok(100) : undefined),
      "CREATE_RESPONSE_UNCONFIRMED",
    ],
    [
      "wrong uploaded version",
      (call) =>
        call.stage === "verify" ? ok(page([{ ...submitted, versionCode: 3 }])) : undefined,
      "SUBMISSION_UNCONFIRMED",
    ],
    [
      "still draft",
      (call) =>
        call.stage === "verify" ? ok(page([{ ...submitted, versionStatus: "DRAFT" }])) : undefined,
      "SUBMISSION_UNCONFIRMED",
    ],
  ]) {
    await t.test(name, async () =>
      fixture(async (options) => {
        const check = harness({ override });
        await assert.rejects(publishRuStore(options, check.runtime), { code });
        assert.ok(check.calls.every((call) => call.init.method !== "DELETE"));
      }),
    );
  }
});

test("keeps CLI validation failures free of credentials and paths", async () => {
  const output = [];
  const runtime = {
    fetch: () => assert.fail("No network expected"),
    errorLog: (value) => output.push(value),
  };
  assert.equal(await runCli(["--api-origin", "https://evil.example"], {}, runtime), 1);
  assert.equal(await runCli([], {}, runtime), 1);
  assert.deepEqual(
    output.map((value) => JSON.parse(value)),
    [
      { ok: false, code: "UNEXPECTED_ARGUMENTS", stage: "validation" },
      { ok: false, code: "INVALID_VERSION_CODE", stage: "validation" },
    ],
  );
  noSecret(output);
});
