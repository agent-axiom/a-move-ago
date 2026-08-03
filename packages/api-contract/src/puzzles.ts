import { z } from "zod";
import { ColorSchema, RetractionSchema, SquareSchema } from "./chess";

export const ContradictionCodeSchema = z.enum([
  "NO_PIECE_ON_CURRENT_SQUARE",
  "WRONG_COLOR",
  "PREVIOUS_SQUARE_OCCUPIED",
  "RESTORE_SQUARE_OCCUPIED",
  "INVALID_SPECIAL_MOVE",
  "OPPONENT_KING_IN_CHECK",
  "NOT_THE_LAST_MOVE",
]);

const CastlingRightsSchema = z.union([
  z.literal("-"),
  z
    .string()
    .min(1)
    .regex(/^K?Q?k?q?$/),
]);

export const HistoryConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("previous-castling"), value: CastlingRightsSchema }).strict(),
  z
    .object({
      kind: z.literal("previous-en-passant"),
      value: z.union([SquareSchema, z.literal("-")]),
    })
    .strict(),
]);

export const PuzzlePublicSchema = z
  .object({
    id: z.string().min(1),
    version: z.int().positive(),
    title: z.string().min(1),
    prompt: z.string().min(1),
    postFen: z.string().min(1),
    retractingColor: ColorSchema,
    maxHints: z.int().nonnegative(),
    provenance: z.string().min(1),
    license: z.string().min(1),
  })
  .strict();

export const AcceptedSolutionSchema = z
  .object({
    retraction: RetractionSchema,
    previousFen: z.string().min(1),
    forwardSan: z.string().min(1),
    explanation: z.string().min(1),
    historyConstraints: z.array(HistoryConstraintSchema),
  })
  .strict();

export const PuzzlePrivateSchema = z
  .object({
    public: PuzzlePublicSchema,
    acceptedSolutions: z.array(AcceptedSolutionSchema).min(1),
    hints: z.array(z.string().min(1)),
    contradictionExplanations: z.partialRecord(ContradictionCodeSchema, z.string().min(1)),
  })
  .strict();

export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type PuzzlePrivate = z.infer<typeof PuzzlePrivateSchema>;
export type AcceptedSolution = z.infer<typeof AcceptedSolutionSchema>;
