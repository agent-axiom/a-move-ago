import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "./canonical-json";
import { executeD1Batch } from "./d1-http";
import { buildImportPlan } from "./import-plan";
import { validateContentDocument } from "./validate-content";

const usage = "Usage: content-import --file <path> (--dry-run | --publish)";
const credentialNames = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
] as const;

type ImportMode = "dry-run" | "publish";

type ContentImportRuntime = {
  cwd: string;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
};

export type ContentImportSummary = {
  digest: string;
  caseId: string;
  puzzleIds: string[];
  draftStatementCount: number;
  publishStatementCount: number;
};

function parseArguments(args: readonly string[]): { file: string; mode: ImportMode } {
  let file: string | undefined;
  let mode: ImportMode | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--file") {
      const value = args[index + 1];
      if (
        file !== undefined ||
        value === undefined ||
        value.length === 0 ||
        value.startsWith("--")
      ) {
        throw new Error(usage);
      }
      file = value;
      index += 1;
      continue;
    }
    if (argument === "--dry-run" || argument === "--publish") {
      const nextMode = argument.slice(2) as ImportMode;
      if (mode !== undefined) throw new Error(usage);
      mode = nextMode;
      continue;
    }
    throw new Error(usage);
  }
  if (file === undefined || mode === undefined) throw new Error(usage);
  return { file, mode };
}

function requiredCredential(
  env: Record<string, string | undefined>,
  name: (typeof credentialNames)[number],
): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required credential: ${name}`);
  return value;
}

function batchSucceeded(response: unknown, expectedResultCount: number): boolean {
  if (response === null || typeof response !== "object") return false;
  const record = response as Record<string, unknown>;
  if (record.success !== true || !Array.isArray(record.result)) return false;
  if (record.result.length !== expectedResultCount) return false;
  return record.result.every(
    (result) =>
      result !== null &&
      typeof result === "object" &&
      (result as Record<string, unknown>).success === true,
  );
}

export async function runContentImport(
  args: readonly string[],
  overrides: Partial<ContentImportRuntime> = {},
): Promise<ContentImportSummary> {
  const parsed = parseArguments(args);
  const runtime: ContentImportRuntime = {
    cwd: process.cwd(),
    readFile: async (path, encoding) => await readFile(path, encoding),
    fetch: globalThis.fetch,
    env: process.env,
    log: (message) => console.log(message),
    ...overrides,
  };
  const sourceText = await runtime.readFile(resolve(runtime.cwd, parsed.file), "utf8");
  const validated = validateContentDocument(sourceText);
  const canonical = canonicalJson(validated);
  const digest = await sha256Hex(canonical);
  const plan = await buildImportPlan(validated, digest);
  const summary: ContentImportSummary = {
    digest,
    caseId: validated.case.id,
    puzzleIds: validated.puzzles.map((puzzle) => puzzle.public.id),
    draftStatementCount: plan.draftStatements.length,
    publishStatementCount: plan.publishStatements.length,
  };

  if (parsed.mode === "dry-run") {
    runtime.log(JSON.stringify(summary));
    return summary;
  }

  const apiToken = requiredCredential(runtime.env, credentialNames[0]);
  const accountId = requiredCredential(runtime.env, credentialNames[1]);
  const databaseId = requiredCredential(runtime.env, credentialNames[2]);
  const connection = { accountId, databaseId, apiToken, fetch: runtime.fetch };
  const draftResponse = await executeD1Batch({
    ...connection,
    statements: plan.draftStatements,
  });
  if (!batchSucceeded(draftResponse, plan.draftStatements.length)) {
    throw new Error("D1 draft batch failed");
  }
  const publishResponse = await executeD1Batch({
    ...connection,
    statements: plan.publishStatements,
  });
  if (!batchSucceeded(publishResponse, plan.publishStatements.length)) {
    throw new Error("D1 publish batch failed");
  }

  runtime.log(JSON.stringify(summary));
  return summary;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await runContentImport(process.argv.slice(2));
  } catch {
    console.error("Content import failed");
    process.exitCode = 1;
  }
}
