import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { LocalizationBundle } from "@a-move-ago/api-contract";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./canonical-json";
import { buildImportPlan, type D1Statement } from "./import-plan";
import {
  type LocalizationRequest,
  localizationSourceStatement,
  prepareLocalizationImport,
} from "./localization-import";
import { encryptContentEnvelope, runPrivateContentTransfer } from "./private-content";
import { type ContentCase, validateContentDocument } from "./validate-content";

const canary = "PRIVATE_LOCALIZATION_CANARY_隐藏_НЕ_ПЕЧАТАТЬ";
const now = Date.parse("2026-10-15T12:00:00Z") / 1000;
const env = {
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  D1_DATABASE_ID: "00000000-0000-0000-0000-000000000001",
  CLOUDFLARE_API_TOKEN: "private-cloudflare-token",
};
function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function harness(count = 2, extraSolution = false) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../apps/api/migrations/", import.meta.url);
  for (const filename of (await readdir(migrations))
    .filter((path) => path.endsWith(".sql"))
    .sort()) {
    db.exec(await readFile(new URL(filename, migrations), "utf8"));
  }
  const sample = validateContentDocument(
    await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8"),
  );
  const originals: ContentCase[] = [];
  const cases: LocalizationBundle["cases"] = [];
  for (let index = 0; index < count; index += 1) {
    const original = structuredClone(sample);
    const date = new Date(Date.parse("2026-09-10T00:00:00Z") + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    original.case = {
      id: `original-${date}`,
      date,
      slug: `original-${date}`,
      title: "Original title",
      generatedAt: now,
    };
    for (const [puzzleIndex, puzzle] of original.puzzles.entries()) {
      puzzle.public.id = `original-puzzle-${index}-${puzzleIndex}`;
      puzzle.acceptedSolutions[0]!.explanation = canary;
      if (extraSolution) {
        const second = structuredClone(puzzle.acceptedSolutions[0]!);
        second.explanation = `${canary} second ordered explanation`;
        puzzle.acceptedSolutions.push(second);
      }
      puzzle.contradictionExplanations = { NOT_THE_LAST_MOVE: "Original contradiction" };
    }
    const sourceDigest = digest(original);
    const plan = await buildImportPlan(original, sourceDigest);
    for (const statement of [...plan.draftStatements, ...plan.publishStatements])
      db.prepare(statement.sql).run(...statement.params);
    const translate = (locale: "ru" | "zh") => ({
      title: locale === "ru" ? "Историческая задача" : "历史棋题",
      puzzles: original.puzzles.map((puzzle) => ({
        id: puzzle.public.id,
        version: puzzle.public.version,
        title: locale === "ru" ? "Последний ход" : "最后一步",
        prompt: locale === "ru" ? "Восстановите последний ход." : "还原最后一步。",
        provenance: "Original A MOVE AGO composition",
        license: "All Rights Reserved",
        hints: puzzle.hints.map((_, hintIndex) => `${locale} hint ${hintIndex + 1}`),
        explanations: puzzle.acceptedSolutions.map(() => `${locale} ${canary}`),
        contradictionExplanations: { NOT_THE_LAST_MOVE: `${locale} contradiction` },
      })),
    });
    originals.push(original);
    cases.push({
      caseId: original.case.id,
      sourceDigest,
      translations: { ru: translate("ru"), zh: translate("zh") },
    });
  }
  const request: LocalizationRequest = {
    keyId: `localize-2026-09-10-${originals.at(-1)!.case.date}-ru-zh-v1`,
    purpose: "localization",
    from: "2026-09-10",
    through: originals.at(-1)!.case.date,
    locales: ["ru", "zh"],
  };
  const state = {
    request: request as unknown,
    envelope: undefined as unknown,
    now,
    contentWrites: 0,
    failLocalizationBatch: 0,
    localizationBatches: 0,
    batchSizes: [] as number[],
  };
  const query = async (statements: D1Statement[]): Promise<unknown[][]> =>
    statements.map((statement) => {
      if (statement.sql.startsWith("SELECT"))
        return db.prepare(statement.sql).all(...statement.params);
      state.contentWrites += 1;
      db.prepare(statement.sql).run(...statement.params);
      return [];
    });
  const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    expect(init?.cache).toBe("no-store");
    const { batch } = JSON.parse(String(init?.body)) as { batch: D1Statement[] };
    expect(batch.length).toBeLessThanOrEqual(100);
    state.batchSizes.push(batch.length);
    if (
      batch.some(
        (statement) =>
          statement.sql.startsWith("INSERT INTO case_localizations") ||
          statement.sql.startsWith("INSERT INTO puzzle_localizations"),
      )
    ) {
      state.localizationBatches += 1;
      if (state.localizationBatches === state.failLocalizationBatch) throw new Error(canary);
    }
    db.exec("BEGIN");
    try {
      const rows = await query(batch);
      db.exec("COMMIT");
      return new Response(
        JSON.stringify({
          success: true,
          result: rows.map((results) => ({ success: true, results })),
        }),
      );
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  const importCase = vi.fn();
  const overrides = {
    cwd: "/repo",
    env,
    fetch: fetchMock as typeof fetch,
    now: () => state.now,
    importCase,
    readFile: async (path: string) => {
      if (path.endsWith("content-key-request.json")) return JSON.stringify(state.request);
      if (state.envelope !== undefined) return JSON.stringify(state.envelope);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  const bundle: LocalizationBundle = { version: 1, cases };
  async function prepare(payload: unknown = bundle) {
    const recipient = await runPrivateContentTransfer(overrides);
    if (recipient.mode !== "bootstrap") throw new Error("Expected bootstrap");
    state.envelope = encryptContentEnvelope(payload, recipient);
    return recipient;
  }
  return {
    db,
    state,
    originals,
    bundle,
    request,
    query,
    overrides,
    importCase,
    fetchMock,
    prepare,
  };
}

describe("private content localizations", () => {
  it("reconstructs the exact immutable source document through actual SQLite JSON aggregation", async () => {
    const h = await harness();
    try {
      const statement = localizationSourceStatement(h.originals[0]!.case.id);
      const row = h.db.prepare(statement.sql).get(...statement.params) as { source_json: string };
      expect(JSON.parse(row.source_json)).toEqual(h.originals[0]);
      expect(digest(JSON.parse(row.source_json))).toBe(h.bundle.cases[0]!.sourceDigest);
    } finally {
      h.db.close();
    }
  });

  it("imports all 65 cases in both languages, including future published sources, without changing English", async () => {
    const h = await harness(65);
    try {
      await h.prepare();
      const result = await runPrivateContentTransfer(h.overrides);
      expect(result).toMatchObject({
        mode: "published",
        purpose: "localization",
        cases: 65,
        puzzles: 65,
        locales: ["ru", "zh"],
        caseRows: 130,
        puzzleRows: 130,
      });
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM case_localizations").get()).toMatchObject({
        count: 130,
      });
      expect(
        h.db.prepare("SELECT COUNT(*) AS count FROM puzzle_localizations").get(),
      ).toMatchObject({ count: 130 });
      for (const original of h.originals) {
        const statement = localizationSourceStatement(original.case.id);
        const row = h.db.prepare(statement.sql).get(...statement.params) as { source_json: string };
        expect(JSON.parse(row.source_json)).toEqual(original);
      }
      const key = h.db
        .prepare("SELECT private_key, completed_summary FROM ops_content_transfer_keys")
        .get();
      expect(key?.private_key).toBeNull();
      expect(String(key?.completed_summary)).not.toContain(canary);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(JSON.stringify(h.state.envelope)).not.toContain(canary);
      expect(h.importCase).not.toHaveBeenCalled();
      expect(Math.max(...h.state.batchSizes)).toBe(100);
    } finally {
      h.db.close();
    }
  });

  it.each([
    "source-digest",
    "source-mutated",
    "source-private-mutated",
    "schema-missing",
    "missing-zh",
    "wrong-id",
    "wrong-version",
    "missing-hint",
    "missing-explanation",
    "contradiction-key",
    "extra-private-field",
    "missing-date",
  ])("rejects %s in the final case before claiming or writing translations", async (kind) => {
    const h = await harness();
    try {
      const payload = structuredClone(h.bundle) as unknown as { cases: Record<string, unknown>[] };
      const final = payload.cases.at(-1)!;
      const translations = final.translations as Record<
        string,
        { puzzles: Record<string, unknown>[] }
      >;
      const puzzle = translations.zh!.puzzles[0]!;
      if (kind === "source-digest") final.sourceDigest = "b".repeat(64);
      if (kind === "source-mutated") h.db.exec("UPDATE daily_cases SET title = 'tampered source'");
      if (kind === "source-private-mutated")
        h.db.exec(
          'UPDATE puzzle_hints SET payload_json = \'{"text":"tampered private source"}\' WHERE level = 1',
        );
      if (kind === "schema-missing") h.db.exec("DROP TABLE puzzle_localizations");
      if (kind === "missing-zh") delete translations.zh;
      if (kind === "wrong-id") puzzle.id = "other-puzzle";
      if (kind === "wrong-version") puzzle.version = 99;
      if (kind === "missing-hint") (puzzle.hints as string[]).pop();
      if (kind === "missing-explanation") (puzzle.explanations as string[]).pop();
      if (kind === "contradiction-key") puzzle.contradictionExplanations = {};
      if (kind === "extra-private-field") puzzle.previousFen = canary;
      if (kind === "missing-date") payload.cases.pop();
      await h.prepare({ version: 1, ...payload });
      const writes = h.state.contentWrites;
      const error = await runPrivateContentTransfer(h.overrides).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(canary);
      expect(h.state.contentWrites).toBe(writes);
      expect(
        h.db.prepare("SELECT envelope_digest FROM ops_content_transfer_keys").get()
          ?.envelope_digest,
      ).toBeNull();
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM case_localizations").get()).toMatchObject({
        count: 0,
      });
    } finally {
      h.db.close();
    }
  });

  it.each([
    "physical-row-id",
    "solution-order-gap",
    "hint-level-gap",
    "inconsistent-contradictions",
  ])(
    "rejects a source with %s even when reconstructed content and digest still match",
    async (kind) => {
      const h = await harness(2, kind === "inconsistent-contradictions");
      try {
        const final = h.originals.at(-1)!;
        const puzzle = final.puzzles[0]!;
        const rowId = `${puzzle.public.id}:v${puzzle.public.version}`;
        if (kind === "physical-row-id") {
          const changedId = `${rowId}-unexpected`;
          h.db.exec("PRAGMA foreign_keys = OFF");
          h.db.prepare("UPDATE puzzles SET id = ? WHERE id = ?").run(changedId, rowId);
          for (const table of ["daily_case_puzzles", "puzzle_solutions", "puzzle_hints"]) {
            h.db
              .prepare(`UPDATE ${table} SET puzzle_id = ? WHERE puzzle_id = ?`)
              .run(changedId, rowId);
          }
          h.db.exec("PRAGMA foreign_keys = ON");
          expect(h.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        }
        if (kind === "solution-order-gap") {
          h.db.prepare("UPDATE puzzle_solutions SET sort_order = 2 WHERE puzzle_id = ?").run(rowId);
        }
        if (kind === "hint-level-gap") {
          h.db.prepare("UPDATE puzzle_hints SET level = level + 10 WHERE puzzle_id = ?").run(rowId);
        }
        if (kind === "inconsistent-contradictions") {
          h.db
            .prepare(
              "UPDATE puzzle_solutions SET contradiction_json = '{}' WHERE puzzle_id = ? AND sort_order = 2",
            )
            .run(rowId);
        }
        const sourceStatement = localizationSourceStatement(final.case.id);
        const source = h.db.prepare(sourceStatement.sql).get(...sourceStatement.params) as {
          source_json: string;
          source_shape_valid: number;
        };
        expect(JSON.parse(source.source_json)).toEqual(final);
        expect(digest(JSON.parse(source.source_json))).toBe(h.bundle.cases.at(-1)!.sourceDigest);
        expect(source.source_shape_valid).toBe(0);
        await h.prepare();
        const writes = h.state.contentWrites;
        await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
          "PRIVATE_CONTENT_TRANSFER_FAILED",
        );
        expect(h.state.contentWrites).toBe(writes);
        expect(
          h.db.prepare("SELECT envelope_digest FROM ops_content_transfer_keys").get()
            ?.envelope_digest,
        ).toBeNull();
        expect(
          h.db.prepare("SELECT COUNT(*) AS count FROM case_localizations").get(),
        ).toMatchObject({ count: 0 });
      } finally {
        h.db.close();
      }
    },
  );

  it("preflights a conflict in the final translated puzzle before any write", async () => {
    const h = await harness();
    try {
      const plan = await prepareLocalizationImport(h.bundle, h.request, h.query);
      await plan.import();
      h.db.exec(
        "UPDATE puzzle_localizations SET public_json = '{\"title\":\"conflict\"}' WHERE locale = 'zh'",
      );
      await h.prepare();
      const writes = h.state.contentWrites;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
        "EXISTING_LOCALIZATION_CONFLICT",
      );
      expect(h.state.contentWrites).toBe(writes);
      expect(
        h.db.prepare("SELECT envelope_digest FROM ops_content_transfer_keys").get()
          ?.envelope_digest,
      ).toBeNull();
    } finally {
      h.db.close();
    }
  });

  it("retries only the identical encrypted batch after partial import and wipes the key on completion", async () => {
    const h = await harness(65);
    try {
      const recipient = await h.prepare();
      h.state.failLocalizationBatch = 2;
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
        "PRIVATE_CONTENT_TRANSFER_FAILED",
      );
      expect(h.db.prepare("SELECT COUNT(*) AS count FROM case_localizations").get()).toMatchObject({
        count: 50,
      });
      expect(
        h.db.prepare("SELECT private_key FROM ops_content_transfer_keys").get()?.private_key,
      ).toContain("PRIVATE KEY");
      const originalEnvelope = h.state.envelope;
      h.state.envelope = encryptContentEnvelope(h.bundle, recipient);
      await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow(
        "TRANSFER_ENVELOPE_MISMATCH",
      );
      h.state.envelope = originalEnvelope;
      h.state.now += 86_400;
      const result = await runPrivateContentTransfer(h.overrides);
      expect(result).toMatchObject({ purpose: "localization", caseRows: 130, puzzleRows: 130 });
      expect(
        h.db.prepare("SELECT private_key FROM ops_content_transfer_keys").get()?.private_key,
      ).toBeNull();
      h.state.now += 10 * 86_400;
      const writes = h.state.contentWrites;
      expect(await runPrivateContentTransfer(h.overrides)).toEqual({
        ...result,
        alreadyCompleted: true,
      });
      expect(h.state.contentWrites).toBe(writes);
    } finally {
      h.db.close();
    }
  });

  it("binds purpose, both dates, and both languages to the authenticated key before D1", async () => {
    const h = await harness();
    try {
      const changes = [
        { keyId: h.request.keyId },
        { ...h.request, purpose: "launch" },
        { ...h.request, from: "2026-09-11" },
        { ...h.request, through: "2026-09-12" },
        { ...h.request, locales: ["ru"] },
        { ...h.request, locales: ["zh", "ru"] },
      ];
      for (const request of changes) {
        h.state.request = request;
        await expect(runPrivateContentTransfer(h.overrides)).rejects.toThrow();
      }
      expect(h.fetchMock).not.toHaveBeenCalled();
    } finally {
      h.db.close();
    }
  });
});
