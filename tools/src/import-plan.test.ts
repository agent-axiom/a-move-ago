import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildImportPlan, type ContentCaseSource } from "./import-plan";
import { validateContentDocument } from "./validate-content";

const sampleUrl = new URL("../../content/samples/2026-08-03.json", import.meta.url);

async function sampleSource(): Promise<ContentCaseSource> {
  return validateContentDocument(await readFile(sampleUrl, "utf8"));
}

function firstPuzzle(source: ContentCaseSource): ContentCaseSource["puzzles"][number] {
  const puzzle = source.puzzles[0];
  if (!puzzle) throw new Error("Expected a sample puzzle");
  return puzzle;
}

function sensitiveValues(source: ContentCaseSource): string[] {
  const puzzle = firstPuzzle(source);
  const solution = puzzle.acceptedSolutions[0];
  if (!solution) throw new Error("Expected a sample solution");
  return [
    source.case.id,
    source.case.date,
    source.case.slug,
    source.case.title,
    puzzle.public.id,
    puzzle.public.title,
    puzzle.public.prompt,
    puzzle.public.postFen,
    puzzle.public.provenance,
    puzzle.public.license,
    solution.previousFen,
    solution.forwardSan,
    solution.explanation,
    ...puzzle.hints,
    ...Object.values(puzzle.contradictionExplanations),
  ];
}

describe("buildImportPlan", () => {
  it("uses only parameterized immutable upserts and string parameters", async () => {
    const source = await sampleSource();
    const plan = await buildImportPlan(source, "sha256-digest");
    const statements = [...plan.draftStatements, ...plan.publishStatements];
    const sql = statements.map((statement) => statement.sql).join("\n");

    for (const value of sensitiveValues(source)) {
      expect(sql).not.toContain(value);
    }
    expect(plan.draftStatements.flatMap((statement) => statement.params)).toContain(
      "The missing pawn",
    );
    expect(plan.publishStatements.map((statement) => statement.sql).join("\n")).toMatch(
      /UPDATE daily_cases SET[\s\S]*THEN 'published'/,
    );
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(
      statements
        .flatMap((statement) => statement.params)
        .every((value) => typeof value === "string"),
    ).toBe(true);
  });

  it("uses versioned physical puzzle IDs while retaining the logical public ID", async () => {
    const source = await sampleSource();
    const puzzle = firstPuzzle(source);
    puzzle.public.id = "stable-logical-id";
    puzzle.public.version = 2;

    const plan = await buildImportPlan(source, "a".repeat(64));
    const puzzleInsert = plan.draftStatements.find((statement) =>
      statement.sql.includes("INSERT INTO puzzles"),
    );
    const solutionInsert = plan.draftStatements.find((statement) =>
      statement.sql.includes("INSERT INTO puzzle_solutions"),
    );

    expect(puzzleInsert?.params[0]).toBe("stable-logical-id:v2");
    expect(JSON.parse(puzzleInsert?.params[4] ?? "null")).toMatchObject({
      id: "stable-logical-id",
      version: 2,
    });
    expect(solutionInsert?.params[1]).toBe("stable-logical-id:v2");
  });

  it("guards retired draft conflicts and validates every linked status during publish", async () => {
    const plan = await buildImportPlan(await sampleSource(), "a".repeat(64));
    const puzzleDraft = plan.draftStatements.find((statement) =>
      statement.sql.includes("INSERT INTO puzzles"),
    );
    const [puzzlePublish, casePublish] = plan.publishStatements;

    expect(puzzleDraft?.sql).toContain("puzzles.status IN ('draft', 'published')");
    expect(puzzlePublish?.sql).toMatch(/status = CASE[\s\S]*ELSE NULL END/);
    expect(puzzlePublish?.sql).not.toContain("AND status = 'draft'");
    expect(casePublish?.sql).toMatch(/NOT EXISTS[\s\S]*daily_case_puzzles/);
    expect(casePublish?.sql).toMatch(/status = CASE[\s\S]*ELSE NULL END/);
    expect(plan.publishStatements).toHaveLength(3);
  });

  it("gives reordered object keys the same puzzle digest and changed content a new digest", async () => {
    const left = await sampleSource();
    const right = structuredClone(left);
    const changed = structuredClone(left);
    firstPuzzle(left).contradictionExplanations = {
      WRONG_COLOR: "The moving side is wrong.",
      NOT_THE_LAST_MOVE: "The reconstruction conflicts with the evidence.",
    };
    firstPuzzle(right).contradictionExplanations = {
      NOT_THE_LAST_MOVE: "The reconstruction conflicts with the evidence.",
      WRONG_COLOR: "The moving side is wrong.",
    };
    firstPuzzle(changed).contradictionExplanations = {
      WRONG_COLOR: "A genuinely different explanation.",
      NOT_THE_LAST_MOVE: "The reconstruction conflicts with the evidence.",
    };

    const [leftPlan, rightPlan, changedPlan] = await Promise.all([
      buildImportPlan(left, "a".repeat(64)),
      buildImportPlan(right, "a".repeat(64)),
      buildImportPlan(changed, "a".repeat(64)),
    ]);
    const puzzleDigest = (plan: Awaited<ReturnType<typeof buildImportPlan>>) =>
      plan.draftStatements.find((statement) => statement.sql.includes("INSERT INTO puzzles"))
        ?.params[3];

    expect(puzzleDigest(leftPlan)).toBe(puzzleDigest(rightPlan));
    expect(puzzleDigest(changedPlan)).not.toBe(puzzleDigest(leftPlan));
  });
});
