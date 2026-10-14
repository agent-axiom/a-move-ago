import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Hex } from "./canonical-json";
import { buildImportPlan, type D1Statement } from "./import-plan";
import { validateContentDocument } from "./validate-content";

const apiDirectory = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const configPath = join(apiDirectory, "wrangler.jsonc");
const stateDirectory = join(apiDirectory, ".wrangler", "state");
const sampleUrl = new URL("../../content/samples/2026-08-03.json", import.meta.url);
const requireFromApi = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const usage = "Usage: seed-local (no arguments; public sample, today in UTC, local D1 only)";

export type LocalSeedSummary = {
  date: string;
  caseId: string;
  puzzleIds: string[];
};

type LocalSeedRuntime = {
  now: () => Date;
  readSample: () => Promise<string>;
  runWrangler: (args: string[]) => Promise<void>;
  log: (message: string) => void;
};

function renderStatements(statements: D1Statement[]): string {
  return statements
    .map(({ sql, params }) => {
      let index = 0;
      const rendered = sql.replace(/\?/g, () => {
        const value = params[index++];
        if (value === undefined) throw new Error("Local seed SQL has a missing parameter.");
        // Hex literals preserve quotes, question marks, Unicode and newlines without SQL interpolation.
        return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
      });
      if (index !== params.length) throw new Error("Local seed SQL has extra parameters.");
      return `${rendered};`;
    })
    .join("\n\n");
}

export async function prepareLocalSeed(
  sampleText: string,
  now: Date,
): Promise<LocalSeedSummary & { sql: string }> {
  const source = validateContentDocument(sampleText);
  const date = now.toISOString().slice(0, 10);
  const prefix = `dev-sample-${date}`;
  source.case = {
    id: prefix,
    date,
    slug: prefix,
    title: `Development sample: ${source.case.title}`,
    generatedAt: Date.parse(`${date}T00:00:00.000Z`) / 1_000,
  };
  for (const puzzle of source.puzzles) {
    puzzle.public.id = `${prefix}-${puzzle.public.id}`;
    puzzle.public.title = `Development sample: ${puzzle.public.title}`;
  }
  const content = validateContentDocument(JSON.stringify(source));
  const digest = await sha256Hex(canonicalJson(content));
  const plan = await buildImportPlan(content, digest);
  return {
    date,
    caseId: content.case.id,
    puzzleIds: content.puzzles.map((puzzle) => puzzle.public.id),
    sql: renderStatements([...plan.draftStatements, ...plan.publishStatements]),
  };
}

async function runInstalledWrangler(args: string[]): Promise<void> {
  // Resolve the installed executable directly: never ask npx to download a missing CLI.
  const packageDirectory = dirname(requireFromApi.resolve("wrangler/package.json"));
  const executable = join(packageDirectory, "bin", "wrangler.js");
  await new Promise<void>((resolveChild, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: apiDirectory,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveChild();
      else reject(new Error(`Local Wrangler command failed with exit code ${code}.`));
    });
  });
}

export async function runSeedLocal(
  args: readonly string[],
  overrides: Partial<LocalSeedRuntime> = {},
): Promise<LocalSeedSummary> {
  if (args.length !== 0) throw new Error(usage);
  const runtime: LocalSeedRuntime = {
    now: () => new Date(),
    readSample: async () => await readFile(sampleUrl, "utf8"),
    runWrangler: runInstalledWrangler,
    log: (message) => console.log(message),
    ...overrides,
  };
  const { sql, ...summary } = await prepareLocalSeed(await runtime.readSample(), runtime.now());
  const directory = await mkdtemp(join(tmpdir(), "a-move-ago-local-seed-"));
  try {
    const filename = join(directory, "development-sample.sql");
    await writeFile(filename, sql, { encoding: "utf8", mode: 0o600 });
    const localOptions = ["--local", "--config", configPath, "--persist-to", stateDirectory];
    await runtime.runWrangler(["d1", "migrations", "apply", "a-move-ago", ...localOptions]);
    await runtime.runWrangler([
      "d1",
      "execute",
      "a-move-ago",
      ...localOptions,
      "--file",
      filename,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  runtime.log(`Development sample seeded in local D1 only: ${JSON.stringify(summary)}`);
  return summary;
}

const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await runSeedLocal(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local sample seed failed.");
    process.exitCode = 1;
  }
}
