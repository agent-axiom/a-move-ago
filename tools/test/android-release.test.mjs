import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  main,
  prepareKeystore,
  releaseVersion,
  signerFingerprint,
  verifyApk,
  verifyAssetLinks,
  verifyGithubGates,
  verifyReleaseInput,
  verifyWebArtifact,
} from "../scripts/android-release.mjs";

const sha = "a".repeat(40);
const digest = "ab".repeat(32);
const certificate = Array(32).fill("AB").join(":");
const signer = `Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${digest}\n`;
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'self' https://api.test"><script type="module" crossorigin src="/assets/main.js"></script></head><body></body></html>`;
const script = "window.Capacitor = {}; const allowedDebugScheme = false; const runtimeDebugLiteral = 'amoveago-debug';";
const css = "body { color: ivory; }";
const manifest = `<?xml version="1.0"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.agentaxiom.amoveago"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:debuggable="false"><activity android:name=".MainActivity"><intent-filter android:autoVerify="true"><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="https" android:host="api.test" android:pathPrefix="/auth/android"/></intent-filter></activity></application></manifest>`;
const green = (id = 1, overrides = {}) => ({ id, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success", ...overrides });
const github = { repository: "agent-axiom/a-move-ago", commitSha: sha, token: "github-test-token" };

function response(value, status = 200) {
  return { status, json: async () => value };
}

function releaseEnvironment(overrides = {}) {
  return {
    RELEASE_EVENT: "workflow_dispatch",
    RELEASE_REF: "refs/heads/main",
    RELEASE_SHA: sha,
    RELEASE_VERSION: "1.0.0",
    RELEASE_MODE: "build-only",
    RELEASE_REPOSITORY: github.repository,
    API_ORIGIN: "https://api.test",
    GITHUB_TOKEN: github.token,
    ...overrides,
  };
}

function gitRunner(calls, notes = "A new perspective, one move ago.\n") {
  return async (file, args) => {
    calls.push([file, args]);
    assert.equal(file, "git");
    if (args[0] === "rev-parse") return { stdout: `${sha}\n` };
    if (args[0] === "show") return { stdout: notes };
    assert.deepEqual(args, ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]);
    return { stdout: "" };
  };
}

test("versions are canonical, deterministic and within Android's allowed integer range", () => {
  for (const [name, code] of [["0.0.1", 1], ["0.999.999", 999999], ["1.0.0", 1000000], ["2099.999.999", 2099999999]]) {
    assert.deepEqual(releaseVersion(name), { versionName: name, versionCode: code });
  }
  for (const value of ["0.0.0", "2100.0.0", "1.1000.0", "1.0.1000", "01.0.0", "1.00.0", "1.0.01", "1.0.0-beta.1", "1.0.0+build", "1.0", "1.0.0\n", "1.0.0; echo leak", "$(env)"]) {
    assert.throws(() => releaseVersion(value), /INVALID_RELEASE_VERSION/);
  }
});

test("release inputs resolve immutable target notes, exact commit and both required gates", async () => {
  const calls = [];
  const requests = [];
  const result = await verifyReleaseInput(releaseEnvironment(), {
    run: gitRunner(calls),
    fetch: async (url, init) => {
      const target = new URL(url);
      assert.equal(target.origin, "https://api.github.com");
      assert.equal(target.searchParams.get("head_sha"), sha);
      assert.equal(target.searchParams.get("event"), "push");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, `Bearer ${github.token}`);
      requests.push(target.pathname);
      return response({ workflow_runs: [green()] });
    },
  });
  assert.deepEqual(result, { versionName: "1.0.0", versionCode: 1000000, commitSha: sha, mode: "build-only", apiHost: "api.test", notesPath: "ops/rustore/notes/1.0.0.txt" });
  assert(calls.some(([, args]) => args[0] === "show" && args[1] === `${sha}:ops/rustore/notes/1.0.0.txt`));
  assert.deepEqual(requests.map((path) => path.split("/").at(-2)), ["ci.yml", "android.yml"]);
});

test("release tags publish while manual release requires main and defaults to build-only", async () => {
  const calls = [];
  const options = { run: gitRunner(calls), fetch: async () => response({ workflow_runs: [green()] }) };
  const tagged = await verifyReleaseInput(releaseEnvironment({ RELEASE_EVENT: "push", RELEASE_REF: "refs/tags/android-v1.0.0" }), options);
  assert.equal(tagged.mode, "publish");
  assert(calls.some(([, args]) => args[1] === "--verify" && args[2] === "refs/tags/android-v1.0.0^{commit}"));
  assert.equal((await verifyReleaseInput(releaseEnvironment({ RELEASE_MODE: "" }), options)).mode, "build-only");
  await assert.rejects(verifyReleaseInput(releaseEnvironment({ RELEASE_REF: "refs/heads/unreviewed" }), options), /MANUAL_RELEASE_REQUIRES_MAIN/);
});

test("injected inputs, non-main commits and mismatched tags never reach a credentialed API call", async () => {
  let requested = false;
  const options = { run: gitRunner([]), fetch: async () => { requested = true; return response({}); } };
  for (const input of [
    { RELEASE_VERSION: "1.0.0\nGITHUB_TOKEN=stolen" },
    { RELEASE_SHA: `${sha}; cat /proc/self/environ` },
    { API_ORIGIN: "https://attacker.test/path" },
    { RELEASE_EVENT: "pull_request" },
    { RELEASE_MODE: "publish; env" },
  ]) await assert.rejects(verifyReleaseInput(releaseEnvironment(input), options));
  await assert.rejects(verifyReleaseInput(releaseEnvironment(), {
    ...options,
    run: async (file, args) => {
      if (args[0] === "merge-base") throw new Error("secret unsafe stderr");
      return gitRunner([])(file, args);
    },
  }), /RELEASE_COMMIT_NOT_ON_MAIN/);
  await assert.rejects(verifyReleaseInput(releaseEnvironment({ RELEASE_EVENT: "push", RELEASE_REF: "refs/tags/android-v1.0.0" }), {
    ...options,
    run: async (file, args) => args[2]?.startsWith("refs/tags/") ? { stdout: "b".repeat(40) } : gitRunner([])(file, args),
  }), /RELEASE_TAG_COMMIT_MISMATCH/);
  assert.equal(requested, false);
});

test("required notes reject missing, blank, NUL and more than 5000 UTF-16 units", async () => {
  const options = { fetch: async () => response({ workflow_runs: [green()] }) };
  for (const notes of [" ", "bad\0notes", "x".repeat(5001), "♟️".repeat(2501)]) {
    await assert.rejects(verifyReleaseInput(releaseEnvironment(), { ...options, run: gitRunner([], notes) }), /INVALID_RELEASE_NOTES/);
  }
  await assert.rejects(verifyReleaseInput(releaseEnvironment(), {
    ...options,
    run: async (file, args) => { if (args[0] === "show") throw new Error("not found"); return gitRunner([])(file, args); },
  }), /RELEASE_NOTES_REQUIRED/);
});

test("only the latest exact-SHA main push runs can satisfy release checks", async () => {
  const cases = [
    [[green(1, { head_sha: "b".repeat(40) })], /GITHUB_RELEASE_GATE_MISSING/],
    [[green(1, { event: "pull_request" })], /GITHUB_RELEASE_GATE_MISSING/],
    [[green(1, { head_branch: "feature" })], /GITHUB_RELEASE_GATE_MISSING/],
    [[green(1), green(2, { conclusion: "failure" })], /GITHUB_RELEASE_GATE_NOT_GREEN/],
    [[green(2, { status: "in_progress", conclusion: null }), green(1)], /GITHUB_RELEASE_GATE_NOT_GREEN/],
  ];
  for (const [runs, error] of cases) {
    await assert.rejects(verifyGithubGates(github, { fetch: async () => response({ workflow_runs: runs }) }), error);
  }
  await assert.rejects(verifyGithubGates({ ...github, token: "" }), /GITHUB_TOKEN_REQUIRED/);
  await assert.rejects(verifyGithubGates(github, { fetch: async () => response({ secret: github.token }, 403) }), (error) => error.message === "GITHUB_RELEASE_GATE_HTTP_FAILED");
  await assert.rejects(verifyGithubGates(github, { fetch: async () => { throw new Error(github.token); } }), (error) => error.message === "GITHUB_RELEASE_GATE_TRANSPORT_FAILED");
});

async function apkFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "a-move-ago-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webDir = join(directory, "android");
  await mkdir(join(webDir, "assets"), { recursive: true });
  await writeFile(join(webDir, "index.html"), html);
  await writeFile(join(webDir, "assets/main.js"), script);
  await writeFile(join(webDir, "assets/main.css"), css);
  const apkPath = join(directory, "signed release.apk");
  await writeFile(apkPath, "PK synthetic APK bytes");
  const input = { apkPath, sdkRoot: "/android-sdk", versionName: "1.0.0", versionCode: 1000000, apiOrigin: "https://api.test", webDir };
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith("/apksigner")) return { stdout: signer };
    if (file === "unzip") {
      return { stdout: args[2].endsWith("index.html") ? html : args[2].endsWith(".js") ? script : css };
    }
    assert(file.endsWith("/cmdline-tools/latest/bin/apkanalyzer"));
    return { stdout: ({ "application-id": "com.agentaxiom.amoveago", "version-code": "1000000", "version-name": "1.0.0", debuggable: "false", print: manifest })[args[1]] };
  };
  return { input, run, calls, directory };
}

test("APK verification exercises SDK tools and compares the packaged web to the verified Android build", async (t) => {
  const fixture = await apkFixture(t);
  const metadata = await verifyApk(fixture.input, { run: fixture.run });
  assert.equal(metadata.packageName, "com.agentaxiom.amoveago");
  assert.equal(metadata.certificateSha256, certificate);
  assert.match(metadata.apkSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.calls[0], ["/android-sdk/build-tools/36.0.0/apksigner", ["verify", "--verbose", "--print-certs", fixture.input.apkPath]]);
  assert.equal(fixture.calls.filter(([file]) => file === "unzip").length, 3);
  assert(!JSON.stringify(metadata).includes("keystore"));
});

test("wrong package, version, debug/test-only flags and App Link host/path are rejected", async (t) => {
  const fixture = await apkFixture(t);
  const mutations = [
    ["application-id", "other.application", /APK_PACKAGE_MISMATCH/],
    ["version-code", "1", /APK_VERSION_MISMATCH/],
    ["version-name", "1.0.1", /APK_VERSION_MISMATCH/],
    ["debuggable", "true", /APK_DEBUGGABLE_FORBIDDEN/],
    ["print", manifest.replace('<application ', '<application android:testOnly="true" '), /APK_TEST_ONLY_FORBIDDEN/],
    ["print", manifest.replace('android:scheme="https"', 'android:scheme="amoveago-debug"'), /APK_DEBUG_AUTH_FORBIDDEN/],
    ["print", manifest.replace('android:host="api.test"', 'android:host="other.test"'), /APK_AUTH_APP_LINK_MISMATCH/],
    ["print", manifest.replace('/auth/android', '/unrelated'), /APK_AUTH_APP_LINK_MISMATCH/],
    ["print", manifest.replace('android:targetSdkVersion="36"', 'android:targetSdkVersion="35"'), /APK_SDK_MISMATCH/],
  ];
  for (const [task, value, error] of mutations) {
    await assert.rejects(verifyApk(fixture.input, {
      run: (file, args) => file.endsWith("/apkanalyzer") && args[1] === task ? { stdout: value } : fixture.run(file, args),
    }), error);
  }
});

test("invalid signatures, extra signers and signer mismatch fail before APK retention", async (t) => {
  const fixture = await apkFixture(t);
  await assert.rejects(verifyApk(fixture.input, {
    run: (file, args) => { if (file.endsWith("/apksigner")) throw new Error("private unsafe output"); return fixture.run(file, args); },
  }), (error) => error.message === "APK_SIGNATURE_INVALID");
  assert.throws(() => signerFingerprint(`${signer}Signer #2 certificate SHA-256 digest: ${digest}\n`), /APK_SINGLE_SIGNER_REQUIRED/);
  await assert.rejects(verifyApk({ ...fixture.input, expectedCertificateSha256: Array(32).fill("CD").join(":") }, { run: fixture.run }), /APK_SIGNER_MISMATCH/);
});

test("production web checks reject debug auth, Telegram and a different API, and detect stale packaged JS", async (t) => {
  const fixture = await apkFixture(t);
  for (const [value, error] of [
    [html.replace("</head>", '<meta name="a-move-ago-android-debug-auth" content="enabled"></head>'), /ANDROID_WEB_DEBUG_AUTH_FORBIDDEN/],
    [html.replace("</head>", '<script src="https://telegram.org/js/telegram-web-app.js"></script></head>'), /ANDROID_WEB_TELEGRAM_BOOTSTRAP_FORBIDDEN/],
    [html.replace("https://api.test", "https://other.test"), /ANDROID_WEB_API_ORIGIN_MISMATCH/],
    [html.replace('src="/assets/', 'src="./assets/'), /ANDROID_WEB_PROFILE_MISMATCH/],
  ]) {
    await writeFile(join(fixture.input.webDir, "index.html"), value);
    await assert.rejects(verifyWebArtifact(fixture.input.webDir, "https://api.test"), error);
  }
  await writeFile(join(fixture.input.webDir, "index.html"), html);
  await assert.rejects(verifyApk(fixture.input, {
    run: (file, args) => file === "unzip" && args[2].endsWith(".js") ? { stdout: "old bundle" } : fixture.run(file, args),
  }), /APK_WEB_ASSET_MISMATCH/);
});

test("publish App Links require the exact package, signing certificate and relation without credentials or redirects", async () => {
  const statement = { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.agentaxiom.amoveago", sha256_cert_fingerprints: [certificate] } };
  await verifyAssetLinks({ apiOrigin: "https://api.test", certificateSha256: certificate }, {
    fetch: async (url, init) => {
      assert.equal(url, "https://api.test/.well-known/assetlinks.json");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, undefined);
      return response([statement]);
    },
  });
  for (const value of [[], [{ ...statement, relation: [] }], [{ ...statement, target: { ...statement.target, package_name: "other.app" } }], [{ ...statement, target: { ...statement.target, sha256_cert_fingerprints: [Array(32).fill("CD").join(":")] } }]]) {
    await assert.rejects(verifyAssetLinks({ apiOrigin: "https://api.test", certificateSha256: certificate }, { fetch: async () => response(value) }), /ANDROID_ASSET_LINKS_SIGNER_MISMATCH/);
  }
  await assert.rejects(verifyAssetLinks({ apiOrigin: "https://api.test", certificateSha256: certificate }, { fetch: async () => response({}, 302) }), /ANDROID_ASSET_LINKS_HTTP_FAILED/);
});

test("signing credentials are required before creating a private temporary keystore, which cleanup removes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-keystore-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { RUNNER_TEMP: directory, ANDROID_KEYSTORE_BASE64: Buffer.from("synthetic-keystore").toString("base64"), ANDROID_KEYSTORE_PASSWORD: "store-secret", ANDROID_KEY_ALIAS: "release", ANDROID_KEY_PASSWORD: "key-secret" };
  for (const key of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) {
    await assert.rejects(prepareKeystore({ ...env, [key]: "" }), /ANDROID_RELEASE_SIGNING_CREDENTIALS_REQUIRED/);
  }
  await assert.rejects(prepareKeystore({ ...env, ANDROID_KEYSTORE_BASE64: "not base64" }), /INVALID_ANDROID_KEYSTORE_BASE64/);
  const path = await prepareKeystore(env);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), "synthetic-keystore");
  await main(["cleanup"], env);
  await assert.rejects(stat(path), { code: "ENOENT" });
});
