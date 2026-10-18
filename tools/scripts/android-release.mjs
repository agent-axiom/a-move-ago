import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const PACKAGE_NAME = "com.agentaxiom.amoveago";
const SHA = /^[a-f0-9]{40}$/;
const FINGERPRINT = /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/;

export class ReleaseError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReleaseError";
  }
}

function ensure(condition, code) {
  if (!condition) throw new ReleaseError(code);
}

export function releaseVersion(value) {
  ensure(typeof value === "string", "INVALID_RELEASE_VERSION");
  const match = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(value);
  ensure(match, "INVALID_RELEASE_VERSION");
  const [major, minor, patch] = match.slice(1).map(Number);
  const versionCode = major * 1_000_000 + minor * 1_000 + patch;
  ensure(
    major <= 2099 && minor <= 999 && patch <= 999 && versionCode > 0,
    "INVALID_RELEASE_VERSION",
  );
  return { versionName: value, versionCode };
}

export function releaseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ReleaseError("INVALID_RELEASE_API_ORIGIN");
  }
  ensure(
    url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        url.hostname,
      ) &&
      !url.hostname.endsWith(".invalid") &&
      !url.hostname.endsWith(".localhost") &&
      !/^[\d.]+$/.test(url.hostname),
    "INVALID_RELEASE_API_ORIGIN",
  );
  return url;
}

async function command(file, args, run = execute, code = "ANDROID_RELEASE_TOOL_FAILED") {
  try {
    const result = await run(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const output = typeof result === "string" ? result : result?.stdout;
    ensure(typeof output === "string", code);
    return output;
  } catch {
    throw new ReleaseError(code);
  }
}

export async function verifyGithubGates(
  { repository, commitSha, token },
  { fetch: request = globalThis.fetch } = {},
) {
  ensure(
    typeof repository === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) &&
      SHA.test(commitSha ?? ""),
    "INVALID_GITHUB_RELEASE_IDENTITY",
  );
  ensure(typeof token === "string" && token.trim() !== "", "GITHUB_TOKEN_REQUIRED");
  for (const workflow of ["ci.yml", "android.yml"]) {
    const url = new URL(
      `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs`,
    );
    url.searchParams.set("event", "push");
    url.searchParams.set("head_sha", commitSha);
    url.searchParams.set("per_page", "100");
    let response;
    try {
      response = await request(url.toString(), {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ReleaseError("GITHUB_RELEASE_GATE_TRANSPORT_FAILED");
    }
    ensure(response.status === 200, "GITHUB_RELEASE_GATE_HTTP_FAILED");
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ReleaseError("GITHUB_RELEASE_GATE_INVALID_RESPONSE");
    }
    ensure(Array.isArray(payload?.workflow_runs), "GITHUB_RELEASE_GATE_INVALID_RESPONSE");
    const runs = payload.workflow_runs
      .filter(
        (run) =>
          run?.head_sha === commitSha &&
          run.event === "push" &&
          run.head_branch === "main" &&
          Number.isSafeInteger(run.id) &&
          run.id > 0,
      )
      .toSorted((left, right) => right.id - left.id);
    ensure(runs.length > 0, "GITHUB_RELEASE_GATE_MISSING");
    ensure(
      runs[0].status === "completed" && runs[0].conclusion === "success",
      "GITHUB_RELEASE_GATE_NOT_GREEN",
    );
  }
}

export async function verifyReleaseInput(
  env,
  { run = execute, fetch: request = globalThis.fetch } = {},
) {
  ensure(SHA.test(env.RELEASE_SHA ?? ""), "INVALID_RELEASE_COMMIT");
  let version;
  let mode;
  if (env.RELEASE_EVENT === "workflow_dispatch") {
    ensure(env.RELEASE_REF === "refs/heads/main", "MANUAL_RELEASE_REQUIRES_MAIN");
    version = releaseVersion(env.RELEASE_VERSION);
    mode = env.RELEASE_MODE || "build-only";
  } else if (env.RELEASE_EVENT === "push") {
    ensure(
      typeof env.RELEASE_REF === "string" && env.RELEASE_REF.startsWith("refs/tags/android-v"),
      "INVALID_RELEASE_TAG",
    );
    version = releaseVersion(env.RELEASE_REF.slice("refs/tags/android-v".length));
    mode = "publish";
  } else {
    throw new ReleaseError("INVALID_RELEASE_EVENT");
  }
  ensure(mode === "build-only" || mode === "publish", "INVALID_RELEASE_MODE");
  const origin = releaseOrigin(env.API_ORIGIN);
  const commitSha = (
    await command(
      "git",
      ["rev-parse", "--verify", `${env.RELEASE_SHA}^{commit}`],
      run,
      "INVALID_RELEASE_COMMIT",
    )
  ).trim();
  ensure(commitSha === env.RELEASE_SHA, "RELEASE_COMMIT_MISMATCH");
  if (env.RELEASE_EVENT === "push") {
    const tagSha = (
      await command(
        "git",
        ["rev-parse", "--verify", `${env.RELEASE_REF}^{commit}`],
        run,
        "INVALID_RELEASE_TAG",
      )
    ).trim();
    ensure(tagSha === commitSha, "RELEASE_TAG_COMMIT_MISMATCH");
  }
  await command(
    "git",
    ["merge-base", "--is-ancestor", commitSha, "refs/remotes/origin/main"],
    run,
    "RELEASE_COMMIT_NOT_ON_MAIN",
  );
  const notesPath = `ops/rustore/notes/${version.versionName}.txt`;
  const notes = await command(
    "git",
    ["show", `${commitSha}:${notesPath}`],
    run,
    "RELEASE_NOTES_REQUIRED",
  );
  ensure(
    notes.trim() !== "" && notes.length <= 5_000 && !notes.includes("\0"),
    "INVALID_RELEASE_NOTES",
  );
  await verifyGithubGates(
    { repository: env.RELEASE_REPOSITORY, commitSha, token: env.GITHUB_TOKEN },
    { fetch: request },
  );
  return { ...version, commitSha, mode, apiHost: origin.hostname, notesPath };
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
      match[1],
      match[3].replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&"),
    ]),
  );
}

export function verifyManifest(
  { applicationId, versionCode, versionName, debuggable, manifest },
  expected,
) {
  const version = releaseVersion(expected.versionName);
  const origin = releaseOrigin(expected.apiOrigin);
  ensure(Number(expected.versionCode) === version.versionCode, "RELEASE_VERSION_CODE_MISMATCH");
  ensure(applicationId.trim() === PACKAGE_NAME, "APK_PACKAGE_MISMATCH");
  ensure(
    versionCode.trim() === String(version.versionCode) &&
      versionName.trim() === version.versionName,
    "APK_VERSION_MISMATCH",
  );
  ensure(debuggable.trim() === "false", "APK_DEBUGGABLE_FORBIDDEN");
  const application = attributes(manifest.match(/<application\b[^>]*>/)?.[0] ?? "");
  ensure(application["android:testOnly"] !== "true", "APK_TEST_ONLY_FORBIDDEN");
  ensure(!/amoveago-debug/i.test(manifest), "APK_DEBUG_AUTH_FORBIDDEN");
  const sdk = attributes(manifest.match(/<uses-sdk\b[^>]*>/)?.[0] ?? "");
  ensure(
    sdk["android:minSdkVersion"] === "24" && sdk["android:targetSdkVersion"] === "36",
    "APK_SDK_MISMATCH",
  );
  const filters = [...manifest.matchAll(/<intent-filter\b([^>]*)>([\s\S]*?)<\/intent-filter\s*>/g)];
  const linked = filters.some(([, header, body]) => {
    const data = [...body.matchAll(/<data\b[^>]*>/g)].map((match) => attributes(match[0]));
    return (
      attributes(header)["android:autoVerify"] === "true" &&
      /android:name=["']android\.intent\.action\.VIEW["']/.test(body) &&
      /android:name=["']android\.intent\.category\.BROWSABLE["']/.test(body) &&
      /android:name=["']android\.intent\.category\.DEFAULT["']/.test(body) &&
      data.some((item) => item["android:scheme"] === "https") &&
      data.some((item) => item["android:host"] === origin.hostname) &&
      data.some(
        (item) =>
          item["android:pathPrefix"] === "/auth/android" ||
          item["android:path"] === "/auth/android",
      )
    );
  });
  ensure(linked, "APK_AUTH_APP_LINK_MISMATCH");
}

export function signerFingerprint(output, expected) {
  const digests = [
    ...output.matchAll(/^Signer #(\d+) certificate SHA-256 digest:\s*([a-fA-F0-9]{64})\s*$/gm),
  ];
  ensure(
    digests.length === 1 && digests[0][1] === "1" && /Number of signers:\s*1\b/.test(output),
    "APK_SINGLE_SIGNER_REQUIRED",
  );
  const fingerprint = digests[0][2].toUpperCase().match(/../g).join(":");
  if (expected)
    ensure(
      FINGERPRINT.test(expected) && fingerprint === expected.toUpperCase(),
      "APK_SIGNER_MISMATCH",
    );
  return fingerprint;
}

export async function verifyWebArtifact(webDir, apiOrigin) {
  const origin = releaseOrigin(apiOrigin).origin;
  let html;
  let files;
  try {
    html = await readFile(join(webDir, "index.html"), "utf8");
    files = await readdir(join(webDir, "assets"), { recursive: true });
  } catch {
    throw new ReleaseError("ANDROID_WEB_ARTIFACT_REQUIRED");
  }
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const csp = metas.filter(
    (meta) => meta["http-equiv"]?.toLowerCase() === "content-security-policy",
  );
  ensure(csp.length === 1, "ANDROID_WEB_CSP_REQUIRED");
  const directives = csp[0].content?.split(";").map((item) => item.trim()) ?? [];
  const connectDirectives = directives.filter((item) => item.startsWith("connect-src "));
  ensure(connectDirectives.length === 1, "ANDROID_WEB_API_ORIGIN_MISMATCH");
  const connections = connectDirectives[0].split(/\s+/).slice(1);
  ensure(
    connections?.length === 2 && connections.includes("'self'") && connections.includes(origin),
    "ANDROID_WEB_API_ORIGIN_MISMATCH",
  );
  ensure(directives.includes("script-src 'self'"), "ANDROID_WEB_PROFILE_MISMATCH");
  ensure(
    !metas.some(
      (meta) =>
        meta.name === "a-move-ago-android-debug-auth" &&
        meta.content?.trim().toLowerCase() === "enabled",
    ),
    "ANDROID_WEB_DEBUG_AUTH_FORBIDDEN",
  );
  ensure(
    /<script\b[^>]*type=["']module["'][^>]*src=["']\/assets\//.test(html) &&
      !/\/a-move-ago\/assets\//.test(html),
    "ANDROID_WEB_PROFILE_MISMATCH",
  );
  const scripts = files.filter((file) => file.endsWith(".js"));
  ensure(scripts.length > 0, "ANDROID_WEB_BUNDLE_REQUIRED");
  const code = (
    await Promise.all(scripts.map((file) => readFile(join(webDir, "assets", file), "utf8")))
  ).join("\n");
  ensure(/Capacitor/.test(code), "ANDROID_WEB_NATIVE_RUNTIME_REQUIRED");
  ensure(
    !/telegram-web-app\.js/i.test(`${html}\n${code}`),
    "ANDROID_WEB_TELEGRAM_BOOTSTRAP_FORBIDDEN",
  );
  return { html, assets: files.filter((file) => /\.(?:js|css)$/.test(file)) };
}

export async function verifyApk(input, { run = execute } = {}) {
  const version = releaseVersion(input.versionName);
  const origin = releaseOrigin(input.apiOrigin);
  ensure(Number(input.versionCode) === version.versionCode, "RELEASE_VERSION_CODE_MISMATCH");
  ensure(
    typeof input.apkPath === "string" &&
      input.apkPath !== "" &&
      typeof input.sdkRoot === "string" &&
      input.sdkRoot !== "",
    "APK_VERIFIER_PATHS_REQUIRED",
  );
  const apk = resolve(input.apkPath);
  let bytes;
  try {
    bytes = await readFile(apk);
  } catch {
    throw new ReleaseError("RELEASE_APK_REQUIRED");
  }
  ensure(bytes.length > 0, "RELEASE_APK_REQUIRED");
  const signer = join(input.sdkRoot, "build-tools", "36.0.0", "apksigner");
  const analyzer = join(input.sdkRoot, "cmdline-tools", "latest", "bin", "apkanalyzer");
  const signatures = await command(
    signer,
    ["verify", "--verbose", "--print-certs", apk],
    run,
    "APK_SIGNATURE_INVALID",
  );
  const certificateSha256 = signerFingerprint(signatures, input.expectedCertificateSha256);
  const outputs = [];
  for (const task of ["application-id", "version-code", "version-name", "debuggable", "print"]) {
    outputs.push(
      await command(analyzer, ["manifest", task, apk], run, "APK_MANIFEST_INSPECTION_FAILED"),
    );
  }
  verifyManifest(
    {
      applicationId: outputs[0],
      versionCode: outputs[1],
      versionName: outputs[2],
      debuggable: outputs[3],
      manifest: outputs[4],
    },
    input,
  );
  const webDir = input.webDir ?? "apps/client/dist/android";
  const { html, assets } = await verifyWebArtifact(webDir, origin.origin);
  const packagedIndex = await command(
    "unzip",
    ["-p", apk, "assets/public/index.html"],
    run,
    "APK_WEB_ASSET_INSPECTION_FAILED",
  );
  ensure(packagedIndex === html, "APK_WEB_ASSET_MISMATCH");
  for (const file of assets) {
    const packaged = await command(
      "unzip",
      ["-p", apk, `assets/public/assets/${file}`],
      run,
      "APK_WEB_ASSET_INSPECTION_FAILED",
    );
    ensure(
      packaged === (await readFile(join(webDir, "assets", file), "utf8")),
      "APK_WEB_ASSET_MISMATCH",
    );
  }
  return {
    packageName: PACKAGE_NAME,
    ...version,
    certificateSha256,
    apkSha256: createHash("sha256").update(bytes).digest("hex"),
    apiOrigin: origin.origin,
  };
}

export async function verifyAssetLinks(
  { apiOrigin, certificateSha256 },
  { fetch: request = globalThis.fetch } = {},
) {
  const origin = releaseOrigin(apiOrigin);
  ensure(FINGERPRINT.test(certificateSha256 ?? ""), "INVALID_ANDROID_CERTIFICATE_FINGERPRINT");
  let response;
  try {
    response = await request(`${origin.origin}/.well-known/assetlinks.json`, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ReleaseError("ANDROID_ASSET_LINKS_TRANSPORT_FAILED");
  }
  ensure(response.status === 200, "ANDROID_ASSET_LINKS_HTTP_FAILED");
  let statements;
  try {
    statements = await response.json();
  } catch {
    throw new ReleaseError("ANDROID_ASSET_LINKS_INVALID");
  }
  const matched =
    Array.isArray(statements) &&
    statements.some(
      (statement) =>
        Array.isArray(statement?.relation) &&
        statement.relation.includes("delegate_permission/common.handle_all_urls") &&
        statement.target?.namespace === "android_app" &&
        statement.target.package_name === PACKAGE_NAME &&
        Array.isArray(statement.target.sha256_cert_fingerprints) &&
        statement.target.sha256_cert_fingerprints.some(
          (item) =>
            typeof item === "string" && item.toUpperCase() === certificateSha256.toUpperCase(),
        ),
    );
  ensure(matched, "ANDROID_ASSET_LINKS_SIGNER_MISMATCH");
}

export async function prepareKeystore(env) {
  for (const name of [
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
  ]) {
    ensure(
      typeof env[name] === "string" && env[name].trim() !== "",
      "ANDROID_RELEASE_SIGNING_CREDENTIALS_REQUIRED",
    );
  }
  ensure(
    typeof env.RUNNER_TEMP === "string" &&
      env.RUNNER_TEMP !== "" &&
      !/[\r\n]/.test(env.RUNNER_TEMP),
    "RUNNER_TEMP_REQUIRED",
  );
  const encoded = env.ANDROID_KEYSTORE_BASE64.replace(/\s/g, "");
  ensure(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    "INVALID_ANDROID_KEYSTORE_BASE64",
  );
  const bytes = Buffer.from(encoded, "base64");
  ensure(
    bytes.length > 0 && bytes.length <= 10 * 1024 * 1024 && bytes.toString("base64") === encoded,
    "INVALID_ANDROID_KEYSTORE_BASE64",
  );
  const path = join(resolve(env.RUNNER_TEMP), "rustore-release.keystore");
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    throw new ReleaseError("ANDROID_KEYSTORE_PREPARATION_FAILED");
  }
  return path;
}

async function outputs(path, values) {
  if (!path) return;
  const lines = Object.entries(values)
    .map(([key, value]) => {
      ensure(
        /^[a-z_][a-z0-9_]*$/.test(key) && !/[\r\n]/.test(String(value)),
        "INVALID_RELEASE_OUTPUT",
      );
      return `${key}=${value}\n`;
    })
    .join("");
  await appendFile(path, lines);
}

export async function main(args = process.argv.slice(2), env = process.env, options = {}) {
  ensure(args.length === 1, "INVALID_ANDROID_RELEASE_COMMAND");
  switch (args[0]) {
    case "verify-input": {
      const result = await verifyReleaseInput(env, options);
      await outputs(env.GITHUB_OUTPUT, {
        commit_sha: result.commitSha,
        version_name: result.versionName,
        version_code: result.versionCode,
        mode: result.mode,
        api_host: result.apiHost,
        notes_path: result.notesPath,
      });
      console.log(
        `Release input verified: ${result.versionName} (${result.versionCode}), ${result.mode}.`,
      );
      return;
    }
    case "prepare-keystore": {
      const path = await prepareKeystore(env);
      ensure(env.GITHUB_ENV, "GITHUB_ENV_REQUIRED");
      await appendFile(env.GITHUB_ENV, `ANDROID_KEYSTORE_PATH=${path}\n`);
      console.log("Release keystore prepared.");
      return;
    }
    case "verify-apk": {
      const result = await verifyApk(
        {
          apkPath: env.ANDROID_APK_PATH,
          sdkRoot: env.ANDROID_SDK_ROOT,
          versionName: env.VERSION_NAME,
          versionCode: env.VERSION_CODE,
          apiOrigin: env.API_ORIGIN,
          webDir: env.ANDROID_WEB_DIR,
          expectedCertificateSha256: env.ANDROID_EXPECTED_CERTIFICATE_SHA256,
        },
        options,
      );
      const metadataPath =
        env.RELEASE_METADATA_PATH ?? join(env.RUNNER_TEMP ?? ".", "android-release-metadata.json");
      await mkdir(dirname(metadataPath), { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      await outputs(env.GITHUB_OUTPUT, {
        apk_path: resolve(env.ANDROID_APK_PATH),
        metadata_path: resolve(metadataPath),
        certificate_sha256: result.certificateSha256,
        apk_sha256: result.apkSha256,
      });
      console.log(
        `Verified release APK: ${result.packageName} ${result.versionName} (${result.versionCode}).`,
      );
      console.log(`Certificate SHA-256: ${result.certificateSha256}`);
      console.log(`APK SHA-256: ${result.apkSha256}`);
      return;
    }
    case "verify-links": {
      await verifyAssetLinks(
        {
          apiOrigin: env.API_ORIGIN,
          certificateSha256: env.ANDROID_CERTIFICATE_SHA256,
        },
        options,
      );
      console.log("Production Android App Link matches the signed APK.");
      return;
    }
    case "cleanup": {
      ensure(typeof env.RUNNER_TEMP === "string" && env.RUNNER_TEMP !== "", "RUNNER_TEMP_REQUIRED");
      await rm(join(resolve(env.RUNNER_TEMP), "rustore-release.keystore"), { force: true });
      return;
    }
    default:
      throw new ReleaseError("INVALID_ANDROID_RELEASE_COMMAND");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof ReleaseError ? error.message : "ANDROID_RELEASE_FAILED");
    process.exitCode = 1;
  });
}
