import { constants, createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const origin = "https://public-api.rustore.ru";
const packageName = "com.agentaxiom.amoveago";
const versionPath = `/public/v1/application/${packageName}/version`;
const pageSize = 100;
const maxPages = 20;
const maxApkBytes = 5_000_000_000;
const statuses = new Set([
  "ACTIVE",
  "PARTIAL_ACTIVE",
  "READY_FOR_PUBLICATION",
  "PREVIOUS_ACTIVE",
  "ARCHIVED",
  "REJECTED_BY_MODERATOR",
  "TAKEN_FOR_MODERATION",
  "MODERATION",
  "AUTO_CHECK",
  "AUTO_CHECK_FAILED",
  "DRAFT",
  "DELETED_DRAFT",
  "REJECTED_BY_SECURITY",
]);
const submittedStatuses = new Set(["TAKEN_FOR_MODERATION", "MODERATION", "AUTO_CHECK", "ACTIVE"]);
const pendingStatuses = new Set([
  "TAKEN_FOR_MODERATION",
  "MODERATION",
  "AUTO_CHECK",
  "READY_FOR_PUBLICATION",
  "PARTIAL_ACTIVE",
]);
const timeouts = {
  auth: 15_000,
  list: 15_000,
  create: 30_000,
  upload: 120_000,
  commit: 30_000,
  verify: 15_000,
};

export class RuStorePublishError extends Error {
  constructor(code, stage, versionId, reviewRequired = false) {
    super(code);
    this.name = "RuStorePublishError";
    this.code = code;
    this.stage = stage;
    if (versionId !== undefined) this.versionId = versionId;
    this.reviewRequired = reviewRequired;
  }
}

function ensure(condition, code, stage = "validation", versionId, reviewRequired = false) {
  if (!condition) throw new RuStorePublishError(code, stage, versionId, reviewRequired);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function versionCode(value) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  ensure(positiveInteger(value) && value <= 2_147_483_647, "INVALID_VERSION_CODE");
  return value;
}

async function artifact(apkPath, notesPath) {
  ensure(
    typeof apkPath === "string" && extname(apkPath).toLowerCase() === ".apk",
    "INVALID_APK_PATH",
  );
  ensure(typeof notesPath === "string" && notesPath.length > 0, "INVALID_NOTES_PATH");
  try {
    const apkInfo = await stat(apkPath);
    ensure(apkInfo.isFile() && apkInfo.size > 0 && apkInfo.size <= maxApkBytes, "INVALID_APK_SIZE");
    const notesInfo = await stat(notesPath);
    ensure(
      notesInfo.isFile() && notesInfo.size > 0 && notesInfo.size <= 20_000,
      "INVALID_NOTES_SIZE",
    );
    const notes = new TextDecoder("utf-8", { fatal: true })
      .decode(await readFile(notesPath))
      .trim();
    ensure(notes.length > 0 && notes.length <= 5_000 && !notes.includes("\0"), "INVALID_NOTES");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(apkPath)) hash.update(chunk);
    const blob = await openAsBlob(apkPath, { type: "application/vnd.android.package-archive" });
    ensure(blob.size === apkInfo.size, "APK_CHANGED");
    return { notes, blob, bytes: apkInfo.size, sha256: hash.digest("hex") };
  } catch (error) {
    if (error instanceof RuStorePublishError) throw error;
    throw new RuStorePublishError("ARTIFACT_READ_FAILED", "validation");
  }
}

function credentials(keyId, privateKeyBase64) {
  ensure(
    typeof keyId === "string" &&
      keyId.length > 0 &&
      keyId.length <= 256 &&
      !/[\s\p{Cc}]/u.test(keyId),
    "INVALID_KEY_ID",
  );
  ensure(
    typeof privateKeyBase64 === "string" &&
      privateKeyBase64.length > 0 &&
      privateKeyBase64.length <= 32_768 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(privateKeyBase64),
    "INVALID_PRIVATE_KEY",
  );
  try {
    const der = Buffer.from(privateKeyBase64, "base64");
    ensure(der.toString("base64") === privateKeyBase64, "INVALID_PRIVATE_KEY");
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    ensure(
      key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength >= 2048,
      "INVALID_PRIVATE_KEY",
    );
    return key;
  } catch {
    throw new RuStorePublishError("INVALID_PRIVATE_KEY", "validation");
  }
}

function parseVersion(value, stage, versionId) {
  const reviewRequired = stage === "verify";
  ensure(
    object(value) && positiveInteger(value.versionId) && statuses.has(value.versionStatus),
    "VERSION_RESPONSE_INVALID",
    stage,
    versionId,
    reviewRequired,
  );
  const emptyDraft = ["DRAFT", "DELETED_DRAFT"].includes(value.versionStatus);
  ensure(
    (emptyDraft && value.versionCode == null) || positiveInteger(value.versionCode),
    "VERSION_RESPONSE_INVALID",
    stage,
    versionId,
    reviewRequired,
  );
  ensure(
    (emptyDraft && value.versionName == null) ||
      (typeof value.versionName === "string" && value.versionName.length > 0),
    "VERSION_RESPONSE_INVALID",
    stage,
    versionId,
    reviewRequired,
  );
  return value;
}

/** Updates an existing production release; the first release is created in RuStore Console. */
export async function publishRuStore(
  options = {},
  { fetch: request = globalThis.fetch, now = () => new Date() } = {},
) {
  let stage = "validation";
  let createdVersionId;
  try {
    ensure(object(options), "INVALID_OPTIONS");
    const { keyId, privateKeyBase64, apkPath, notesPath, versionName } = options;
    const code = versionCode(options.versionCode);
    ensure(
      typeof versionName === "string" &&
        versionName.length > 0 &&
        versionName.length <= 255 &&
        versionName.trim() === versionName &&
        !/[\p{Cc}]/u.test(versionName),
      "INVALID_VERSION_NAME",
    );
    const key = credentials(keyId, privateKeyBase64);
    const apk = await artifact(apkPath, notesPath);
    let token;
    let tokenExpiresAt;

    async function call(path, method, body, callStage) {
      stage = callStage;
      const mutation = ["create", "upload", "commit"].includes(stage);
      const failure = (suffix) =>
        new RuStorePublishError(
          `RUSTORE_${stage.toUpperCase()}_${suffix}`,
          stage,
          createdVersionId,
          mutation || stage === "verify",
        );
      if (token) {
        ensure(
          now().getTime() + timeouts[stage] < tokenExpiresAt,
          "AUTH_TOKEN_EXPIRED",
          stage,
          createdVersionId,
          createdVersionId !== undefined,
        );
      }
      let response;
      try {
        response = await request(`${origin}${path}`, {
          method,
          headers: {
            accept: "application/json",
            ...(token ? { "Public-Token": token } : {}),
            ...(body !== undefined && !(body instanceof FormData)
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body === undefined
            ? {}
            : { body: body instanceof FormData ? body : JSON.stringify(body) }),
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(timeouts[stage]),
        });
      } catch {
        throw failure("TRANSPORT_FAILED");
      }
      if (!(response.status >= 200 && response.status < 300) || response.redirected) {
        throw failure("HTTP_FAILED");
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw failure("JSON_FAILED");
      }
      const needsBody = ["auth", "list", "create", "verify"].includes(stage);
      if (
        !object(payload) ||
        payload.code !== "OK" ||
        (needsBody && !Object.hasOwn(payload, "body"))
      ) {
        throw failure("REJECTED");
      }
      return payload.body;
    }

    const timestamp = now().toISOString();
    const signature = sign("sha512", Buffer.from(keyId + timestamp, "utf8"), {
      key,
      padding: constants.RSA_PKCS1_PADDING,
    }).toString("base64");
    const auth = await call("/public/auth/", "POST", { keyId, timestamp, signature }, "auth");
    ensure(
      object(auth) &&
        typeof auth.jwe === "string" &&
        auth.jwe.length > 0 &&
        !/[\s\p{Cc}]/u.test(auth.jwe) &&
        positiveInteger(auth.ttl) &&
        auth.ttl <= 900,
      "AUTH_RESPONSE_INVALID",
      "auth",
    );
    token = auth.jwe;
    tokenExpiresAt = now().getTime() + auth.ttl * 1_000;

    async function versions(filter) {
      const values = [];
      const ids = new Set();
      let totals;
      for (let page = 0; page < maxPages; page += 1) {
        const body = await call(
          `${versionPath}?page=${page}&size=${pageSize}&filterTestingType=${filter}`,
          "GET",
          undefined,
          "list",
        );
        ensure(
          object(body) &&
            Array.isArray(body.content) &&
            body.pageNumber === page &&
            positiveInteger(body.pageSize) &&
            body.pageSize <= pageSize &&
            Number.isSafeInteger(body.totalElements) &&
            body.totalElements >= 0 &&
            Number.isSafeInteger(body.totalPages) &&
            body.totalPages >= 0 &&
            body.totalPages <= maxPages &&
            body.totalPages === Math.ceil(body.totalElements / body.pageSize) &&
            body.content.length <= body.pageSize,
          "VERSION_PAGINATION_INVALID",
          "list",
        );
        const currentTotals = `${body.pageSize}:${body.totalElements}:${body.totalPages}`;
        ensure(totals === undefined || totals === currentTotals, "VERSION_LIST_CHANGED", "list");
        totals = currentTotals;
        for (const value of body.content) {
          const version = parseVersion(value, "list");
          ensure(!ids.has(version.versionId), "VERSION_LIST_CHANGED", "list");
          ids.add(version.versionId);
          values.push(version);
        }
        if (page + 1 >= body.totalPages) {
          ensure(values.length === body.totalElements, "VERSION_PAGINATION_INVALID", "list");
          return values;
        }
      }
      throw new RuStorePublishError("VERSION_PAGINATION_INVALID", "list");
    }

    const all = await versions("ALL");
    const draft = all.find((value) => value.versionStatus === "DRAFT");
    ensure(!draft, "EXISTING_DRAFT_REQUIRES_CONSOLE", "preflight", draft?.versionId, true);
    // ALL protects alpha drafts as well; RELEASE establishes a production baseline independently.
    const releases = await versions("RELEASE");
    ensure(
      releases.every((release) =>
        all.some(
          (value) =>
            value.versionId === release.versionId &&
            value.versionCode === release.versionCode &&
            value.versionName === release.versionName &&
            value.versionStatus === release.versionStatus,
        ),
      ),
      "VERSION_LIST_CHANGED",
      "preflight",
    );
    const summary = (version, alreadySubmitted) => ({
      ok: true,
      packageName,
      versionId: version.versionId,
      versionCode: code,
      versionName,
      status: version.versionStatus,
      alreadySubmitted,
      outcome: alreadySubmitted ? "existing_version_already_submitted" : "submitted_for_moderation",
      localApkSha256: apk.sha256,
      bytes: apk.bytes,
      ...(alreadySubmitted ? { remoteArtifactVerified: false } : {}),
    });
    const existing = releases.find(
      (value) => value.versionCode === code && value.versionName === versionName,
    );
    if (existing && submittedStatuses.has(existing.versionStatus)) return summary(existing, true);
    ensure(
      releases.some((value) => value.versionStatus === "ACTIVE"),
      "FIRST_VERSION_REQUIRED",
      "preflight",
    );
    const pending = all.find((value) => pendingStatuses.has(value.versionStatus));
    ensure(!pending, "RELEASE_IN_PROGRESS", "preflight", pending?.versionId, true);
    ensure(
      all.every((value) => value.versionCode == null || value.versionCode < code),
      "VERSION_CODE_NOT_INCREMENTED",
      "preflight",
    );

    const newId = await call(
      versionPath,
      "POST",
      { whatsNew: apk.notes, publishType: "INSTANTLY" },
      "create",
    );
    ensure(
      positiveInteger(newId) && !all.some((value) => value.versionId === newId),
      "CREATE_RESPONSE_UNCONFIRMED",
      "create",
      undefined,
      true,
    );
    createdVersionId = newId;
    const form = new FormData();
    form.append("file", apk.blob, "app-release.apk");
    await call(`${versionPath}/${newId}/apk?isMainApk=true`, "POST", form, "upload");
    await call(`${versionPath}/${newId}/commit?priorityUpdate=0`, "POST", undefined, "commit");
    const verification = await call(`${versionPath}?ids=${newId}`, "GET", undefined, "verify");
    ensure(
      object(verification) &&
        Array.isArray(verification.content) &&
        verification.content.length === 1,
      "SUBMISSION_UNCONFIRMED",
      "verify",
      newId,
      true,
    );
    const submitted = parseVersion(verification.content[0], "verify", newId);
    ensure(
      submitted.versionId === newId &&
        submitted.versionName === versionName &&
        submitted.versionCode === code &&
        submittedStatuses.has(submitted.versionStatus),
      "SUBMISSION_UNCONFIRMED",
      "verify",
      newId,
      true,
    );
    return summary(submitted, false);
  } catch (error) {
    if (error instanceof RuStorePublishError) throw error;
    throw new RuStorePublishError(
      "RUSTORE_PUBLISH_FAILED",
      stage,
      createdVersionId,
      createdVersionId !== undefined,
    );
  }
}

export async function runCli(args, env = process.env, runtime = {}) {
  try {
    ensure(args.length === 0, "UNEXPECTED_ARGUMENTS");
    const result = await publishRuStore(
      {
        keyId: env.RUSTORE_KEY_ID,
        privateKeyBase64: env.RUSTORE_PRIVATE_KEY_BASE64,
        apkPath: env.RUSTORE_APK_PATH,
        versionName: env.RUSTORE_VERSION_NAME,
        versionCode: env.RUSTORE_VERSION_CODE,
        notesPath: env.RUSTORE_NOTES_PATH,
      },
      runtime,
    );
    (runtime.log ?? console.log)(JSON.stringify(result));
    return 0;
  } catch (error) {
    const safe =
      error instanceof RuStorePublishError
        ? error
        : new RuStorePublishError("RUSTORE_PUBLISH_FAILED", "validation");
    (runtime.errorLog ?? console.error)(
      JSON.stringify({
        ok: false,
        code: safe.code,
        stage: safe.stage,
        ...(safe.versionId === undefined ? {} : { versionId: safe.versionId }),
        ...(safe.reviewRequired
          ? {
              action:
                "Review this version in RuStore Console before rerunning. Do not recreate or delete drafts automatically.",
            }
          : {}),
      }),
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
