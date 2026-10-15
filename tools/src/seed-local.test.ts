import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { evaluateRetraction } from "@a-move-ago/game-core";
import { describe, expect, it, vi } from "vitest";
import { prepareLocalSeed, runSeedLocal } from "./seed-local";
import { validateContentDocument } from "./validate-content";

const sampleUrl = new URL("../../content/samples/2026-08-03.json", import.meta.url);
const now = new Date("2026-10-14T12:00:00.000Z");

async function withDatabase(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    for (const filename of ["0001_initial.sql", "0002_telegram_auth.sql"]) {
      db.exec(
        await readFile(new URL(`../../apps/api/migrations/${filename}`, import.meta.url), "utf8"),
      );
    }
    await run(db);
  } finally {
    db.close();
  }
}

describe("prepareLocalSeed", () => {
  it("publishes a playable public sample for today in UTC, with development identities", async () => {
    const source = await readFile(sampleUrl, "utf8");
    const seed = await prepareLocalSeed(source, new Date("2026-10-14T23:30:00-07:00"));

    expect(seed.date).toBe("2026-10-15");
    expect(seed.caseId).toBe("dev-sample-2026-10-15");
    await withDatabase(async (db) => {
      db.exec(seed.sql);
      const row = db
        .prepare(
          `SELECT dc.id, dc.case_date, dc.title, p.public_json
             FROM daily_cases dc
             JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
             JOIN puzzles p ON p.id = dcp.puzzle_id
            WHERE dc.case_date = ? AND dc.status = 'published' AND p.status = 'published'`,
        )
        .get(seed.date);
      expect(row).toMatchObject({
        id: seed.caseId,
        case_date: seed.date,
        title: "Development sample: The missing pawn",
      });
      const publicPuzzle = JSON.parse(String(row?.public_json));
      expect(publicPuzzle.id).toBe(seed.puzzleIds[0]);
      expect(publicPuzzle.title).toBe("Development sample: The missing pawn");
      const original = validateContentDocument(source);
      const puzzle = original.puzzles[0];
      if (!puzzle) throw new Error("Expected public sample puzzle");
      const solution = puzzle.acceptedSolutions[0];
      if (!solution) throw new Error("Expected public sample solution");
      expect(evaluateRetraction({ ...puzzle, public: publicPuzzle }, solution.retraction)).toEqual({
        correct: true,
        reveal: solution,
      });
      expect(db.prepare("SELECT count(*) AS count FROM puzzle_hints").get()?.count).toBe(
        publicPuzzle.maxHints,
      );
      expect(db.prepare("SELECT published_at FROM content_imports").get()?.published_at).toBe(
        Date.parse("2026-10-15T00:00:00Z") / 1_000,
      );
    });
  });

  it("is stable within the UTC day, preserves existing data, and retains earlier sample dates", async () => {
    const source = await readFile(sampleUrl, "utf8");
    const first = await prepareLocalSeed(source, now);
    const repeated = await prepareLocalSeed(source, new Date("2026-10-14T23:59:59Z"));
    const tomorrow = await prepareLocalSeed(source, new Date("2026-10-15T00:00:00Z"));
    expect(repeated).toEqual(first);
    await withDatabase(async (db) => {
      db.prepare(
        `INSERT INTO sessions
          (id, token_hash, kind, channel, created_at, expires_at, last_seen_at)
         VALUES ('existing-guest', 'existing-hash', 'guest', 'web', 1, 9999999999, 1)`,
      ).run();
      db.exec(first.sql);
      db.exec(repeated.sql);
      expect(db.prepare("SELECT count(*) AS count FROM daily_cases").get()?.count).toBe(1);
      expect(db.prepare("SELECT count(*) AS count FROM content_imports").get()?.count).toBe(1);
      db.exec(tomorrow.sql);
      expect(db.prepare("SELECT case_date FROM daily_cases ORDER BY case_date").all()).toEqual([
        { case_date: "2026-10-14" },
        { case_date: "2026-10-15" },
      ]);
      expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "existing-guest" }]);
    });
  });

  it("preserves SQL punctuation and Unicode in sample fields as data", async () => {
    const document = validateContentDocument(await readFile(sampleUrl, "utf8"));
    document.case.title = "Whose '?'; DROP TABLE sessions; -- ♞\nSample";
    const seed = await prepareLocalSeed(JSON.stringify(document), now);
    await withDatabase(async (db) => {
      db.exec(seed.sql);
      expect(db.prepare("SELECT title FROM daily_cases").get()?.title).toBe(
        `Development sample: ${document.case.title}`,
      );
      expect(db.prepare("SELECT count(*) AS count FROM sessions").get()?.count).toBe(0);
    });
  });

  it("does not replace an existing daily case when its date is already occupied", async () => {
    const seed = await prepareLocalSeed(await readFile(sampleUrl, "utf8"), now);
    await withDatabase(async (db) => {
      db.prepare(
        `INSERT INTO daily_cases
          (id, case_date, slug, title, status, created_at, updated_at)
         VALUES ('existing-case', ?, 'existing-case', 'Keep this case', 'draft', 1, 1)`,
      ).run(seed.date);
      expect(() => db.exec(seed.sql)).toThrow();
      expect(db.prepare("SELECT id, title FROM daily_cases").all()).toEqual([
        { id: "existing-case", title: "Keep this case" },
      ]);
      expect(db.prepare("SELECT count(*) AS count FROM puzzles").get()?.count).toBe(0);
    });
  });
});

describe("runSeedLocal", () => {
  it.each([["--remote"], ["--config", "production.jsonc"], ["--file", "private.json"]])(
    "rejects every CLI override before reading content or starting Wrangler: %j",
    async (...args) => {
      const readSample = vi.fn();
      const runWrangler = vi.fn();
      await expect(runSeedLocal(args as string[], { readSample, runWrangler })).rejects.toThrow(
        "Usage:",
      );
      expect(readSample).not.toHaveBeenCalled();
      expect(runWrangler).not.toHaveBeenCalled();
    },
  );

  it("migrates and seeds only local D1 in the API dev state and removes the temporary SQL", async () => {
    const calls: string[][] = [];
    let sqlFilename: string | undefined;
    let sql: string | undefined;
    const log = vi.fn();
    const runWrangler = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "execute") {
        sqlFilename = args.at(-1);
        if (!sqlFilename) throw new Error("Expected temporary SQL filename");
        sql = await readFile(sqlFilename, "utf8");
      }
    });
    const summary = await runSeedLocal([], {
      now: () => now,
      readSample: async () => await readFile(sampleUrl, "utf8"),
      runWrangler,
      log,
    });

    const config = fileURLToPath(new URL("../../apps/api/wrangler.jsonc", import.meta.url));
    const state = fileURLToPath(new URL("../../apps/api/.wrangler/state", import.meta.url));
    const localOptions = ["--local", "--config", config, "--persist-to", state];
    expect(calls).toEqual([
      ["d1", "migrations", "apply", "a-move-ago", ...localOptions],
      ["d1", "execute", "a-move-ago", ...localOptions, "--file", sqlFilename],
    ]);
    expect(sql).toBe((await prepareLocalSeed(await readFile(sampleUrl, "utf8"), now)).sql);
    expect(log).toHaveBeenCalledWith(
      `Development sample seeded in local D1 only: ${JSON.stringify(summary)}`,
    );
    await expect(readFile(String(sqlFilename), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid sample content before any database command", async () => {
    const runWrangler = vi.fn();
    await expect(runSeedLocal([], { readSample: async () => "{}", runWrangler })).rejects.toThrow();
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it("does not seed after failed migrations", async () => {
    const log = vi.fn();
    const runWrangler = vi.fn(async () => {
      throw new Error("Local migrations failed");
    });
    await expect(
      runSeedLocal([], {
        readSample: async () => await readFile(sampleUrl, "utf8"),
        runWrangler,
        log,
      }),
    ).rejects.toThrow("Local migrations failed");
    expect(runWrangler).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("removes temporary SQL after a failed seed and does not report success", async () => {
    let sqlFilename: string | undefined;
    const log = vi.fn();
    const runWrangler = vi.fn(async (args: string[]) => {
      if (args[1] !== "execute") return;
      sqlFilename = args.at(-1);
      throw new Error("Local seed execution failed");
    });
    await expect(
      runSeedLocal([], {
        readSample: async () => await readFile(sampleUrl, "utf8"),
        runWrangler,
        log,
      }),
    ).rejects.toThrow("Local seed execution failed");
    expect(runWrangler).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
    expect(sqlFilename).toBeDefined();
    await expect(readFile(String(sqlFilename), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
