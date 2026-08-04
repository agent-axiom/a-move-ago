import { z } from "zod";
import { RetractionSchema } from "./chess";
import { AcceptedSolutionSchema, ContradictionCodeSchema, PuzzlePublicSchema } from "./puzzles";

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        requestId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const ClientChannelSchema = z.enum(["web", "telegram", "android"]);

export const GuestSessionRequestSchema = z.object({ channel: ClientChannelSchema }).strict();

export const SessionIssuedSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    kind: z.enum(["guest", "telegram"]),
  })
  .strict();

export const TelegramProfileSchema = z
  .object({
    telegramUserId: z.string().regex(/^\d+$/),
    displayName: z.string().min(1),
    username: z.string().nullable(),
    avatarUrl: z.httpUrl().nullable(),
  })
  .strict();

export const TelegramMiniAppAuthRequestSchema = z
  .object({
    initData: z.string().min(1).max(8192),
  })
  .strict();

export const OidcStartRequestSchema = z
  .object({
    channel: z.enum(["web", "android"]),
  })
  .strict();

export const OidcStartResponseSchema = z
  .object({
    authorizationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const HandoffExchangeRequestSchema = z
  .object({
    handoffCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export const TelegramSessionIssuedSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
    kind: z.literal("telegram"),
    profile: TelegramProfileSchema,
  })
  .strict();

export type TelegramProfile = z.infer<typeof TelegramProfileSchema>;
export type TelegramMiniAppAuthRequest = z.infer<typeof TelegramMiniAppAuthRequestSchema>;
export type OidcStartRequest = z.infer<typeof OidcStartRequestSchema>;
export type OidcStartResponse = z.infer<typeof OidcStartResponseSchema>;
export type HandoffExchangeRequest = z.infer<typeof HandoffExchangeRequestSchema>;
export type TelegramSessionIssued = z.infer<typeof TelegramSessionIssuedSchema>;

export const MeResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("guest"), profile: z.null() }).strict(),
  z.object({ kind: z.literal("telegram"), profile: TelegramProfileSchema }).strict(),
]);

export const DailyCaseResponseSchema = z
  .object({
    id: z.string().min(1),
    date: z.iso.date(),
    title: z.string().min(1),
    puzzles: z.array(PuzzlePublicSchema).min(1),
    solvedPuzzleIds: z.array(z.string()),
  })
  .strict();

export const AttemptRequestSchema = z
  .object({
    attemptUuid: z.uuid(),
    caseId: z.string().min(1),
    puzzleId: z.string().min(1),
    retraction: RetractionSchema,
  })
  .strict();

export const ContradictionSchema = z
  .object({
    code: ContradictionCodeSchema,
    message: z.string().min(1),
  })
  .strict();

export const AttemptResultSchema = z.discriminatedUnion("correct", [
  z
    .object({
      id: z.uuid(),
      attemptUuid: z.uuid(),
      correct: z.literal(false),
      contradiction: ContradictionSchema,
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      attemptUuid: z.uuid(),
      correct: z.literal(true),
      reveal: AcceptedSolutionSchema,
    })
    .strict(),
]);

export const HintRequestSchema = z.object({ level: z.int().positive() }).strict();

export const HintResponseSchema = z
  .object({
    level: z.int().positive(),
    text: z.string().min(1),
    exhausted: z.boolean(),
  })
  .strict();

export const StatsResponseSchema = z
  .object({
    attempts: z.int().nonnegative(),
    hintsUsed: z.int().nonnegative(),
    solvedPuzzles: z.int().nonnegative(),
    completedCases: z.int().nonnegative(),
    currentStreak: z.int().nonnegative(),
    bestStreak: z.int().nonnegative(),
    lastCompletedDate: z.iso.date().nullable(),
  })
  .strict();
