import { createHash } from "node:crypto";
import { LocalizationBundleSchema } from "@a-move-ago/api-contract";
import { z } from "zod";
import { canonicalJson } from "./canonical-json";
import type { D1Statement } from "./import-plan";
import { ContentCaseSchema } from "./validate-content";

export type LocalizationRequest = {
  keyId: string;
  purpose: "localization";
  from: string;
  through: string;
  locales: ["ru", "zh"];
};

type Query = (statements: D1Statement[]) => Promise<unknown[][]>;
export class LocalizationImportError extends Error {}

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) throw new LocalizationImportError(code);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function localizationDates(request: LocalizationRequest): string[] {
  const start = Date.parse(`${request.from}T00:00:00Z`);
  const count = (Date.parse(`${request.through}T00:00:00Z`) - start) / 86_400_000 + 1;
  ensure(Number.isInteger(count) && count >= 1 && count <= 90, "INVALID_LOCALIZATION_RANGE");
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

const sourceCaseSchema = z.object({
  case_id: z.string().min(1),
  case_date: z.iso.date(),
  import_count: z.literal(1),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  source_json: z.string(),
}).strict();

/** Rebuild the immutable import in memory; no source text is returned in receipts or logs. */
export function localizationSourceStatement(caseId: string): D1Statement {
  return {
    sql: `SELECT d.id AS case_id, d.case_date,
      (SELECT COUNT(*) FROM content_imports i
        WHERE i.case_id = d.id AND i.published_at IS NOT NULL) AS import_count,
      (SELECT i.digest FROM content_imports i
        WHERE i.case_id = d.id AND i.published_at IS NOT NULL LIMIT 1) AS source_digest,
      json_object('case', json_object('id', d.id, 'date', d.case_date,
        'slug', d.slug, 'title', d.title, 'generatedAt', d.created_at),
        'puzzles', json(COALESCE((SELECT json_group_array(json_object(
          'public', json(p.public_json),
          'acceptedSolutions', json(COALESCE((SELECT json_group_array(json(solution_json))
            FROM (SELECT solution_json FROM puzzle_solutions s
              WHERE s.puzzle_id = p.id ORDER BY s.sort_order)), '[]')),
          'hints', json(COALESCE((SELECT json_group_array(json_extract(payload_json, '$.text'))
            FROM (SELECT payload_json FROM puzzle_hints h
              WHERE h.puzzle_id = p.id ORDER BY h.level)), '[]')),
          'contradictionExplanations', json(COALESCE((SELECT contradiction_json
            FROM puzzle_solutions s WHERE s.puzzle_id = p.id
              ORDER BY s.sort_order LIMIT 1), '{}'))))
          FROM (SELECT p.* FROM daily_case_puzzles cp JOIN puzzles p ON p.id = cp.puzzle_id
            WHERE cp.case_id = d.id AND p.status = 'published' ORDER BY cp.position) p), '[]')))
        AS source_json
      FROM daily_cases d WHERE d.id = ? AND d.status = 'published'`,
    params: [caseId],
  };
}

type LocalizedRow = {
  table: "case_localizations" | "puzzle_localizations";
  key: string;
  locale: "ru" | "zh";
  values: Record<string, string>;
};

function rowCheck(row: LocalizedRow, requireExisting: boolean): D1Statement {
  const keyColumn = row.table === "case_localizations" ? "case_id" : "puzzle_id";
  const fields = Object.entries(row.values);
  const match = fields.map(([column]) => `${column} = ?`).join(" AND ");
  return {
    sql: requireExisting
      ? `SELECT (NOT EXISTS (SELECT 1 FROM ${row.table} WHERE ${keyColumn} = ?
          AND locale = ? AND ${match})) AS conflict`
      : `SELECT (EXISTS (SELECT 1 FROM ${row.table} WHERE ${keyColumn} = ?
          AND locale = ? AND NOT (${match}))) AS conflict`,
    params: [row.key, row.locale, ...fields.map(([, value]) => value)],
  };
}

function insertRow(row: LocalizedRow): D1Statement {
  const keyColumn = row.table === "case_localizations" ? "case_id" : "puzzle_id";
  const fields = Object.entries(row.values);
  const match = fields
    .map(([column]) => `${row.table}.${column} = excluded.${column}`)
    .join(" AND ");
  return {
    sql: `INSERT INTO ${row.table} (${keyColumn}, locale, ${fields.map(([key]) => key).join(", ")})
      VALUES (${Array.from({ length: fields.length + 2 }, () => "?").join(", ")})
      ON CONFLICT(${keyColumn}, locale) DO UPDATE SET
        content_digest = CASE WHEN ${match} THEN ${row.table}.content_digest ELSE NULL END`,
    params: [row.key, row.locale, ...fields.map(([, value]) => value)],
  };
}

async function verifyRows(rows: LocalizedRow[], query: Query, requireExisting: boolean) {
  const results = await query(rows.map((row) => rowCheck(row, requireExisting)));
  ensure(results.length === rows.length, "INVALID_D1_RESPONSE");
  for (const result of results) {
    ensure(result.length === 1, "INVALID_D1_RESPONSE");
    const parsed = z.object({ conflict: z.union([z.literal(0), z.literal(1)]) }).strict().parse(result[0]);
    ensure(parsed.conflict === 0, requireExisting ? "LOCALIZATION_IMPORT_INCOMPLETE" : "EXISTING_LOCALIZATION_CONFLICT");
  }
}

/** Validate the entire bundle and all remote conflicts before binding its envelope. */
export async function prepareLocalizationImport(payload: unknown, request: LocalizationRequest, query: Query) {
  const bundle = LocalizationBundleSchema.parse(payload);
  const expectedDates = localizationDates(request);
  ensure(bundle.cases.length === expectedDates.length, "LOCALIZATION_RANGE_MISMATCH");
  const caseIds = new Set<string>();
  for (const content of bundle.cases) {
    ensure(!caseIds.has(content.caseId), "DUPLICATE_LOCALIZATION_CASE");
    caseIds.add(content.caseId);
  }
  const sources = await query(bundle.cases.map((content) => localizationSourceStatement(content.caseId)));
  ensure(sources.length === bundle.cases.length, "INVALID_D1_RESPONSE");
  const dates = new Set<string>();
  const puzzleIds = new Set<string>();
  const rows: LocalizedRow[] = [];
  let puzzles = 0;
  for (const [index, content] of bundle.cases.entries()) {
    const sourceRows = sources[index];
    ensure(sourceRows?.length === 1, "LOCALIZATION_SOURCE_MISSING");
    const source = sourceCaseSchema.parse(sourceRows[0]);
    ensure(source.case_id === content.caseId && source.source_digest === content.sourceDigest, "LOCALIZATION_SOURCE_MISMATCH");
    ensure(!dates.has(source.case_date), "DUPLICATE_LOCALIZATION_DATE");
    dates.add(source.case_date);
    const originalCase = ContentCaseSchema.parse(JSON.parse(source.source_json));
    ensure(hash(originalCase) === content.sourceDigest && originalCase.case.id === content.caseId && originalCase.case.date === source.case_date, "LOCALIZATION_SOURCE_MISMATCH");
    const sourcePuzzles = originalCase.puzzles.map((puzzle) => ({
      rowId: `${puzzle.public.id}:v${puzzle.public.version}`,
      id: puzzle.public.id, version: puzzle.public.version,
      maxHints: puzzle.public.maxHints, hintsCount: puzzle.hints.length,
      explanationsCount: puzzle.acceptedSolutions.length,
      contradictionKeys: Object.keys(puzzle.contradictionExplanations),
    }));
    ensure(sourcePuzzles.length <= 10, "LOCALIZATION_SOURCE_MISMATCH");
    puzzles += sourcePuzzles.length;
    for (const puzzle of sourcePuzzles) {
      ensure(!puzzleIds.has(puzzle.rowId), "DUPLICATE_LOCALIZATION_PUZZLE");
      puzzleIds.add(puzzle.rowId);
      ensure(puzzle.maxHints === puzzle.hintsCount, "LOCALIZATION_SOURCE_MISMATCH");
    }
    for (const locale of request.locales) {
      const translation = content.translations[locale];
      ensure(translation.puzzles.length === sourcePuzzles.length, "LOCALIZATION_PUZZLE_MISMATCH");
      const caseDigest = hash({ caseId: content.caseId, sourceDigest: content.sourceDigest, locale, title: translation.title });
      rows.push({ table: "case_localizations", key: content.caseId, locale, values: {
        title: translation.title, source_digest: content.sourceDigest, content_digest: caseDigest,
      } });
      for (const [puzzleIndex, localized] of translation.puzzles.entries()) {
        const original = sourcePuzzles[puzzleIndex];
        ensure(original && localized.id === original.id && localized.version === original.version, "LOCALIZATION_PUZZLE_MISMATCH");
        ensure(localized.hints.length === original.hintsCount, "LOCALIZATION_HINT_MISMATCH");
        ensure(localized.explanations.length === original.explanationsCount, "LOCALIZATION_EXPLANATION_MISMATCH");
        ensure(canonicalJson(Object.keys(localized.contradictionExplanations).sort()) === canonicalJson([...original.contradictionKeys].sort()), "LOCALIZATION_CONTRADICTION_MISMATCH");
        const publicContent = { title: localized.title, prompt: localized.prompt, provenance: localized.provenance, license: localized.license };
        const privateContent = { hints: localized.hints, explanations: localized.explanations, contradictionExplanations: localized.contradictionExplanations };
        const puzzleDigest = hash({ puzzleId: original.rowId, sourceDigest: content.sourceDigest, locale, public: publicContent, private: privateContent });
        rows.push({ table: "puzzle_localizations", key: original.rowId, locale, values: {
          public_json: canonicalJson(publicContent), private_json: canonicalJson(privateContent),
          source_digest: content.sourceDigest, content_digest: puzzleDigest,
        } });
      }
    }
  }
  ensure(dates.size === expectedDates.length && expectedDates.every((date) => dates.has(date)), "LOCALIZATION_RANGE_MISMATCH");
  await verifyRows(rows, query, false);
  return {
    cases: bundle.cases.length, puzzles, dates: [...dates].sort(), locales: request.locales,
    caseRows: bundle.cases.length * request.locales.length,
    puzzleRows: puzzles * request.locales.length,
    async import() {
      await query(rows.map(insertRow));
      await verifyRows(rows, query, true);
    },
  };
}
