import { ArchiveResponseSchema } from "@a-move-ago/api-contract";
import { readArchiveCases } from "../db/archive";
import { readGameProgress } from "../db/gameplay";
import type { Env, SessionActor } from "../env";
import { neutralCaseTitles } from "./gameplay-service";
import { caseTitleLocalizations } from "./localization-service";

export async function getArchiveCatalog(
  env: Env,
  actor: SessionActor,
  today: string,
  includeLocalizations = false,
) {
  const rows = await readArchiveCases(env.DB, actor, today);
  if (
    rows.some(
      (row) =>
        typeof row.title !== "string" ||
        row.title.length === 0 ||
        typeof row.slug !== "string" ||
        row.slug.length === 0,
    )
  ) {
    throw new Error("Stored archive metadata is invalid");
  }
  const titles = includeLocalizations ? await caseTitleLocalizations(env.DB) : undefined;
  const members = (
    await env.DB.prepare(
      `SELECT dcp.case_id, dcp.puzzle_id FROM daily_case_puzzles dcp
      JOIN daily_cases dc ON dc.id = dcp.case_id WHERE dc.case_date <= ? AND dc.status = 'published'`,
    )
      .bind(today)
      .all<{ case_id: string; puzzle_id: string }>()
  ).results;
  const ids = [...new Set(members.map((row) => row.puzzle_id))];
  const entitledIds = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 90) {
    for (const [id, state] of await readGameProgress(
      env.DB,
      actor,
      ids.slice(offset, offset + 90),
    )) {
      if (state.clueUnlocked || state.earnedPoints !== null) entitledIds.add(id);
    }
  }
  const entitledCases = new Set(
    rows
      .filter((row) => {
        const puzzles = members.filter((member) => member.case_id === row.id);
        return puzzles.length > 0 && puzzles.every((puzzle) => entitledIds.has(puzzle.puzzle_id));
      })
      .map((row) => row.id),
  );
  const result = ArchiveResponseSchema.safeParse({
    today,
    startsOn: rows.at(-1)?.case_date ?? null,
    cases: rows.map((row) => ({
      id: row.id,
      date: row.case_date,
      slug: `case-${row.case_date}`,
      title: entitledCases.has(row.id) ? row.title : neutralCaseTitles.en.title,
      ...(includeLocalizations
        ? {
            localizations: entitledCases.has(row.id)
              ? titles?.get(row.id)
              : { ru: neutralCaseTitles.ru, zh: neutralCaseTitles.zh },
          }
        : {}),
      puzzleCount: row.puzzle_count,
      solvedPuzzles: row.solved_puzzles,
      completed: row.solved_puzzles === row.puzzle_count,
    })),
  });
  if (!result.success) throw new Error("Stored archive metadata is invalid");
  return result.data;
}
