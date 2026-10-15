import { z } from "zod";

export const ContentLocaleSchema = z.enum(["ru", "zh"]);
export type ContentLocale = z.infer<typeof ContentLocaleSchema>;

export const ContradictionCodeSchema = z.enum([
  "NO_PIECE_ON_CURRENT_SQUARE",
  "WRONG_COLOR",
  "PREVIOUS_SQUARE_OCCUPIED",
  "RESTORE_SQUARE_OCCUPIED",
  "INVALID_SPECIAL_MOVE",
  "OPPONENT_KING_IN_CHECK",
  "NOT_THE_LAST_MOVE",
]);

export const LocalizedTitleSchema = z.object({ title: z.string().min(1) }).strict();
export const LocalizedPuzzlePublicSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    provenance: z.string().min(1),
    license: z.string().min(1),
  })
  .strict();
export const LocalizedPuzzlePrivateSchema = z
  .object({
    hints: z.array(z.string().min(1)),
    explanations: z.array(z.string().min(1)).min(1),
    contradictionExplanations: z.partialRecord(ContradictionCodeSchema, z.string().min(1)),
  })
  .strict();
export const LocalizedExplanationSchema = z.object({ explanation: z.string().min(1) }).strict();
export const LocalizedHintSchema = z.object({ text: z.string().min(1) }).strict();
export const LocalizedContradictionSchema = z.object({ message: z.string().min(1) }).strict();

export function contentLocalizationsSchema<T extends z.ZodType>(schema: T) {
  return z.object({ ru: schema.optional(), zh: schema.optional() }).strict();
}

export const PuzzleLocalizationSchema = LocalizedPuzzlePublicSchema.extend({
  id: z.string().min(1),
  version: z.int().positive(),
  hints: LocalizedPuzzlePrivateSchema.shape.hints,
  explanations: LocalizedPuzzlePrivateSchema.shape.explanations,
  contradictionExplanations: LocalizedPuzzlePrivateSchema.shape.contradictionExplanations,
}).strict();
export const CaseLocalizationSchema = z
  .object({ title: z.string().min(1), puzzles: z.array(PuzzleLocalizationSchema).min(1) })
  .strict();
export const LocalizationBundleSchema = z
  .object({
    version: z.literal(1),
    cases: z
      .array(
        z
          .object({
            caseId: z.string().min(1),
            sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
            translations: z
              .object({ ru: CaseLocalizationSchema, zh: CaseLocalizationSchema })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

export type PuzzleLocalization = z.infer<typeof PuzzleLocalizationSchema>;
export type CaseLocalization = z.infer<typeof CaseLocalizationSchema>;
export type LocalizationBundle = z.infer<typeof LocalizationBundleSchema>;
export type LocalizedPuzzlePublic = z.infer<typeof LocalizedPuzzlePublicSchema>;
export type LocalizedPuzzlePrivate = z.infer<typeof LocalizedPuzzlePrivateSchema>;
