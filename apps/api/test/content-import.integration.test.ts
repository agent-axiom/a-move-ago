import { env } from "cloudflare:workers";
import type { PuzzlePrivate } from "@a-move-ago/api-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../../tools/src/canonical-json";
import {
  buildImportPlan,
  type ContentCaseSource,
  type D1Statement,
  type ImportPlan,
} from "../../../tools/src/import-plan";
import type { Env } from "../src/env";
import { makePuzzleFixture } from "./fixtures/content";

const testEnv = env as Env;
const tables = [
  "content_imports",
  "daily_case_puzzles",
  "puzzle_hints",
  "puzzle_solutions",
  "daily_cases",
  "puzzles",
] as const;

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: string[] = [],
): Promise<T[]> {
  return (
    await testEnv.DB.prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
}

async function executeBatch(statements: D1Statement[]) {
  return await testEnv.DB.batch(
    statements.map((statement) => testEnv.DB.prepare(statement.sql).bind(...statement.params)),
  );
}

async function planFor(source: ContentCaseSource): Promise<ImportPlan> {
  return await buildImportPlan(source, await sha256Hex(canonicalJson(source)));
}

async function importAndPublish(source: ContentCaseSource): Promise<ImportPlan> {
  const plan = await planFor(source);
  await executeBatch(plan.draftStatements);
  await executeBatch(plan.publishStatements);
  return plan;
}

function puzzle(logicalId = "immutable-puzzle", version = 1): PuzzlePrivate {
  const fixture = makePuzzleFixture({
    rowId: `${logicalId}:v${version}`,
    contentKey: logicalId,
    publicId: logicalId,
    version,
  });
  return {
    public: fixture.public,
    acceptedSolutions: [fixture.solution],
    hints: ["A pawn changed files.", "Restore the missing pawn."],
    contradictionExplanations: {
      WRONG_COLOR: "The moving side is wrong.",
      NOT_THE_LAST_MOVE: "That reconstruction conflicts with the evidence.",
    },
  };
}

function firstPuzzle(value: ContentCaseSource): PuzzlePrivate {
  const result = value.puzzles[0];
  if (!result) throw new Error("Expected a puzzle");
  return result;
}

function firstSolution(value: PuzzlePrivate): PuzzlePrivate["acceptedSolutions"][number] {
  const result = value.acceptedSolutions[0];
  if (!result) throw new Error("Expected an accepted solution");
  return result;
}

function source(
  options: {
    caseId?: string;
    date?: string;
    slug?: string;
    logicalId?: string;
    version?: number;
  } = {},
): ContentCaseSource {
  return {
    case: {
      id: options.caseId ?? "case-original",
      date: options.date ?? "2026-08-03",
      slug: options.slug ?? "case-original",
      title: "The immutable case",
      generatedAt: 1_785_715_200,
    },
    puzzles: [puzzle(options.logicalId, options.version)],
  };
}

async function databaseSnapshot(): Promise<Record<string, Record<string, unknown>[]>> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of tables) {
    rows[table] = await query(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return rows;
}

beforeEach(async () => {
  for (const table of tables) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("content import against D1", () => {
  it("replays one published digest without changing any stored bytes", async () => {
    const value = source();
    const plan = await importAndPublish(value);
    const published = await databaseSnapshot();

    await executeBatch(plan.draftStatements);
    await executeBatch(plan.publishStatements);
    expect(await databaseSnapshot()).toEqual(published);
    expect(await query("SELECT digest FROM content_imports")).toEqual([{ digest: plan.digest }]);
    expect(await query("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rolls back genuinely new child rows at the final case-id import guard", async () => {
    const original = source();
    const originalPlan = await importAndPublish(original);
    const extended = structuredClone(original);
    extended.puzzles.push(puzzle("fresh-second-puzzle"));
    const extendedPlan = await planFor(extended);
    expect(extended.case).toEqual(original.case);
    expect(extendedPlan.digest).not.toBe(originalPlan.digest);

    // Adding a puzzle changes the prescribed act total. Normalize the existing link so every
    // preceding immutable upsert succeeds and the batch reaches the final case-id uniqueness guard.
    await testEnv.DB.prepare(
      "UPDATE daily_case_puzzles SET act_json = ? WHERE case_id = ? AND position = 1",
    )
      .bind(canonicalJson({ index: 1, total: 2 }), original.case.id)
      .run();
    const beforeConflict = await databaseSnapshot();

    await expect(executeBatch(extendedPlan.draftStatements)).rejects.toThrow(
      /UNIQUE constraint failed: content_imports\.case_id/,
    );

    expect(await databaseSnapshot()).toEqual(beforeConflict);
    const freshRowId = "fresh-second-puzzle:v1";
    expect(await query("SELECT id FROM puzzles WHERE id = ?", [freshRowId])).toEqual([]);
    expect(
      await query("SELECT id FROM puzzle_solutions WHERE puzzle_id = ?", [freshRowId]),
    ).toEqual([]);
    expect(
      await query("SELECT puzzle_id FROM puzzle_hints WHERE puzzle_id = ?", [freshRowId]),
    ).toEqual([]);
    expect(
      await query("SELECT puzzle_id FROM daily_case_puzzles WHERE puzzle_id = ?", [freshRowId]),
    ).toEqual([]);
  });

  it("rejects reuse of an exact retired puzzle version and rolls back the new case", async () => {
    const original = source();
    await importAndPublish(original);
    const retiredRowId = `${firstPuzzle(original).public.id}:v${firstPuzzle(original).public.version}`;
    await testEnv.DB.prepare("UPDATE puzzles SET status = 'retired' WHERE id = ?")
      .bind(retiredRowId)
      .run();
    const retired = await databaseSnapshot();
    const reuse = source({
      caseId: "case-reusing-retired",
      date: "2026-08-04",
      slug: "case-reusing-retired",
    });
    const reusePlan = await planFor(reuse);

    await expect(executeBatch(reusePlan.draftStatements)).rejects.toThrow(
      /NOT NULL constraint failed: puzzles\.content_digest/,
    );
    expect(await databaseSnapshot()).toEqual(retired);
    expect(await query("SELECT id FROM daily_cases WHERE id = ?", [reuse.case.id])).toEqual([]);
  });

  it("rejects publish when a linked puzzle retires between phases", async () => {
    const value = source();
    const plan = await planFor(value);
    await executeBatch(plan.draftStatements);
    const rowId = `${firstPuzzle(value).public.id}:v${firstPuzzle(value).public.version}`;
    await testEnv.DB.prepare("UPDATE puzzles SET status = 'retired' WHERE id = ?")
      .bind(rowId)
      .run();
    const beforePublish = await databaseSnapshot();

    await expect(executeBatch(plan.publishStatements)).rejects.toThrow(
      /NOT NULL constraint failed: puzzles\.status/,
    );

    expect(await databaseSnapshot()).toEqual(beforePublish);
    expect(
      await query("SELECT status, published_at FROM daily_cases WHERE id = ?", [value.case.id]),
    ).toEqual([{ status: "draft", published_at: null }]);
    expect(
      await query("SELECT published_at FROM content_imports WHERE digest = ?", [plan.digest]),
    ).toEqual([{ published_at: null }]);
  });

  it("requires a puzzle membership before publishing a draft case", async () => {
    const value = source();
    const plan = await planFor(value);
    await executeBatch(plan.draftStatements);
    await testEnv.DB.prepare("DELETE FROM daily_case_puzzles WHERE case_id = ?")
      .bind(value.case.id)
      .run();
    const beforePublish = await databaseSnapshot();

    await expect(executeBatch(plan.publishStatements)).rejects.toThrow(
      /NOT NULL constraint failed: daily_cases\.status/,
    );
    expect(await databaseSnapshot()).toEqual(beforePublish);
    expect(
      await query("SELECT status, published_at FROM daily_cases WHERE id = ?", [value.case.id]),
    ).toEqual([{ status: "draft", published_at: null }]);
    expect(
      await query("SELECT published_at FROM content_imports WHERE digest = ?", [plan.digest]),
    ).toEqual([{ published_at: null }]);
  });

  it("rejects a daily case retired between draft and publish", async () => {
    const value = source();
    const plan = await planFor(value);
    await executeBatch(plan.draftStatements);
    await testEnv.DB.prepare(
      "UPDATE daily_cases SET status = 'retired', published_at = ? WHERE id = ?",
    )
      .bind(String(value.case.generatedAt), value.case.id)
      .run();
    const beforePublish = await databaseSnapshot();

    await expect(executeBatch(plan.publishStatements)).rejects.toThrow(
      /NOT NULL constraint failed: daily_cases\.status/,
    );
    expect(await databaseSnapshot()).toEqual(beforePublish);
  });

  it("stores v1 and v2 physically while public payloads keep one stable logical ID", async () => {
    await importAndPublish(source({ logicalId: "stable-public-id", version: 1 }));
    await importAndPublish(
      source({
        caseId: "case-version-two",
        date: "2026-08-04",
        slug: "case-version-two",
        logicalId: "stable-public-id",
        version: 2,
      }),
    );

    const rows = await query<{
      id: string;
      content_key: string;
      version: number;
      public_json: string;
    }>("SELECT id, content_key, version, public_json FROM puzzles ORDER BY version");

    expect(rows.map((row) => [row.id, row.content_key, row.version])).toEqual([
      ["stable-public-id:v1", "stable-public-id", 1],
      ["stable-public-id:v2", "stable-public-id", 2],
    ]);
    expect(rows.map((row) => JSON.parse(row.public_json).id)).toEqual([
      "stable-public-id",
      "stable-public-id",
    ]);
    expect(await query("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("publishes only puzzles linked to the imported case", async () => {
    const unrelated = puzzle("unrelated-draft");
    await testEnv.DB.prepare(
      `INSERT INTO puzzles
        (id, content_key, version, content_digest, status, public_json,
         provenance, license, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    )
      .bind(
        "unrelated-draft:v1",
        "unrelated-draft",
        "1",
        await sha256Hex(canonicalJson(unrelated)),
        canonicalJson(unrelated.public),
        unrelated.public.provenance,
        unrelated.public.license,
        "1785715200",
        "1785715200",
      )
      .run();

    await importAndPublish(source());

    expect(
      await query<{ id: string; status: string }>("SELECT id, status FROM puzzles ORDER BY id"),
    ).toEqual([
      { id: "immutable-puzzle:v1", status: "published" },
      { id: "unrelated-draft:v1", status: "draft" },
    ]);
  });

  it.each([
    ["public data", (value: PuzzlePrivate) => (value.public.title = "Changed public title")],
    [
      "an accepted solution",
      (value: PuzzlePrivate) => (firstSolution(value).explanation = "Changed accepted explanation"),
    ],
    [
      "a contradiction explanation",
      (value: PuzzlePrivate) =>
        (value.contradictionExplanations.WRONG_COLOR = "Changed contradiction"),
    ],
    ["a hint", (value: PuzzlePrivate) => (value.hints[0] = "Changed immutable hint")],
  ])(
    "rolls back a new case that reuses an immutable puzzle version with changed %s",
    async (_label, mutate) => {
      const original = source();
      await importAndPublish(original);
      const published = await databaseSnapshot();
      const changed = source({
        caseId: "case-conflicting",
        date: "2026-08-04",
        slug: "case-conflicting",
      });
      mutate(firstPuzzle(changed));
      const changedPlan = await planFor(changed);

      await expect(executeBatch(changedPlan.draftStatements)).rejects.toThrow();
      expect(await databaseSnapshot()).toEqual(published);
      expect(await query("SELECT id FROM daily_cases WHERE id = ?", [changed.case.id])).toEqual([]);
    },
  );

  it("treats reordered contradiction keys as the same per-puzzle and whole-document import", async () => {
    const left = source();
    const right = structuredClone(left);
    firstPuzzle(right).contradictionExplanations = {
      NOT_THE_LAST_MOVE: "That reconstruction conflicts with the evidence.",
      WRONG_COLOR: "The moving side is wrong.",
    };
    const leftPlan = await importAndPublish(left);
    const published = await databaseSnapshot();
    const rightPlan = await planFor(right);
    const puzzleDigest = (plan: ImportPlan) =>
      plan.draftStatements.find((statement) => statement.sql.includes("INSERT INTO puzzles"))
        ?.params[3];

    expect(rightPlan.digest).toBe(leftPlan.digest);
    expect(puzzleDigest(rightPlan)).toBe(puzzleDigest(leftPlan));
    await executeBatch(rightPlan.draftStatements);
    await executeBatch(rightPlan.publishStatements);
    expect(await databaseSnapshot()).toEqual(published);
  });
});
