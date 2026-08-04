import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json";
import { runContentImport } from "./content-import";
import { buildImportPlan } from "./import-plan";
import { validateContentDocument } from "./validate-content";

const sampleUrl = new URL("../../content/samples/2026-08-03.json", import.meta.url);

async function sampleDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sampleUrl, "utf8")) as Record<string, unknown>;
}

function puzzleAt(document: Record<string, unknown>): Record<string, unknown> {
  const puzzles = document.puzzles as Record<string, unknown>[];
  const puzzle = puzzles[0];
  if (!puzzle) throw new Error("Expected sample puzzle");
  return puzzle;
}

function solutionAt(document: Record<string, unknown>): Record<string, unknown> {
  const solutions = puzzleAt(document).acceptedSolutions as Record<string, unknown>[];
  const solution = solutions[0];
  if (!solution) throw new Error("Expected sample solution");
  return solution;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function runEntrypoint(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./content-import.ts", import.meta.url)), ...args],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("canonical content", () => {
  it("sorts nested object keys, omits undefined members, and keeps array order", async () => {
    const canonical = canonicalJson({
      z: { omitted: undefined, b: 2, a: 1 },
      a: [{ y: 2, x: 1 }, "second"],
    });

    expect(canonical).toBe('{"a":[{"x":1,"y":2},"second"],"z":{"a":1,"b":2}}');
    expect(await sha256Hex(canonical)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has stable whole-document digests for reordered object keys", async () => {
    const left = await sampleDocument();
    const right = structuredClone(left);
    puzzleAt(left).contradictionExplanations = {
      WRONG_COLOR: "The moving side is wrong.",
      NOT_THE_LAST_MOVE: "The reconstruction conflicts with the evidence.",
    };
    puzzleAt(right).contradictionExplanations = {
      NOT_THE_LAST_MOVE: "The reconstruction conflicts with the evidence.",
      WRONG_COLOR: "The moving side is wrong.",
    };
    const validatedLeft = validateContentDocument(JSON.stringify(left));
    const validatedRight = validateContentDocument(JSON.stringify(right));
    const canonicalLeft = canonicalJson(validatedLeft);
    const canonicalRight = canonicalJson(validatedRight);

    expect(canonicalLeft).toBe(canonicalRight);
    await expect(sha256Hex(canonicalLeft)).resolves.toBe(await sha256Hex(canonicalRight));
  });

  it("changes the digest for changed explanations and preserves array order", async () => {
    const original = await sampleDocument();
    const changedExplanation = structuredClone(original);
    const reversedHints = structuredClone(original);
    solutionAt(changedExplanation).explanation = "A genuinely different explanation.";
    (puzzleAt(reversedHints).hints as unknown[]).reverse();
    const values = [original, changedExplanation, reversedHints].map((document) =>
      canonicalJson(validateContentDocument(JSON.stringify(document))),
    );
    const digests = await Promise.all(values.map(sha256Hex));

    expect(digests[1]).not.toBe(digests[0]);
    expect(digests[2]).not.toBe(digests[0]);
    expect(canonicalJson(["first", "second"])).not.toBe(canonicalJson(["second", "first"]));
  });

  it("rejects non-JSON top-level values", () => {
    expect(() => canonicalJson(undefined)).toThrow("Content is not JSON serializable");
  });
});

describe("runContentImport", () => {
  it("has no import-time network or output side effects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.resetModules();

    await import("./content-import");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("keeps private validator fields out of direct entrypoint errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a-move-ago-import-entrypoint-"));
    const filename = join(directory, "invalid-private-content.json");
    const marker = "private-forward-san-marker";
    try {
      const document = await sampleDocument();
      solutionAt(document).forwardSan = marker;
      await writeFile(filename, JSON.stringify(document));

      const result = await runEntrypoint(["--file", filename, "--dry-run"]);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain(marker);
      expect(result.stderr).not.toContain(marker);
      expect(result.stderr.trim()).toBe("Content import failed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    [],
    ["--file", "sample.json"],
    ["--file", "sample.json", "--dry-run", "--publish"],
    ["--file", "sample.json", "--dry-run", "--unknown"],
    ["--file", "one.json", "--file", "two.json", "--dry-run"],
    ["--file", "sample.json", "--dry-run", "--dry-run"],
    ["--file", "--dry-run"],
    ["--file", "", "--dry-run"],
    ["sample.json", "--dry-run"],
  ])("rejects invalid or ambiguous arguments: %j", async (...args) => {
    await expect(runContentImport(args as string[])).rejects.toThrow("Usage:");
  });

  it("performs a dry-run without reading credentials or making network calls", async () => {
    const source = await readFile(sampleUrl, "utf8");
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch;
    const log = vi.fn();
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get() {
          throw new Error("credentials must not be read");
        },
      },
    );

    const summary = await runContentImport(["--file", "sample.json", "--dry-run"], {
      cwd: "/content",
      readFile: async () => source,
      fetch: fetchMock,
      env,
      log,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toEqual(summary);
    expect(Object.keys(summary).sort()).toEqual([
      "caseId",
      "digest",
      "draftStatementCount",
      "publishStatementCount",
      "puzzleIds",
    ]);
    expect(JSON.stringify(summary)).not.toContain("The white e-pawn captured");
  });

  it.each(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"] as const)(
    "fails for missing %s before fetch",
    async (missing) => {
      const source = await readFile(sampleUrl, "utf8");
      const fetchMock = vi.fn(async () =>
        jsonResponse({ success: true, result: [] }),
      ) as unknown as typeof fetch;
      const env: Record<string, string | undefined> = {
        CLOUDFLARE_API_TOKEN: "secret-token",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        D1_DATABASE_ID: "database-id",
      };
      delete env[missing];

      await expect(
        runContentImport(["--file", "sample.json", "--publish"], {
          readFile: async () => source,
          fetch: fetchMock,
          env,
          log: vi.fn(),
        }),
      ).rejects.toThrow(missing);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("publishes with exactly two ordered batches and emits only digest, IDs, and counts", async () => {
    const sourceText = await readFile(sampleUrl, "utf8");
    const validated = validateContentDocument(sourceText);
    const digest = await sha256Hex(canonicalJson(validated));
    const plan = await buildImportPlan(validated, digest);
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { batch: unknown[] };
      requestBodies.push(body);
      return jsonResponse({
        success: true,
        result: body.batch.map(() => ({ success: true })),
      });
    }) as unknown as typeof fetch;
    const log = vi.fn();

    const summary = await runContentImport(["--publish", "--file", "sample.json"], {
      readFile: async () => sourceText,
      fetch: fetchMock,
      env: {
        CLOUDFLARE_API_TOKEN: "never-print-this-token",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        D1_DATABASE_ID: "database-id",
      },
      log,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies).toEqual([
      { batch: plan.draftStatements },
      { batch: plan.publishStatements },
    ]);
    expect(summary).toEqual({
      digest,
      caseId: validated.case.id,
      puzzleIds: validated.puzzles.map((puzzle) => puzzle.public.id),
      draftStatementCount: plan.draftStatements.length,
      publishStatementCount: plan.publishStatements.length,
    });
    const output = log.mock.calls.flat().join("\n");
    const privateExplanation = validated.puzzles[0]?.acceptedSolutions[0]?.explanation;
    if (!privateExplanation) throw new Error("Expected a private solution explanation");
    expect(output).not.toContain("never-print-this-token");
    expect(output).not.toContain(privateExplanation);
  });

  it.each([
    ["top-level failure", { success: false, result: [] }],
    ["missing result", { success: true }],
    ["non-array result", { success: true, result: {} }],
    ["empty result", { success: true, result: [] }],
    ["wrong result count", { success: true, result: [{ success: true }] }],
    ["statement failure", { success: true, result: [{ success: false }] }],
  ])("does not publish after a draft %s", async (_label, draftResponse) => {
    const source = await readFile(sampleUrl, "utf8");
    const fetchMock = vi.fn(async () => jsonResponse(draftResponse)) as unknown as typeof fetch;

    await expect(
      runContentImport(["--file", "sample.json", "--publish"], {
        readFile: async () => source,
        fetch: fetchMock,
        env: {
          CLOUDFLARE_API_TOKEN: "secret-token",
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          D1_DATABASE_ID: "database-id",
        },
        log: vi.fn(),
      }),
    ).rejects.toThrow("D1 draft batch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["top-level failure", { success: false, result: [] }],
    ["missing result", { success: true }],
    ["empty result", { success: true, result: [] }],
    ["wrong result count", { success: true, result: [{ success: true }] }],
    ["statement failure", { success: true, result: [{ success: true }, { success: false }] }],
  ])("rejects a publish %s after exactly two batches", async (_label, publishResponse) => {
    const source = await readFile(sampleUrl, "utf8");
    let requestCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 2) return jsonResponse(publishResponse);
      const body = JSON.parse(String(init?.body)) as { batch: unknown[] };
      return jsonResponse({
        success: true,
        result: body.batch.map(() => ({ success: true })),
      });
    }) as unknown as typeof fetch;

    await expect(
      runContentImport(["--file", "sample.json", "--publish"], {
        readFile: async () => source,
        fetch: fetchMock,
        env: {
          CLOUDFLARE_API_TOKEN: "secret-token",
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          D1_DATABASE_ID: "database-id",
        },
        log: vi.fn(),
      }),
    ).rejects.toThrow("D1 publish batch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serialize credentials, source content, or upstream errors", async () => {
    const source = await readFile(sampleUrl, "utf8");
    const secret = "never-expose-this-value";
    const log = vi.fn();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: false,
        result: [],
        errors: [{ message: secret }],
      }),
    ) as unknown as typeof fetch;

    let failure: unknown;
    try {
      await runContentImport(["--file", "sample.json", "--publish"], {
        readFile: async () => source,
        fetch: fetchMock,
        env: {
          CLOUDFLARE_API_TOKEN: secret,
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          D1_DATABASE_ID: "database-id",
        },
        log,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe("Error: D1 draft batch failed");
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).not.toContain(solutionAt(await sampleDocument()).explanation as string);
    expect(log).not.toHaveBeenCalled();
  });
});
