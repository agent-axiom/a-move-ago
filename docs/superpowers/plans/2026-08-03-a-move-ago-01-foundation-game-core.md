# A MOVE AGO Foundation and Game Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать воспроизводимый TypeScript-monorepo, общий API-контракт, чистое ретро-шахматное ядро и одну валидируемую демонстрационную задачу.

**Architecture:** Все клиенты и Worker используют Zod-схемы из `api-contract`, а `game-core` не импортирует UI, storage или Cloudflare API. Правильные ответы представлены curated solutions; ядро строит предыдущую позицию и сравнивает нормализованные реконструкции, но не пытается быть универсальным retro solver.

**Tech Stack:** Node.js 24, npm workspaces, TypeScript 7, Biome 2, Vitest 4, Zod 4, chess.js 1.4, fast-check 4.

---

**Порядок:** план 1 из 5. После него выполнять `02-api-gameplay`, `03-telegram-auth`, `04-client`, `05-android-delivery`.

## Карта файлов

- `package.json` — корневые workspaces и единые команды проверки.
- `package-lock.json` — точная фиксация dependency graph.
- `.nvmrc` — Node 24 для локальной среды и CI.
- `.gitignore` — generated, local D1, Android и secret artifacts.
- `biome.json` — форматирование и lint для всего monorepo.
- `tsconfig.base.json` — общие строгие TypeScript options.
- `packages/api-contract/src/chess.ts` — общие шахматные примитивы и схема реконструкции.
- `packages/api-contract/src/puzzles.ts` — публичная/приватная модель задачи.
- `packages/api-contract/src/api.ts` — request/response/error schemas.
- `packages/game-core/src/fen.ts` — FEN parse/serialize.
- `packages/game-core/src/retract.ts` — построение позиции ход назад.
- `packages/game-core/src/evaluate.ts` — сравнение ответа и классификация противоречий.
- `content/samples/2026-08-03.json` — одно публичное daily case с capture-задачей.
- `tools/src/validate-content.ts` — CLI валидации JSON-контента.
- `tools/src/validate-content.test.ts` — CLI/domain regression tests.

### Task 1: Инициализировать monorepo toolchain

**Files:**
- Create: `package.json`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `biome.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `package-lock.json` через `npm install`

- [ ] **Step 1: Создать корневой manifest**

```json
{
  "name": "a-move-ago",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24 <25",
    "npm": ">=11"
  },
  "workspaces": [
    "apps/*",
    "packages/*",
    "tools"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "check": "biome check .",
    "format": "biome format --write .",
    "format:check": "biome format .",
    "lint": "biome lint .",
    "test": "npm run test --workspaces --if-present",
    "test:run": "vitest run",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.6",
    "@types/node": "24.13.3",
    "tsx": "4.23.5",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 2: Создать runtime и repository config**

`.nvmrc`:

```text
24
```

`.editorconfig`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.gitignore`:

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
.wrangler/
.dev.vars
.env
.env.*
!.env.example
*.keystore
*.jks
*.aab
*.apk
apps/client/android/.gradle/
apps/client/android/local.properties
.DS_Store
```

- [ ] **Step 3: Создать строгие formatter/type/test configs**

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "files": {
    "includes": ["**", "!**/dist", "!**/node_modules", "!apps/client/android"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all"
    }
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": false,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
  },
});
```

- [ ] **Step 4: Установить зависимости и зафиксировать lockfile**

Run: `npm install`

Expected: exit `0`; создан `package-lock.json`; `npm ls --depth=0` показывает Biome, TypeScript и Vitest без `invalid`/`missing`.

- [ ] **Step 5: Проверить toolchain**

Run: `npm run check`

Expected: exit `0`; вывод Biome содержит слово `Checked` и не содержит diagnostics.

Run: `npx tsc --version`

Expected: `Version 7.0.2`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .nvmrc .gitignore .editorconfig biome.json tsconfig.base.json vitest.config.ts
git commit -m "chore: initialize TypeScript monorepo"
```

### Task 2: Зафиксировать общий шахматный и HTTP-контракт

**Files:**
- Create: `packages/api-contract/package.json`
- Create: `packages/api-contract/tsconfig.json`
- Create: `packages/api-contract/src/chess.ts`
- Create: `packages/api-contract/src/puzzles.ts`
- Create: `packages/api-contract/src/api.ts`
- Create: `packages/api-contract/src/index.ts`
- Test: `packages/api-contract/src/contracts.test.ts`

- [ ] **Step 1: Создать package manifest и TypeScript config**

`packages/api-contract/package.json`:

```json
{
  "name": "@a-move-ago/api-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run src",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`packages/api-contract/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Написать failing contract tests**

`packages/api-contract/src/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AttemptRequestSchema,
  PuzzlePrivateSchema,
  RetractionSchema,
  SquareSchema,
} from "./index";

describe("shared contracts", () => {
  it("accepts a capture retraction", () => {
    expect(
      RetractionSchema.parse({
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      }),
    ).toMatchObject({ currentSquare: "d5", previousSquare: "e4" });
  });

  it("rejects non-board coordinates", () => {
    expect(SquareSchema.safeParse("i9").success).toBe(false);
  });

  it("keeps accepted solutions private", () => {
    const parsed = PuzzlePrivateSchema.parse(samplePuzzle);
    expect(parsed.acceptedSolutions).toHaveLength(1);
    expect("acceptedSolutions" in parsed.public).toBe(false);
  });

  it("requires separate client idempotency and puzzle ids", () => {
    expect(
      AttemptRequestSchema.safeParse({
        attemptUuid: crypto.randomUUID(),
        caseId: "case-2026-08-03",
        puzzleId: "opening-exd5",
        retraction: samplePuzzle.acceptedSolutions[0]?.retraction,
      }).success,
    ).toBe(true);
  });

  it("rejects impossible restored-piece and special-move metadata", () => {
    const base = samplePuzzle.acceptedSolutions[0]!.retraction;
    expect(RetractionSchema.safeParse({
      ...base,
      restoredPiece: { color: "b", type: "k", square: "d5" },
    }).success).toBe(false);
    expect(RetractionSchema.safeParse({
      ...base,
      restoredPiece: { color: "w", type: "p", square: "d5" },
    }).success).toBe(false);
    expect(RetractionSchema.safeParse({
      ...base,
      restoredPiece: { color: "b", type: "p", square: "d4" },
    }).success).toBe(false);
    expect(RetractionSchema.safeParse({
      currentSquare: "d6",
      previousSquare: "e5",
      movedPiece: { color: "w", type: "p" },
      restoredPiece: { color: "b", type: "p", square: "d5" },
      special: "normal",
    }).success).toBe(false);
  });
});

const samplePuzzle = {
  public: {
    id: "opening-exd5",
    version: 1,
    title: "The missing pawn",
    prompt: "What happened one move ago?",
    postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    retractingColor: "w",
    maxHints: 2,
    provenance: "Original A MOVE AGO sample",
    license: "CC-BY-4.0",
  },
  acceptedSolutions: [
    {
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      },
      previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
      forwardSan: "exd5",
      explanation: "The white e-pawn captured the black pawn on d5.",
      historyConstraints: [
        { kind: "previous-castling", value: "KQkq" },
        { kind: "previous-en-passant", value: "d6" },
      ],
    },
  ],
  hints: ["A pawn changed files.", "Restore the pawn that disappeared from d5."],
  contradictionExplanations: {
    NOT_THE_LAST_MOVE: "That reconstruction does not fit the case evidence.",
  },
};
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -w @a-move-ago/api-contract`

Expected: FAIL with module/export errors for `RetractionSchema` and related schemas.

- [ ] **Step 4: Implement шахматные примитивы**

`packages/api-contract/src/chess.ts`:

```ts
import { z } from "zod";

export const SquareSchema = z.string().regex(/^[a-h][1-8]$/);
export type Square = z.infer<typeof SquareSchema>;

export const ColorSchema = z.enum(["w", "b"]);
export type Color = z.infer<typeof ColorSchema>;

export const PieceTypeSchema = z.enum(["p", "n", "b", "r", "q", "k"]);
export type PieceType = z.infer<typeof PieceTypeSchema>;

export const PieceSchema = z.object({
  color: ColorSchema,
  type: PieceTypeSchema,
}).strict();
export type Piece = z.infer<typeof PieceSchema>;

export const PlacedPieceSchema = PieceSchema.extend({
  square: SquareSchema,
}).strict();

export const RestoredPieceSchema = z.object({
  color: ColorSchema,
  type: z.enum(["p", "n", "b", "r", "q"]),
  square: SquareSchema,
}).strict();

export const RetractionSchema = z
  .object({
    currentSquare: SquareSchema,
    previousSquare: SquareSchema,
    movedPiece: PieceSchema,
    restoredPiece: RestoredPieceSchema.nullable(),
    special: z.enum(["normal", "castle-kingside", "castle-queenside", "en-passant", "unpromotion"]),
  })
  .strict()
  .refine((value) => value.currentSquare !== value.previousSquare, {
    message: "currentSquare and previousSquare must differ",
  })
  .superRefine((value, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    const previousFile = value.previousSquare.charCodeAt(0) - 97;
    const currentFile = value.currentSquare.charCodeAt(0) - 97;
    const previousRank = Number(value.previousSquare[1]);
    const currentRank = Number(value.currentSquare[1]);
    const direction = value.movedPiece.color === "w" ? 1 : -1;
    if (value.restoredPiece?.color === value.movedPiece.color) {
      fail("restoredPiece must belong to the opposite color");
    }
    if (value.special === "normal" && value.restoredPiece?.square !== undefined
      && value.restoredPiece.square !== value.currentSquare) {
      fail("a normal capture restores on currentSquare");
    }
    if (value.special === "castle-kingside" || value.special === "castle-queenside") {
      if (value.movedPiece.type !== "k" || value.restoredPiece !== null) {
        fail("castling retracts a king without a restored piece");
      }
    }
    if (value.special === "en-passant") {
      const expectedRestore = `${value.currentSquare[0]}${value.previousSquare[1]}`;
      if (
        value.movedPiece.type !== "p"
        || value.restoredPiece?.type !== "p"
        || previousRank !== (value.movedPiece.color === "w" ? 5 : 4)
        || Math.abs(currentFile - previousFile) !== 1
        || currentRank !== previousRank + direction
        || value.restoredPiece.square !== expectedRestore
      ) {
        fail("invalid en-passant retraction metadata");
      }
    }
    if (value.special === "unpromotion") {
      const previousPromotionRank = value.movedPiece.color === "w" ? 7 : 2;
      const promotionRank = value.movedPiece.color === "w" ? 8 : 1;
      const fileDistance = Math.abs(currentFile - previousFile);
      if (
        value.movedPiece.type === "p"
        || value.movedPiece.type === "k"
        || previousRank !== previousPromotionRank
        || currentRank !== promotionRank
        || fileDistance > 1
        || (fileDistance === 0 && value.restoredPiece !== null)
        || (fileDistance === 1 && value.restoredPiece?.square !== value.currentSquare)
      ) {
        fail("invalid unpromotion metadata");
      }
    }
  });
export type Retraction = z.infer<typeof RetractionSchema>;
```

- [ ] **Step 5: Implement puzzle и API schemas**

`packages/api-contract/src/puzzles.ts`:

```ts
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
  z.string().min(1).regex(/^K?Q?k?q?$/),
]);

export const HistoryConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("previous-castling"), value: CastlingRightsSchema }).strict(),
  z.object({
    kind: z.literal("previous-en-passant"),
    value: z.union([SquareSchema, z.literal("-")]),
  }).strict(),
]);

export const PuzzlePublicSchema = z.object({
  id: z.string().min(1),
  version: z.int().positive(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  postFen: z.string().min(1),
  retractingColor: ColorSchema,
  maxHints: z.int().nonnegative(),
  provenance: z.string().min(1),
  license: z.string().min(1),
}).strict();

export const AcceptedSolutionSchema = z.object({
  retraction: RetractionSchema,
  previousFen: z.string().min(1),
  forwardSan: z.string().min(1),
  explanation: z.string().min(1),
  historyConstraints: z.array(HistoryConstraintSchema),
}).strict();

export const PuzzlePrivateSchema = z.object({
  public: PuzzlePublicSchema,
  acceptedSolutions: z.array(AcceptedSolutionSchema).min(1),
  hints: z.array(z.string().min(1)),
  contradictionExplanations: z.partialRecord(
    ContradictionCodeSchema,
    z.string().min(1),
  ),
}).strict();

export type PuzzlePublic = z.infer<typeof PuzzlePublicSchema>;
export type PuzzlePrivate = z.infer<typeof PuzzlePrivateSchema>;
export type AcceptedSolution = z.infer<typeof AcceptedSolutionSchema>;
```

`packages/api-contract/src/api.ts`:

```ts
import { z } from "zod";
import {
  AcceptedSolutionSchema,
  ContradictionCodeSchema,
  PuzzlePublicSchema,
} from "./puzzles";
import { RetractionSchema } from "./chess";

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
  }).strict(),
}).strict();

export const SessionIssuedSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  kind: z.enum(["guest", "telegram"]),
}).strict();

export const TelegramProfileSchema = z.object({
  telegramUserId: z.string().regex(/^\d+$/),
  displayName: z.string().min(1),
  username: z.string().nullable(),
  avatarUrl: z.url().nullable(),
}).strict();

export const MeResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("guest"), profile: z.null() }).strict(),
  z.object({ kind: z.literal("telegram"), profile: TelegramProfileSchema }).strict(),
]);

export const DailyCaseResponseSchema = z.object({
  id: z.string().min(1),
  date: z.iso.date(),
  title: z.string().min(1),
  puzzles: z.array(PuzzlePublicSchema).min(1),
  solvedPuzzleIds: z.array(z.string()),
}).strict();

export const AttemptRequestSchema = z.object({
  attemptUuid: z.uuid(),
  caseId: z.string().min(1),
  puzzleId: z.string().min(1),
  retraction: RetractionSchema,
}).strict();

export const ContradictionSchema = z.object({
  code: ContradictionCodeSchema,
  message: z.string().min(1),
}).strict();

export const AttemptResultSchema = z.discriminatedUnion("correct", [
  z.object({
    id: z.uuid(),
    attemptUuid: z.uuid(),
    correct: z.literal(false),
    contradiction: ContradictionSchema,
  }).strict(),
  z.object({
    id: z.uuid(),
    attemptUuid: z.uuid(),
    correct: z.literal(true),
    reveal: AcceptedSolutionSchema,
  }).strict(),
]);

export const HintRequestSchema = z.object({
  level: z.int().positive(),
}).strict();
export const HintResponseSchema = z.object({
  level: z.int().positive(),
  text: z.string().min(1),
  exhausted: z.boolean(),
}).strict();

export const StatsResponseSchema = z.object({
  attempts: z.int().nonnegative(),
  hintsUsed: z.int().nonnegative(),
  solvedPuzzles: z.int().nonnegative(),
  completedCases: z.int().nonnegative(),
  currentStreak: z.int().nonnegative(),
  bestStreak: z.int().nonnegative(),
  lastCompletedDate: z.iso.date().nullable(),
}).strict();
```

`packages/api-contract/src/index.ts`:

```ts
export * from "./api";
export * from "./chess";
export * from "./puzzles";
```

- [ ] **Step 6: Run tests and typecheck GREEN**

Run: `npm test -w @a-move-ago/api-contract`

Expected: PASS, 5 tests.

Run: `npm run typecheck -w @a-move-ago/api-contract`

Expected: exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/api-contract package.json package-lock.json
git commit -m "feat: define shared puzzle contracts"
```

### Task 3: Реализовать строгий FEN round-trip

**Files:**
- Create: `packages/game-core/package.json`
- Create: `packages/game-core/tsconfig.json`
- Create: `packages/game-core/src/fen.ts`
- Create: `packages/game-core/src/index.ts`
- Test: `packages/game-core/src/fen.test.ts`

- [ ] **Step 1: Создать game-core package**

`packages/game-core/package.json`:

```json
{
  "name": "@a-move-ago/game-core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run src",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@a-move-ago/api-contract": "0.0.0",
    "chess.js": "1.4.0"
  },
  "devDependencies": {
    "fast-check": "4.9.0",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`packages/game-core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Write failing FEN tests**

`packages/game-core/src/fen.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFen, serializeFen } from "./fen";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

describe("FEN", () => {
  it("round-trips all six FEN fields", () => {
    expect(serializeFen(parseFen(postFen))).toBe(postFen);
  });

  it("maps d5 to a white pawn", () => {
    expect(parseFen(postFen).board.d5).toEqual({ color: "w", type: "p" });
  });

  it("rejects malformed FEN", () => {
    expect(() => parseFen("8/8/8")).toThrow("Invalid FEN");
  });

  it("round-trips generated legal move counters", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 1, max: 500 }),
        (halfmove, fullmove) => {
          const fen = postFen.replace(/0 2$/, `${halfmove} ${fullmove}`);
          expect(serializeFen(parseFen(fen))).toBe(fen);
        },
      ),
    );
  });
});
```

- [ ] **Step 3: Run test to verify RED**

Run: `npm test -w @a-move-ago/game-core -- src/fen.test.ts`

Expected: FAIL because `./fen` does not exist.

- [ ] **Step 4: Implement parse/serialize**

`packages/game-core/src/fen.ts`:

```ts
import type { Color, Piece, PieceType, Square } from "@a-move-ago/api-contract";
import { validateFen } from "chess.js";

export type Board = Partial<Record<Square, Piece>>;

export interface FenState {
  board: Board;
  turn: Color;
  castling: string;
  enPassant: Square | "-";
  halfmove: number;
  fullmove: number;
}

const files = "abcdefgh";

export function parseFen(fen: string): FenState {
  const validation = validateFen(fen);
  if (!validation.ok) throw new Error(`Invalid FEN: ${validation.error}`);
  const [placement, turn, castling, enPassant, halfmove, fullmove] = fen.split(" ");
  if (!placement || !turn || !castling || !enPassant || !halfmove || !fullmove) {
    throw new Error("Invalid FEN: expected six fields");
  }

  const board: Board = {};
  placement.split("/").forEach((rankText, rankIndex) => {
    let fileIndex = 0;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        continue;
      }
      const square = `${files[fileIndex]}${8 - rankIndex}` as Square;
      board[square] = {
        color: char === char.toUpperCase() ? "w" : "b",
        type: char.toLowerCase() as PieceType,
      };
      fileIndex += 1;
    }
  });

  return {
    board,
    turn: turn as Color,
    castling,
    enPassant: enPassant as Square | "-",
    halfmove: Number(halfmove),
    fullmove: Number(fullmove),
  };
}

export function serializeFen(state: FenState): string {
  const ranks = Array.from({ length: 8 }, (_, rankIndex) => {
    let empty = 0;
    let text = "";
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const square = `${files[fileIndex]}${8 - rankIndex}` as Square;
      const piece = state.board[square];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) text += String(empty);
      empty = 0;
      const symbol = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
      text += symbol;
    }
    if (empty) text += String(empty);
    return text;
  });
  return `${ranks.join("/")} ${state.turn} ${state.castling} ${state.enPassant} ${state.halfmove} ${state.fullmove}`;
}
```

`packages/game-core/src/index.ts`:

```ts
export * from "./fen";
```

- [ ] **Step 5: Run tests GREEN**

Run: `npm test -w @a-move-ago/game-core -- src/fen.test.ts`

Expected: PASS, 4 tests.

Run: `npm run typecheck -w @a-move-ago/game-core`

Expected: exit `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/game-core package.json package-lock.json
git commit -m "feat: parse retro puzzle positions"
```

### Task 4: Построить обычную предыдущую позицию

**Files:**
- Create: `packages/game-core/src/retract.ts`
- Modify: `packages/game-core/src/index.ts`
- Test: `packages/game-core/src/retract.test.ts`

- [ ] **Step 1: Write failing normal/capture tests**

`packages/game-core/src/retract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyRetraction, parseFen, RetractionError } from "./index";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
const capture = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
} as const;

describe("applyRetraction", () => {
  it("moves the pawn back and restores the captured pawn", () => {
    const prior = applyRetraction(parseFen(postFen), capture);
    expect(prior.board.e4).toEqual({ color: "w", type: "p" });
    expect(prior.board.d5).toEqual({ color: "b", type: "p" });
    expect(prior.turn).toBe("w");
  });

  it("rejects an occupied previous square", () => {
    expect(() => applyRetraction(parseFen(postFen), { ...capture, previousSquare: "e2" })).toThrowError(
      new RetractionError("PREVIOUS_SQUARE_OCCUPIED"),
    );
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `npm test -w @a-move-ago/game-core -- src/retract.test.ts`

Expected: FAIL because `applyRetraction` and `RetractionError` are not exported.

- [ ] **Step 3: Implement minimal normal retraction**

`packages/game-core/src/retract.ts`:

```ts
import type { Retraction } from "@a-move-ago/api-contract";
import type { FenState } from "./fen";

export type RetractionErrorCode =
  | "NO_PIECE_ON_CURRENT_SQUARE"
  | "WRONG_COLOR"
  | "PREVIOUS_SQUARE_OCCUPIED"
  | "RESTORE_SQUARE_OCCUPIED"
  | "INVALID_SPECIAL_MOVE";

export class RetractionError extends Error {
  constructor(readonly code: RetractionErrorCode) {
    super(code);
    this.name = "RetractionError";
  }
}

export function applyRetraction(post: FenState, move: Retraction): FenState {
  const board = { ...post.board };
  const current = board[move.currentSquare];
  if (!current) throw new RetractionError("NO_PIECE_ON_CURRENT_SQUARE");
  if (current.color !== move.movedPiece.color || current.type !== move.movedPiece.type) {
    throw new RetractionError("WRONG_COLOR");
  }
  if (board[move.previousSquare]) throw new RetractionError("PREVIOUS_SQUARE_OCCUPIED");

  delete board[move.currentSquare];
  board[move.previousSquare] = current;

  if (move.restoredPiece) {
    if (board[move.restoredPiece.square]) throw new RetractionError("RESTORE_SQUARE_OCCUPIED");
    board[move.restoredPiece.square] = {
      color: move.restoredPiece.color,
      type: move.restoredPiece.type,
    };
  }

  return { ...post, board, turn: move.movedPiece.color };
}
```

Append to `packages/game-core/src/index.ts`:

```ts
export * from "./retract";
```

- [ ] **Step 4: Run tests GREEN**

Run: `npm test -w @a-move-ago/game-core -- src/retract.test.ts`

Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/game-core/src/retract.ts packages/game-core/src/retract.test.ts packages/game-core/src/index.ts
git commit -m "feat: reconstruct prior board positions"
```

### Task 5: Добавить специальные ретракции

**Files:**
- Modify: `packages/game-core/src/retract.ts`
- Modify: `packages/game-core/src/retract.test.ts`

- [ ] **Step 1: Add failing castling, en-passant and unpromotion tests**

Add to `packages/game-core/src/retract.test.ts`:

```ts
it("retracts white kingside castling", () => {
  const post = parseFen("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1");
  const prior = applyRetraction(post, {
    currentSquare: "g1",
    previousSquare: "e1",
    movedPiece: { color: "w", type: "k" },
    restoredPiece: null,
    special: "castle-kingside",
  });
  expect(prior.board.e1).toEqual({ color: "w", type: "k" });
  expect(prior.board.h1).toEqual({ color: "w", type: "r" });
  expect(prior.board.f1).toBeUndefined();
});

it("retracts en passant onto a different restore square", () => {
  const post = parseFen("4k3/8/3P4/8/8/8/8/4K3 b - - 0 1");
  const prior = applyRetraction(post, {
    currentSquare: "d6",
    previousSquare: "e5",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "en-passant",
  });
  expect(prior.board.e5).toEqual({ color: "w", type: "p" });
  expect(prior.board.d5).toEqual({ color: "b", type: "p" });
});

it("turns an unpromoted piece back into a pawn", () => {
  const post = parseFen("Q3k3/8/8/8/8/8/8/4K3 b - - 0 1");
  const prior = applyRetraction(post, {
    currentSquare: "a8",
    previousSquare: "a7",
    movedPiece: { color: "w", type: "q" },
    restoredPiece: null,
    special: "unpromotion",
  });
  expect(prior.board.a7).toEqual({ color: "w", type: "p" });
});
```

- [ ] **Step 2: Run focused tests RED**

Run: `npm test -w @a-move-ago/game-core -- src/retract.test.ts`

Expected: castling and unpromotion tests FAIL; normal capture tests stay PASS.

- [ ] **Step 3: Implement special invariants**

Add helpers to `packages/game-core/src/retract.ts` and call them after the current piece is removed but before returning:

```ts
function retractCastle(board: FenState["board"], move: Retraction): void {
  const rank = move.movedPiece.color === "w" ? "1" : "8";
  const kingSide = move.special === "castle-kingside";
  const expectedCurrent = `${kingSide ? "g" : "c"}${rank}`;
  const expectedPrevious = `e${rank}`;
  const rookCurrent = `${kingSide ? "f" : "d"}${rank}` as keyof typeof board;
  const rookPrevious = `${kingSide ? "h" : "a"}${rank}` as keyof typeof board;
  if (move.currentSquare !== expectedCurrent || move.previousSquare !== expectedPrevious) {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  const rook = board[rookCurrent];
  if (!rook || rook.type !== "r" || rook.color !== move.movedPiece.color || board[rookPrevious]) {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  delete board[rookCurrent];
  board[rookPrevious] = rook;
}

function priorMovedPiece(move: Retraction) {
  if (move.special !== "unpromotion") return move.movedPiece;
  const targetRank = move.movedPiece.color === "w" ? "7" : "2";
  if (!move.previousSquare.endsWith(targetRank) || move.movedPiece.type === "p" || move.movedPiece.type === "k") {
    throw new RetractionError("INVALID_SPECIAL_MOVE");
  }
  return { color: move.movedPiece.color, type: "p" as const };
}
```

Replace assignment of the moved piece with:

```ts
board[move.previousSquare] = priorMovedPiece(move);
if (move.special === "castle-kingside" || move.special === "castle-queenside") {
  retractCastle(board, move);
}
if (move.special === "en-passant" && move.restoredPiece?.type !== "p") {
  throw new RetractionError("INVALID_SPECIAL_MOVE");
}
```

- [ ] **Step 4: Run tests GREEN**

Run: `npm test -w @a-move-ago/game-core -- src/retract.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/game-core/src/retract.ts packages/game-core/src/retract.test.ts
git commit -m "feat: support special move retractions"
```

### Task 6: Оценить ответ без runtime retro solver

**Files:**
- Create: `packages/game-core/src/evaluate.ts`
- Modify: `packages/game-core/src/index.ts`
- Test: `packages/game-core/src/evaluate.test.ts`

- [ ] **Step 1: Write failing evaluator tests**

`packages/game-core/src/evaluate.test.ts`:

```ts
import type { PuzzlePrivate } from "@a-move-ago/api-contract";
import { describe, expect, it } from "vitest";
import { evaluateRetraction, replayAcceptedSolution } from "./evaluate";

const puzzle: PuzzlePrivate = {
  public: {
    id: "opening-exd5",
    version: 1,
    title: "The missing pawn",
    prompt: "What happened one move ago?",
    postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    retractingColor: "w",
    maxHints: 2,
    provenance: "Original A MOVE AGO sample",
    license: "CC-BY-4.0",
  },
  acceptedSolutions: [
    {
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      },
      previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
      forwardSan: "exd5",
      explanation: "The white e-pawn captured the black pawn on d5.",
      historyConstraints: [
        { kind: "previous-castling", value: "KQkq" },
        { kind: "previous-en-passant", value: "d6" },
      ],
    },
  ],
  hints: ["A pawn changed files.", "Restore the pawn that disappeared from d5."],
  contradictionExplanations: {
    NOT_THE_LAST_MOVE: "That reconstruction does not fit the case evidence.",
  },
};

describe("evaluateRetraction", () => {
  it("returns the curated reveal for an exact solution", () => {
    expect(evaluateRetraction(puzzle, puzzle.acceptedSolutions[0]!.retraction)).toEqual({
      correct: true,
      reveal: puzzle.acceptedSolutions[0],
    });
  });

  it("turns structural failures into stable contradiction codes", () => {
    const result = evaluateRetraction(puzzle, {
      ...puzzle.acceptedSolutions[0]!.retraction,
      previousSquare: "e2",
    });
    expect(result).toMatchObject({
      correct: false,
      contradiction: { code: "PREVIOUS_SQUARE_OCCUPIED" },
    });
  });

  it("uses a generic evidence contradiction for a legal but wrong reconstruction", () => {
    const result = evaluateRetraction(puzzle, {
      currentSquare: "d5",
      previousSquare: "d4",
      movedPiece: { color: "w", type: "p" },
      restoredPiece: null,
      special: "normal",
    });
    expect(result).toMatchObject({
      correct: false,
      contradiction: {
        code: "NOT_THE_LAST_MOVE",
        message: "That reconstruction does not fit the case evidence.",
      },
    });
  });

  it("turns an adversarial invalid reconstructed FEN into a contradiction", () => {
    const answer = {
      ...puzzle.acceptedSolutions[0]!.retraction,
      restoredPiece: { color: "b", type: "k", square: "d5" },
    } as never;
    expect(evaluateRetraction(puzzle, answer)).toMatchObject({
      correct: false,
      contradiction: { code: "INVALID_SPECIAL_MOVE" },
    });
  });

  it("rejects a reconstructed position where the side not to move is already in check", () => {
    const result = evaluateRetraction(
      {
        ...puzzle,
        public: {
          ...puzzle.public,
          postFen: "4k3/8/8/8/8/8/1R6/4K3 b - - 1 1",
        },
      },
      {
        currentSquare: "b2",
        previousSquare: "e2",
        movedPiece: { color: "w", type: "r" },
        restoredPiece: null,
        special: "normal",
      },
    );
    expect(result).toMatchObject({
      correct: false,
      contradiction: { code: "OPPONENT_KING_IN_CHECK" },
    });
  });

  it("replays the curated prior position to the exact post FEN and SAN", () => {
    expect(replayAcceptedSolution(puzzle, puzzle.acceptedSolutions[0]!)).toBe(
      puzzle.public.postFen,
    );
    expect(() =>
      replayAcceptedSolution(puzzle, {
        ...puzzle.acceptedSolutions[0]!,
        forwardSan: "d5",
      }),
    ).toThrow("forwardSan");
  });

  it("selects either of multiple curated equivalent last moves", () => {
    const makeSolution = (previousSquare: "a1" | "b2", previousFen: string) => ({
      retraction: {
        currentSquare: "a2" as const,
        previousSquare,
        movedPiece: { color: "w" as const, type: "r" as const },
        restoredPiece: null,
        special: "normal" as const,
      },
      previousFen,
      forwardSan: "Ra2",
      explanation: `The rook came from ${previousSquare}.`,
      historyConstraints: [
        { kind: "previous-castling" as const, value: "-" as const },
        { kind: "previous-en-passant" as const, value: "-" as const },
      ],
    });
    const ambiguous: PuzzlePrivate = {
      public: {
        id: "two-roads",
        version: 1,
        title: "Two roads",
        prompt: "Which equivalent rook move happened?",
        postFen: "4k3/8/8/8/8/8/R7/4K3 b - - 1 1",
        retractingColor: "w",
        maxHints: 0,
        provenance: "Original A MOVE AGO test",
        license: "CC-BY-4.0",
      },
      acceptedSolutions: [
        makeSolution("a1", "4k3/8/8/8/8/8/8/R3K3 w - - 0 1"),
        makeSolution("b2", "4k3/8/8/8/8/8/1R6/4K3 w - - 0 1"),
      ],
      hints: [],
      contradictionExplanations: {},
    };
    for (const solution of ambiguous.acceptedSolutions) {
      expect(evaluateRetraction(ambiguous, solution.retraction)).toEqual({
        correct: true,
        reveal: solution,
      });
    }
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `npm test -w @a-move-ago/game-core -- src/evaluate.test.ts`

Expected: FAIL because `evaluateRetraction` is missing.

- [ ] **Step 3: Implement deterministic comparison and contradictions**

`packages/game-core/src/evaluate.ts`:

```ts
import type { AcceptedSolution, PuzzlePrivate, Retraction } from "@a-move-ago/api-contract";
import { Chess } from "chess.js";
import { applyRetraction, RetractionError } from "./retract";
import { parseFen, serializeFen, type FenState } from "./fen";

const messages = {
  NO_PIECE_ON_CURRENT_SQUARE: "There is no piece to move back from that square.",
  WRONG_COLOR: "That piece could not have made the last move.",
  PREVIOUS_SQUARE_OCCUPIED: "The proposed previous square was occupied.",
  RESTORE_SQUARE_OCCUPIED: "The captured piece cannot be restored on an occupied square.",
  INVALID_SPECIAL_MOVE: "That special move cannot be retracted from this position.",
  OPPONENT_KING_IN_CHECK: "The previous position leaves the side not to move in check.",
  NOT_THE_LAST_MOVE: "The position is legal, but the evidence does not support that last move.",
} as const;

type ContradictionCode = keyof typeof messages;

function contradiction(puzzle: PuzzlePrivate, code: ContradictionCode) {
  return {
    code,
    message: puzzle.contradictionExplanations[code] ?? messages[code],
  };
}

export type EvaluationResult =
  | { correct: true; reveal: PuzzlePrivate["acceptedSolutions"][number] }
  | {
      correct: false;
      contradiction: { code: keyof typeof messages; message: string };
    };

export function evaluateRetraction(puzzle: PuzzlePrivate, answer: Retraction): EvaluationResult {
  let prior: FenState;
  try {
    prior = applyRetraction(parseFen(puzzle.public.postFen), answer);
  } catch (error) {
    if (error instanceof RetractionError && error.code in messages) {
      const code = error.code as keyof typeof messages;
      return { correct: false, contradiction: contradiction(puzzle, code) };
    }
    return {
      correct: false,
      contradiction: contradiction(puzzle, "NOT_THE_LAST_MOVE"),
    };
  }

  try {
    if (sideNotToMoveIsInCheck(prior, answer.movedPiece.color)) {
      return {
        correct: false,
        contradiction: contradiction(puzzle, "OPPONENT_KING_IN_CHECK"),
      };
    }
  } catch {
    return {
      correct: false,
      contradiction: contradiction(puzzle, "INVALID_SPECIAL_MOVE"),
    };
  }

  const encoded = canonicalRetraction(answer);
  const accepted = puzzle.acceptedSolutions.find(
    (candidate) => canonicalRetraction(candidate.retraction) === encoded,
  );
  if (accepted) return { correct: true, reveal: accepted };

  return {
    correct: false,
    contradiction: contradiction(puzzle, "NOT_THE_LAST_MOVE"),
  };
}

function sideNotToMoveIsInCheck(prior: FenState, mover: Retraction["movedPiece"]["color"]): boolean {
  const opponent = mover === "w" ? "b" : "w";
  return new Chess(serializeFen({ ...prior, turn: opponent })).isCheck();
}

function canonicalRetraction(value: Retraction): string {
  return JSON.stringify({
    currentSquare: value.currentSquare,
    previousSquare: value.previousSquare,
    movedPiece: value.movedPiece,
    restoredPiece: value.restoredPiece,
    special: value.special,
  });
}

export function replayAcceptedSolution(
  puzzle: PuzzlePrivate,
  solution: AcceptedSolution,
): string {
  const game = new Chess(solution.previousFen);
  let replayed: ReturnType<Chess["move"]>;
  try {
    replayed = game.move({
      from: solution.retraction.previousSquare,
      to: solution.retraction.currentSquare,
      ...(solution.retraction.special === "unpromotion"
        ? { promotion: solution.retraction.movedPiece.type as "q" | "r" | "b" | "n" }
        : {}),
    });
  } catch {
    throw new Error(`${puzzle.public.id}: previousFen cannot replay the accepted move`);
  }
  if (!replayed || replayed.san !== solution.forwardSan) {
    throw new Error(`${puzzle.public.id}: forwardSan does not match the replayed move`);
  }
  const after = game.fen();
  if (after !== puzzle.public.postFen) {
    throw new Error(`${puzzle.public.id}: forward replay does not reproduce postFen`);
  }
  return after;
}
```

Append to `packages/game-core/src/index.ts`:

```ts
export * from "./evaluate";
```

- [ ] **Step 4: Run all game-core tests GREEN**

Run: `npm test -w @a-move-ago/game-core`

Expected: PASS for FEN, normal/special retractions and evaluation.

Run: `npm run typecheck -w @a-move-ago/game-core`

Expected: exit `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/game-core/src/evaluate.ts packages/game-core/src/evaluate.test.ts packages/game-core/src/index.ts
git commit -m "feat: evaluate curated retro solutions"
```

### Task 7: Добавить sample content и validator CLI

**Files:**
- Create: `content/samples/2026-08-03.json`
- Create: `tools/package.json`
- Create: `tools/tsconfig.json`
- Create: `tools/src/validate-content.ts`
- Test: `tools/src/validate-content.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the sample puzzle**

`content/samples/2026-08-03.json`:

```json
{
  "case": {
    "id": "case-2026-08-03",
    "date": "2026-08-03",
    "slug": "the-missing-pawn",
    "title": "The missing pawn",
    "generatedAt": 1785715200
  },
  "puzzles": [
    {
      "public": {
        "id": "opening-exd5",
        "version": 1,
        "title": "The missing pawn",
        "prompt": "What happened one move ago?",
        "postFen": "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
        "retractingColor": "w",
        "maxHints": 2,
        "provenance": "Original A MOVE AGO sample",
        "license": "CC-BY-4.0"
      },
      "acceptedSolutions": [
        {
          "retraction": {
            "currentSquare": "d5",
            "previousSquare": "e4",
            "movedPiece": { "color": "w", "type": "p" },
            "restoredPiece": { "color": "b", "type": "p", "square": "d5" },
            "special": "normal"
          },
          "previousFen": "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
          "forwardSan": "exd5",
          "explanation": "The white e-pawn captured the black pawn on d5.",
          "historyConstraints": [
            { "kind": "previous-castling", "value": "KQkq" },
            { "kind": "previous-en-passant", "value": "d6" }
          ]
        }
      ],
      "hints": [
        "A pawn changed files.",
        "Restore the pawn that disappeared from d5."
      ],
      "contradictionExplanations": {
        "NOT_THE_LAST_MOVE": "That reconstruction does not fit the case evidence."
      }
    }
  ]
}
```

- [ ] **Step 2: Write failing validator tests**

`tools/src/validate-content.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateContentDocument } from "./validate-content";

describe("content validator", () => {
  it("accepts the checked-in sample and can reproduce its previous FEN", async () => {
    const source = await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8");
    expect(validateContentDocument(source).puzzles[0]?.public.id).toBe("opening-exd5");
  });

  it("rejects a puzzle without provenance", () => {
    const invalid = JSON.stringify({ case: { id: "bad" }, puzzles: [] });
    expect(() => validateContentDocument(invalid)).toThrow();
  });

  it("rejects accepted history metadata that cannot replay to postFen", async () => {
    const source = await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8");
    const changed = JSON.parse(source);
    changed.puzzles[0].acceptedSolutions[0].forwardSan = "d5";
    expect(() => validateContentDocument(JSON.stringify(changed))).toThrow("forwardSan");
  });

  it("rejects a declared history constraint that disagrees with previousFen", async () => {
    const source = await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8");
    const changed = JSON.parse(source);
    changed.puzzles[0].acceptedSolutions[0].historyConstraints[1].value = "-";
    expect(() => validateContentDocument(JSON.stringify(changed))).toThrow(
      "previous en-passant constraint",
    );
  });

  it("rejects a public retracting color that disagrees with the position and solution", async () => {
    const source = await readFile(new URL("../../content/samples/2026-08-03.json", import.meta.url), "utf8");
    const changed = JSON.parse(source);
    changed.puzzles[0].public.retractingColor = "b";
    expect(() => validateContentDocument(JSON.stringify(changed))).toThrow("retractingColor");
  });
});
```

- [ ] **Step 3: Run test to verify RED**

Run: `npm test -w @a-move-ago/tools`

Expected: FAIL because the tools workspace and validator do not exist.

- [ ] **Step 4: Implement the validator package**

`tools/package.json`:

```json
{
  "name": "@a-move-ago/tools",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run src",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "validate-content": "tsx src/validate-content.ts ../content/samples"
  },
  "dependencies": {
    "@a-move-ago/api-contract": "0.0.0",
    "@a-move-ago/game-core": "0.0.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "tsx": "4.23.5",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`tools/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

`tools/src/validate-content.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PuzzlePrivateSchema } from "@a-move-ago/api-contract";
import {
  applyRetraction,
  evaluateRetraction,
  parseFen,
  replayAcceptedSolution,
} from "@a-move-ago/game-core";
import { z } from "zod";

export const ContentCaseSchema = z.object({
  case: z.object({
    id: z.string().min(1),
    date: z.iso.date(),
    slug: z.string().min(1),
    title: z.string().min(1),
    generatedAt: z.int().nonnegative(),
  }).strict(),
  puzzles: z.array(PuzzlePrivateSchema).min(1),
}).strict();

export type ContentCase = z.infer<typeof ContentCaseSchema>;

export function validateContentDocument(source: string): ContentCase {
  const content = ContentCaseSchema.parse(JSON.parse(source));
  const ids = new Set<string>();
  for (const puzzle of content.puzzles) {
    if (ids.has(puzzle.public.id)) throw new Error(`Duplicate puzzle id: ${puzzle.public.id}`);
    ids.add(puzzle.public.id);
    const post = parseFen(puzzle.public.postFen);
    const expectedPostTurn = puzzle.public.retractingColor === "w" ? "b" : "w";
    if (post.turn !== expectedPostTurn) {
      throw new Error(`${puzzle.public.id}: postFen turn disagrees with retractingColor`);
    }
    for (const solution of puzzle.acceptedSolutions) {
      if (solution.retraction.movedPiece.color !== puzzle.public.retractingColor) {
        throw new Error(`${puzzle.public.id}: solution disagrees with retractingColor`);
      }
      if (!evaluateRetraction(puzzle, solution.retraction).correct) {
        throw new Error(`${puzzle.public.id}: accepted solution is not a legal retraction`);
      }
      const reconstructed = applyRetraction(post, solution.retraction);
      const expected = parseFen(solution.previousFen);
      if (canonicalBoard(reconstructed.board) !== canonicalBoard(expected.board)) {
        throw new Error(`${puzzle.public.id}: retraction does not reproduce previousFen board`);
      }
      for (const constraint of solution.historyConstraints) {
        if (constraint.kind === "previous-castling" && expected.castling !== constraint.value) {
          throw new Error(`${puzzle.public.id}: previous castling constraint does not match`);
        }
        if (constraint.kind === "previous-en-passant" && expected.enPassant !== constraint.value) {
          throw new Error(`${puzzle.public.id}: previous en-passant constraint does not match`);
        }
      }
      replayAcceptedSolution(puzzle, solution);
    }
    if (puzzle.hints.length !== puzzle.public.maxHints) {
      throw new Error(`${puzzle.public.id}: maxHints must equal hints.length`);
    }
  }
  return content;
}

function canonicalBoard(board: ReturnType<typeof parseFen>["board"]): string {
  return JSON.stringify(Object.entries(board).sort(([left], [right]) => left.localeCompare(right)));
}

async function main(directory: string): Promise<void> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  let puzzles = 0;
  for (const name of names) {
    puzzles += validateContentDocument(await readFile(resolve(directory, name), "utf8")).puzzles.length;
  }
  console.log(`Validated ${names.length} case(s), ${puzzles} puzzle(s)`);
}

const directory = process.argv[2];
if (directory) await main(resolve(process.cwd(), directory));
```

Add to root `package.json` scripts:

```json
"content:validate": "npm run validate-content -w @a-move-ago/tools"
```

- [ ] **Step 5: Install workspace links and run GREEN**

Run: `npm install`

Expected: exit `0`, lockfile contains all three workspaces.

Run: `npm test -w @a-move-ago/tools`

Expected: PASS, 5 tests.

Run: `npm run content:validate`

Expected: `Validated 1 case(s), 1 puzzle(s)`.

- [ ] **Step 6: Run milestone verification**

Run: `npm run check`

Expected: exit `0`.

Run: `npm run typecheck`

Expected: exit `0` for `api-contract`, `game-core` and `tools`.

Run: `npm test`

Expected: all contract, FEN, retraction, evaluator and content tests PASS.

- [ ] **Step 7: Commit**

```bash
git add content/samples tools package.json package-lock.json
git commit -m "feat: validate sample retro puzzles"
```

## Milestone exit

Перед планом 2 должны выполняться:

```bash
npm ci
npm run check
npm run typecheck
npm test
npm run content:validate
```

Все команды должны завершиться с exit `0`; sample solution остаётся только в content source и ещё не попадает в публичный API payload.
