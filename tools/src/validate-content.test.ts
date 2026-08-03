import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { validateContentDirectory, validateContentDocument } from "./validate-content";

const sampleUrl = new URL("../../content/samples/2026-08-03.json", import.meta.url);

async function sampleDocument(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sampleUrl, "utf8")) as Record<string, unknown>;
}

function puzzleAt(document: Record<string, unknown>, index = 0): Record<string, unknown> {
  return (document.puzzles as Record<string, unknown>[])[index] as Record<string, unknown>;
}

function acceptedAt(puzzle: Record<string, unknown>, index = 0): Record<string, unknown> {
  return (puzzle.acceptedSolutions as Record<string, unknown>[])[index] as Record<string, unknown>;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "a-move-ago-content-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function writeDocument(
  directory: string,
  filename: string,
  document: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(directory, filename), JSON.stringify(document));
}

async function twoRoadsDocument(): Promise<Record<string, unknown>> {
  const document = await sampleDocument();
  document.case = {
    id: "case-two-roads",
    date: "2026-08-04",
    slug: "two-roads",
    title: "Two roads",
    generatedAt: 1785801600,
  };
  document.puzzles = [
    {
      public: {
        id: "two-roads",
        version: 1,
        title: "Two roads",
        prompt: "What happened one move ago?",
        postFen: "4k3/8/8/8/8/8/R7/4K3 b - - 1 1",
        retractingColor: "w",
        maxHints: 0,
        provenance: "Original A MOVE AGO test",
        license: "CC-BY-4.0",
      },
      acceptedSolutions: [
        {
          retraction: {
            currentSquare: "a2",
            previousSquare: "a1",
            movedPiece: { color: "w", type: "r" },
            restoredPiece: null,
            special: "normal",
          },
          previousFen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1",
          forwardSan: "Ra2",
          explanation: "The rook came up from a1.",
          historyConstraints: [
            { kind: "previous-castling", value: "-" },
            { kind: "previous-en-passant", value: "-" },
          ],
        },
        {
          retraction: {
            currentSquare: "a2",
            previousSquare: "b2",
            movedPiece: { color: "w", type: "r" },
            restoredPiece: null,
            special: "normal",
          },
          previousFen: "4k3/8/8/8/8/8/1R6/4K3 w - - 0 1",
          forwardSan: "Ra2",
          explanation: "The rook came across from b2.",
          historyConstraints: [
            { kind: "previous-castling", value: "-" },
            { kind: "previous-en-passant", value: "-" },
          ],
        },
      ],
      hints: [],
      contradictionExplanations: {},
    },
  ];
  return document;
}

describe("validateContentDocument", () => {
  test("validates the checked-in sample", async () => {
    const content = validateContentDocument(await readFile(sampleUrl, "utf8"));

    expect(content.puzzles[0]?.public.id).toBe("opening-exd5");
  });

  test("rejects a puzzle without provenance", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    delete (puzzle.public as Record<string, unknown>).provenance;

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow("provenance");
  });

  test("rejects an accepted solution with a mismatched forwardSan", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    const accepted = acceptedAt(puzzle);
    accepted.forwardSan = "d5";

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow("forwardSan");
  });

  test("rejects a mismatched previous en-passant constraint", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    const accepted = acceptedAt(puzzle);
    const constraints = accepted.historyConstraints as Record<string, unknown>[];
    (constraints[1] as Record<string, unknown>).value = "-";

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow(
      "previous en-passant constraint",
    );
  });

  test("rejects a retraction whose color disagrees with the puzzle", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    (puzzle.public as Record<string, unknown>).retractingColor = "b";

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow("retractingColor");
  });

  test("allows omitted history constraints", async () => {
    const content = await sampleDocument();
    acceptedAt(puzzleAt(content)).historyConstraints = [];

    expect(validateContentDocument(JSON.stringify(content))).toBeDefined();
  });

  test("rejects duplicate accepted retraction identities", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    const accepted = acceptedAt(puzzle);
    (puzzle.acceptedSolutions as Record<string, unknown>[]).push(structuredClone(accepted));

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow(
      "duplicate accepted retraction",
    );
  });

  test("allows distinct accepted retractions", async () => {
    const content = await twoRoadsDocument();

    expect(
      validateContentDocument(JSON.stringify(content)).puzzles[0]?.acceptedSolutions,
    ).toHaveLength(2);
  });

  test("rejects duplicate history constraint kinds", async () => {
    const content = await sampleDocument();
    const constraints = acceptedAt(puzzleAt(content)).historyConstraints as Record<
      string,
      unknown
    >[];
    constraints.push({ kind: "previous-castling", value: "KQkq" });

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow(
      "duplicate history constraint",
    );
  });

  test("rejects semantically impossible en-passant metadata", async () => {
    const content = await sampleDocument();
    const accepted = acceptedAt(puzzleAt(content));
    accepted.historyConstraints = [];
    accepted.previousFen = (accepted.previousFen as string).replace(" d6 ", " f6 ");

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow("semantic en-passant");
  });

  test("rejects castling rights that do not match the board", async () => {
    const content = await sampleDocument();
    const puzzle = puzzleAt(content);
    const publicPuzzle = puzzle.public as Record<string, unknown>;
    publicPuzzle.postFen = (publicPuzzle.postFen as string).replace("RNBQKBNR", "RNBQKBN1");

    expect(() => validateContentDocument(JSON.stringify(content))).toThrow("semantic castling");
  });
});

describe("validateContentDirectory", () => {
  test("rejects an empty corpus", async () => {
    await withTempDirectory(async (directory) => {
      await expect(validateContentDirectory(directory)).rejects.toThrow(
        "no regular JSON documents",
      );
    });
  });

  test("rejects non-regular JSON entries", async () => {
    await withTempDirectory(async (directory) => {
      await mkdir(join(directory, "not-a-document.json"));
      await expect(validateContentDirectory(directory)).rejects.toThrow("regular JSON file");
    });
  });

  test.each([
    ["case ID", "id"],
    ["case date", "date"],
    ["puzzle ID", "puzzle"],
  ])("rejects duplicate %s across files and names both files", async (_label, kind) => {
    await withTempDirectory(async (directory) => {
      const first = await sampleDocument();
      const second = await sampleDocument();
      const firstCase = first.case as Record<string, unknown>;
      const secondCase = second.case as Record<string, unknown>;
      firstCase.id = "first-case";
      firstCase.date = "2026-08-03";
      puzzleAt(first).public = {
        ...(puzzleAt(first).public as Record<string, unknown>),
        id: "first-puzzle",
      };
      secondCase.id = "second-case";
      secondCase.date = "2026-08-04";
      puzzleAt(second).public = {
        ...(puzzleAt(second).public as Record<string, unknown>),
        id: "second-puzzle",
      };
      if (kind === "id") secondCase.id = firstCase.id;
      if (kind === "date") secondCase.date = firstCase.date;
      if (kind === "puzzle") {
        (puzzleAt(second).public as Record<string, unknown>).id = (
          puzzleAt(first).public as Record<string, unknown>
        ).id;
      }
      await writeDocument(directory, "first.json", first);
      await writeDocument(directory, "second.json", second);

      await expect(validateContentDirectory(directory)).rejects.toThrow(
        /first\.json.*second\.json/,
      );
    });
  });
});
