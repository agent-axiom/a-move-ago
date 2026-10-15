import { ArchiveResponseSchema } from "@a-move-ago/api-contract";
import { readArchiveCases } from "../db/archive";
import type { Env, SessionActor } from "../env";

export async function getArchiveCatalog(env: Env, actor: SessionActor, today: string) {
  const rows = await readArchiveCases(env.DB, actor, today);
  const result = ArchiveResponseSchema.safeParse({
    today,
    startsOn: rows.at(-1)?.case_date ?? null,
    cases: rows.map((row) => ({
      id: row.id,
      date: row.case_date,
      slug: row.slug,
      title: row.title,
      puzzleCount: row.puzzle_count,
      solvedPuzzles: row.solved_puzzles,
      completed: row.solved_puzzles === row.puzzle_count,
    })),
  });
  if (!result.success) throw new Error("Stored archive metadata is invalid");
  return result.data;
}
