import { AttemptRequestSchema, SquareSchema } from "@a-move-ago/api-contract";
import { z } from "zod";
import type { DraftState } from "./draft";

export interface GamePersistenceScope {
  actorKey: string;
  caseId: string;
  puzzleId: string;
  puzzleVersion: number;
}

type AttemptRequest = z.infer<typeof AttemptRequestSchema>;

const prefix = "a-move-ago:game:";
const maxRecords = 32;
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const DraftSchema = z.discriminatedUnion("tag", [
  z.object({ tag: z.literal("select-current") }).strict(),
  z.object({ tag: z.literal("select-previous"), currentSquare: SquareSchema }).strict(),
  z.object({
    tag: z.literal("configure"),
    currentSquare: SquareSchema,
    previousSquare: SquareSchema,
    special: z.enum(["normal", "castle-kingside", "castle-queenside", "en-passant", "unpromotion"]),
    captureType: z.enum(["p", "n", "b", "r", "q"]).nullable(),
  }).strict(),
]);
const RecordSchema = z.object({
  schema: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  draft: DraftSchema.optional(),
  pending: AttemptRequestSchema.optional(),
}).strict();
type GameRecord = z.infer<typeof RecordSchema>;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function gamePersistenceKey(scope?: GamePersistenceScope): string | null {
  if (!scope?.actorKey || !scope.caseId || !scope.puzzleId || !Number.isInteger(scope.puzzleVersion) || scope.puzzleVersion < 1) return null;
  return `${prefix}v1:${JSON.stringify([scope.actorKey, scope.caseId, scope.puzzleId, scope.puzzleVersion])}`;
}

function parseRecord(raw: string | null): GameRecord | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.updatedAt < Date.now() - retentionMs || parsed.data.updatedAt > Date.now() + 60_000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function readRecord(scope?: GamePersistenceScope): GameRecord | null {
  const key = gamePersistenceKey(scope);
  const store = storage();
  if (!key || !store) return null;
  try {
    const raw = store.getItem(key);
    const record = parseRecord(raw);
    if (!record || (record.pending && (record.pending.caseId !== scope?.caseId || record.pending.puzzleId !== scope?.puzzleId))) {
      if (raw !== null) store.removeItem(key);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function writeRecord(scope: GamePersistenceScope | undefined, record: Omit<GameRecord, "schema" | "updatedAt">): void {
  const key = gamePersistenceKey(scope);
  const store = storage();
  if (!key || !store) return;
  try {
    if (!record.draft && !record.pending) {
      store.removeItem(key);
      return;
    }
    const records: Array<{ key: string; updatedAt: number; pending: boolean }> = [];
    for (let index = 0; index < store.length; index += 1) {
      const candidate = store.key(index);
      if (!candidate?.startsWith(prefix) || candidate === key) continue;
      const previous = parseRecord(store.getItem(candidate));
      records.push({ key: candidate, updatedAt: previous?.updatedAt ?? 0, pending: previous?.pending !== undefined });
    }
    records.sort((left, right) => left.updatedAt - right.updatedAt);
    for (const item of records) {
      if (item.updatedAt === 0) store.removeItem(item.key);
    }
    // Do not evict an unresolved UUID merely because the player browsed more puzzles.
    const retained = records.filter((item) => item.updatedAt !== 0 && !item.pending);
    const available = maxRecords - (record.pending ? 0 : 1);
    for (const item of retained.slice(0, Math.max(0, retained.length - available))) {
      store.removeItem(item.key);
    }
    store.setItem(key, JSON.stringify({ schema: 1, updatedAt: Date.now(), ...record }));
  } catch {
    // Storage is optional: private browsing and a full device must not prevent play.
  }
}

export function readGameDraft(scope?: GamePersistenceScope): DraftState | null {
  return readRecord(scope)?.draft ?? null;
}

export function writeGameDraft(scope: GamePersistenceScope | undefined, draft: DraftState): void {
  const record = readRecord(scope);
  writeRecord(scope, {
    ...(draft.tag !== "select-current" ? { draft } : {}),
    ...(record?.pending ? { pending: record.pending } : {}),
  });
}

export function clearGameDraft(scope?: GamePersistenceScope): void {
  const pending = readRecord(scope)?.pending;
  writeRecord(scope, pending ? { pending } : {});
}

// Call only after the server has confirmed this puzzle is solved.
export function clearCompletedGame(scope?: GamePersistenceScope): void {
  writeRecord(scope, {});
}

export function readPendingAttempt(scope?: GamePersistenceScope): AttemptRequest | null {
  return readRecord(scope)?.pending ?? null;
}

export function writePendingAttempt(scope: GamePersistenceScope | undefined, request: AttemptRequest): void {
  if (request.caseId !== scope?.caseId || request.puzzleId !== scope?.puzzleId) return;
  const retraction = request.retraction;
  writeRecord(scope, {
    draft: {
      tag: "configure",
      currentSquare: retraction.currentSquare,
      previousSquare: retraction.previousSquare,
      special: retraction.special,
      captureType: retraction.restoredPiece?.type ?? null,
    },
    pending: request,
  });
}

export function clearPendingAttempt(scope: GamePersistenceScope | undefined, attemptUuid: string): void {
  const record = readRecord(scope);
  if (record?.pending?.attemptUuid !== attemptUuid) return;
  writeRecord(scope, record.draft ? { draft: record.draft } : {});
}

export function clearGamePersistence(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // An inaccessible store cannot restore any prior draft either.
  }
}
