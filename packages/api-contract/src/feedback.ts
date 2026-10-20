import { z } from "zod";

export const FeedbackReasonSchema = z.enum([
  "unclear_condition",
  "alternative_answer",
  "explanation_error",
  "other",
]);

export const FeedbackRequestSchema = z
  .object({
    reportUuid: z.uuid(),
    caseId: z.string().min(1).max(200),
    puzzleId: z.string().min(1).max(200),
    puzzleVersion: z.int().positive(),
    locale: z.enum(["en", "ru", "zh"]),
    reason: FeedbackReasonSchema,
    comment: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const FeedbackResponseSchema = z
  .object({
    reportUuid: z.uuid(),
    received: z.literal(true),
  })
  .strict();

export type FeedbackReason = z.infer<typeof FeedbackReasonSchema>;
export type PuzzleFeedbackRequest = z.infer<typeof FeedbackRequestSchema>;
export type PuzzleFeedbackResponse = z.infer<typeof FeedbackResponseSchema>;
