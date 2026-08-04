import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: write-worker-secrets --target <path>";
const secretNames = [
  "SESSION_PEPPER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OIDC_CLIENT_SECRET",
] as const;

type SecretEnvironment = Record<string, string | undefined>;

type SecretsRuntime = {
  cwd: string;
  env: SecretEnvironment;
  writeFile: (
    path: string,
    contents: string,
    options: { encoding: "utf8"; mode: number },
  ) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  log: (message: string) => void;
};

function requiredSecret(env: SecretEnvironment, name: (typeof secretNames)[number]): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing or blank required secret: ${name}`);
  }
  return value;
}

export function workerSecretsDocument(env: SecretEnvironment): string {
  const sessionPepper = requiredSecret(env, "SESSION_PEPPER");
  const telegramBotToken = requiredSecret(env, "TELEGRAM_BOT_TOKEN");
  const telegramOidcClientSecret = requiredSecret(env, "TELEGRAM_OIDC_CLIENT_SECRET");
  if (Buffer.byteLength(sessionPepper.trim(), "utf8") < 32) {
    throw new Error("SESSION_PEPPER must contain at least 32 bytes");
  }
  return `${JSON.stringify(
    {
      SESSION_PEPPER: sessionPepper,
      TELEGRAM_BOT_TOKEN: telegramBotToken,
      TELEGRAM_OIDC_CLIENT_SECRET: telegramOidcClientSecret,
    },
    null,
    2,
  )}\n`;
}

function parseTarget(args: readonly string[]): string {
  if (
    args.length !== 2 ||
    args[0] !== "--target" ||
    args[1] === undefined ||
    args[1].trim() === "" ||
    args[1].startsWith("--")
  ) {
    throw new Error(usage);
  }
  return args[1];
}

export async function runWriteWorkerSecrets(
  args: readonly string[],
  overrides: Partial<SecretsRuntime> = {},
): Promise<void> {
  const target = parseTarget(args);
  const runtime: SecretsRuntime = {
    cwd: process.cwd(),
    env: process.env,
    writeFile: async (path, contents, options) => await writeFile(path, contents, options),
    chmod: async (path, mode) => await chmod(path, mode),
    log: (message) => console.log(message),
    ...overrides,
  };
  const targetPath = resolve(runtime.cwd, target);
  const document = workerSecretsDocument(runtime.env);
  await runtime.writeFile(targetPath, document, { encoding: "utf8", mode: 0o600 });
  await runtime.chmod(targetPath, 0o600);
  runtime.log(targetPath);
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await runWriteWorkerSecrets(process.argv.slice(2));
  } catch {
    console.error("Worker secret materialization failed");
    process.exitCode = 1;
  }
}
