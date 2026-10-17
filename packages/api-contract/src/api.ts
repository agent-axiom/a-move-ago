import { z } from "zod";
import { RetractionSchema } from "./chess";
import {
  contentLocalizationsSchema,
  LocalizedContradictionSchema,
  LocalizedHintSchema,
  LocalizedTitleSchema,
} from "./localizations";
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

export const GuestMeResponseSchema = z
  .object({
    kind: z.literal("guest"),
    profile: z.null(),
  })
  .strict();

export type GuestMeResponse = z.infer<typeof GuestMeResponseSchema>;

export const MeResponseSchema = z.discriminatedUnion("kind", [
  GuestMeResponseSchema,
  z.object({ kind: z.literal("telegram"), profile: TelegramProfileSchema }).strict(),
]);

export const EarnedHintSchema = z
  .object({
    level: z.int().positive(),
    text: z.string().min(1),
    localizations: contentLocalizationsSchema(LocalizedHintSchema).optional(),
    exhausted: z.boolean(),
  })
  .strict();

export const PuzzleProgressSchema = z
  .object({
    attemptCount: z.int().nonnegative(),
    assistanceCount: z.int().nonnegative(),
    clueUnlocked: z.boolean(),
    highestHintLevel: z.int().nonnegative(),
    earnedPoints: z.int().nonnegative().nullable(),
    nextAttemptPoints: z.int().nonnegative(),
    legacySolved: z.boolean(),
    awardAttemptId: z.uuid().nullable(),
    earnedHints: z.array(EarnedHintSchema),
  })
  .strict();
export type EarnedHint = z.infer<typeof EarnedHintSchema>;
export type PuzzleProgress = z.infer<typeof PuzzleProgressSchema>;

export const ClueResponseSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    localizations: contentLocalizationsSchema(
      z.object({ title: z.string().min(1), prompt: z.string().min(1) }).strict(),
    ).optional(),
    progress: PuzzleProgressSchema,
  })
  .strict();
export type ClueResponse = z.infer<typeof ClueResponseSchema>;

export const PuzzleRevealResponseSchema = z
  .object({ reveal: AcceptedSolutionSchema })
  .strict();
export type PuzzleRevealResponse = z.infer<typeof PuzzleRevealResponseSchema>;

export const DailyCaseResponseSchema = z
  .object({
    id: z.string().min(1),
    date: z.iso.date(),
    title: z.string().min(1),
    localizations: contentLocalizationsSchema(LocalizedTitleSchema).optional(),
    puzzles: z.array(PuzzlePublicSchema).min(1),
    solvedPuzzleIds: z.array(z.string()),
    progressStates: z.record(z.string().min(1), PuzzleProgressSchema).optional(),
  })
  .strict();

export const ArchiveCaseSchema = z
  .object({
    id: z.string().min(1),
    date: z.iso.date(),
    slug: z.string().min(1),
    title: z.string().min(1),
    localizations: contentLocalizationsSchema(LocalizedTitleSchema).optional(),
    puzzleCount: z.int().positive(),
    solvedPuzzles: z.int().nonnegative(),
    completed: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.solvedPuzzles <= value.puzzleCount &&
      value.completed === (value.solvedPuzzles === value.puzzleCount),
    { message: "Archive progress must match the puzzle count" },
  );

export const ArchiveResponseSchema = z
  .object({
    today: z.iso.date(),
    startsOn: z.iso.date().nullable(),
    cases: z.array(ArchiveCaseSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const oldest = value.cases.at(-1)?.date ?? null;
    if (value.startsOn !== oldest) {
      context.addIssue({ code: "custom", message: "Archive start must match its oldest case" });
    }
    const ids = new Set<string>();
    let previousDate: string | undefined;
    for (const item of value.cases) {
      if (
        item.date > value.today ||
        (previousDate !== undefined && item.date >= previousDate) ||
        ids.has(item.id)
      ) {
        context.addIssue({ code: "custom", message: "Archive cases must be unique past dates" });
      }
      ids.add(item.id);
      previousDate = item.date;
    }
  });

export type ArchiveCase = z.infer<typeof ArchiveCaseSchema>;
export type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>;

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
    localizations: contentLocalizationsSchema(LocalizedContradictionSchema).optional(),
  })
  .strict();

export const AttemptResultSchema = z.discriminatedUnion("correct", [
  z
    .object({
      id: z.uuid(),
      attemptUuid: z.uuid(),
      correct: z.literal(false),
      contradiction: ContradictionSchema,
      progress: PuzzleProgressSchema.optional(),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      attemptUuid: z.uuid(),
      correct: z.literal(true),
      reveal: AcceptedSolutionSchema,
      progress: PuzzleProgressSchema.optional(),
    })
    .strict(),
]);

export const HintRequestSchema = z.object({ level: z.int().positive() }).strict();

export const HintResponseSchema = EarnedHintSchema.extend({
  progress: PuzzleProgressSchema.optional(),
}).strict();

export const StatsResponseSchema = z
  .object({
    attempts: z.int().nonnegative(),
    hintsUsed: z.int().nonnegative(),
    solvedPuzzles: z.int().nonnegative(),
    completedCases: z.int().nonnegative(),
    currentStreak: z.int().nonnegative(),
    bestStreak: z.int().nonnegative(),
    lastCompletedDate: z.iso.date().nullable(),
    points: z.int().nonnegative().optional(),
  })
  .strict();
