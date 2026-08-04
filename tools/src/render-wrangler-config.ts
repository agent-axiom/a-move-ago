import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: render-wrangler-config --source <path> --target <path> --database-id <uuid> --api-origin <https-origin> --telegram-client-id <digits> --rate-limit-namespace-ids <four-comma-separated-integers> [--android-fingerprints <comma-separated-list>]";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const rateLimitSentinels = ["900000001", "900000002", "900000003", "900000004"];

export type ProductionWranglerInput = {
  databaseId: string;
  apiOrigin: string;
  telegramClientId: string;
  rateLimitNamespaceIds: string;
  androidFingerprints?: string;
};

type RenderRuntime = {
  cwd: string;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  writeFile: (
    path: string,
    contents: string,
    options: { encoding: "utf8"; mode: number },
  ) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  log: (message: string) => void;
};

type ParsedArguments = Required<ProductionWranglerInput> & {
  source: string;
  target: string;
};

const requiredInputKeys = [
  "databaseId",
  "apiOrigin",
  "telegramClientId",
  "rateLimitNamespaceIds",
] as const;
const allowedInputKeys = new Set([...requiredInputKeys, "androidFingerprints"]);

function validateInputShape(input: ProductionWranglerInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid production input");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => !allowedInputKeys.has(key))) {
    throw new Error("Invalid production input: unexpected field");
  }
  for (const key of requiredInputKeys) {
    if (!Object.hasOwn(input, key) || typeof input[key] !== "string") {
      throw new Error(`Invalid production input: ${key}`);
    }
  }
  if (
    Object.hasOwn(input, "androidFingerprints") &&
    typeof input.androidFingerprints !== "string"
  ) {
    throw new Error("Invalid production input: androidFingerprints");
  }
}

function validateApiOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid production API origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("Invalid production API origin");
  }
  return value;
}

function validateFingerprints(value: string | undefined): string {
  const fingerprints = value ?? "";
  if (fingerprints.trim() === "") return "";
  const values = fingerprints.split(",");
  if (values.some((fingerprint) => !fingerprintPattern.test(fingerprint))) {
    throw new Error("Invalid Android SHA-256 fingerprint list");
  }
  return fingerprints;
}

function validateRateLimitNamespaceIds(value: string): string[] {
  const values = value.split(",");
  if (
    values.length !== 4 ||
    values.some((id) => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Invalid Rate Limiting namespace IDs");
  }
  return values;
}

function replaceSentinel(
  source: string,
  label: string,
  pattern: RegExp,
  replacement: string,
): string {
  const matches = source.match(pattern);
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one ${label} sentinel`);
  }
  return source.replace(pattern, () => replacement);
}

export function renderWranglerConfig(source: string, input: ProductionWranglerInput): string {
  if (typeof source !== "string") throw new Error("Invalid Wrangler config source");
  validateInputShape(input);
  if (!uuidPattern.test(input.databaseId)) throw new Error("Invalid D1 database UUID");
  const apiOrigin = validateApiOrigin(input.apiOrigin);
  if (!/^[0-9]+$/.test(input.telegramClientId)) {
    throw new Error("Invalid Telegram OIDC client ID");
  }
  const fingerprints = validateFingerprints(input.androidFingerprints);
  const namespaceIds = validateRateLimitNamespaceIds(input.rateLimitNamespaceIds);

  let rendered = source;
  rendered = replaceSentinel(
    rendered,
    "D1 database ID",
    /"database_id"\s*:\s*"00000000-0000-0000-0000-000000000000"/g,
    `"database_id": "${input.databaseId}"`,
  );
  rendered = replaceSentinel(
    rendered,
    "environment",
    /"ENVIRONMENT"\s*:\s*"development"/g,
    '"ENVIRONMENT": "production"',
  );
  rendered = replaceSentinel(
    rendered,
    "Telegram client ID",
    /"TELEGRAM_OIDC_CLIENT_ID"\s*:\s*"123456789"/g,
    `"TELEGRAM_OIDC_CLIENT_ID": "${input.telegramClientId}"`,
  );
  rendered = replaceSentinel(
    rendered,
    "Telegram callback",
    /"TELEGRAM_OIDC_CALLBACK_URL"\s*:\s*"https:\/\/a-move-ago-api\.example\.invalid\/v1\/auth\/telegram\/oidc\/callback"/g,
    `"TELEGRAM_OIDC_CALLBACK_URL": "${apiOrigin}/v1/auth/telegram/oidc/callback"`,
  );
  rendered = replaceSentinel(
    rendered,
    "API origin",
    /"API_ORIGIN"\s*:\s*"https:\/\/a-move-ago-api\.example\.invalid"/g,
    `"API_ORIGIN": "${apiOrigin}"`,
  );
  rendered = replaceSentinel(
    rendered,
    "Android auth return URL",
    /"ANDROID_AUTH_RETURN_URL"\s*:\s*"amoveago-debug:\/\/auth"/g,
    `"ANDROID_AUTH_RETURN_URL": "${apiOrigin}/auth/android"`,
  );
  rendered = replaceSentinel(
    rendered,
    "Android fingerprint",
    /"ANDROID_SHA256_CERT_FINGERPRINTS"\s*:\s*""/g,
    `"ANDROID_SHA256_CERT_FINGERPRINTS": "${fingerprints}"`,
  );
  for (const [index, sentinel] of rateLimitSentinels.entries()) {
    rendered = replaceSentinel(
      rendered,
      `Rate Limiting namespace ${index + 1}`,
      new RegExp(`"namespace_id"\\s*:\\s*"${sentinel}"`, "g"),
      `"namespace_id": "${namespaceIds[index]}"`,
    );
  }

  const forbiddenMarkers = [
    "00000000-0000-0000-0000-000000000000",
    ".invalid",
    "amoveago-debug:",
    ...rateLimitSentinels,
  ];
  if (
    forbiddenMarkers.some((marker) => rendered.includes(marker)) ||
    /"ENVIRONMENT"\s*:\s*"development"/.test(rendered) ||
    /"TELEGRAM_OIDC_CLIENT_ID"\s*:\s*"123456789"/.test(rendered)
  ) {
    throw new Error("Rendered config retains a forbidden development marker");
  }
  return rendered;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const allowedFlags = new Set([
    "--source",
    "--target",
    "--database-id",
    "--api-origin",
    "--telegram-client-id",
    "--rate-limit-namespace-ids",
    "--android-fingerprints",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      !allowedFlags.has(flag) ||
      values.has(flag) ||
      value === undefined ||
      (value.trim() === "" && flag !== "--android-fingerprints") ||
      value.startsWith("--")
    ) {
      throw new Error(usage);
    }
    values.set(flag, value);
  }
  const requiredFlags = [
    "--source",
    "--target",
    "--database-id",
    "--api-origin",
    "--telegram-client-id",
    "--rate-limit-namespace-ids",
  ] as const;
  for (const flag of requiredFlags) {
    if (!values.has(flag)) throw new Error(usage);
  }
  return {
    source: values.get("--source") as string,
    target: values.get("--target") as string,
    databaseId: values.get("--database-id") as string,
    apiOrigin: values.get("--api-origin") as string,
    telegramClientId: values.get("--telegram-client-id") as string,
    rateLimitNamespaceIds: values.get("--rate-limit-namespace-ids") as string,
    androidFingerprints: values.get("--android-fingerprints") ?? "",
  };
}

export async function runRenderWranglerConfig(
  args: readonly string[],
  overrides: Partial<RenderRuntime> = {},
): Promise<void> {
  const parsed = parseArguments(args);
  const runtime: RenderRuntime = {
    cwd: process.cwd(),
    readFile: async (path, encoding) => await readFile(path, encoding),
    writeFile: async (path, contents, options) => await writeFile(path, contents, options),
    chmod: async (path, mode) => await chmod(path, mode),
    log: (message) => console.log(message),
    ...overrides,
  };
  const sourcePath = resolve(runtime.cwd, parsed.source);
  const targetPath = resolve(runtime.cwd, parsed.target);
  const source = await runtime.readFile(sourcePath, "utf8");
  const rendered = renderWranglerConfig(source, {
    databaseId: parsed.databaseId,
    apiOrigin: parsed.apiOrigin,
    telegramClientId: parsed.telegramClientId,
    rateLimitNamespaceIds: parsed.rateLimitNamespaceIds,
    androidFingerprints: parsed.androidFingerprints,
  });
  await runtime.writeFile(targetPath, rendered, { encoding: "utf8", mode: 0o600 });
  await runtime.chmod(targetPath, 0o600);
  runtime.log(targetPath);
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await runRenderWranglerConfig(process.argv.slice(2));
  } catch {
    console.error("Wrangler config rendering failed");
    process.exitCode = 1;
  }
}
