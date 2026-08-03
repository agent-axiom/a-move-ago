# A MOVE AGO Gameplay API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать единый Cloudflare Worker API с D1 для гостевых сессий, ежедневных дел, идемпотентных попыток, подсказок, статистики и безопасного импорта контента.

**Architecture:** Hono отвечает только за HTTP boundary; repositories содержат parameterized D1 queries, а services оркестрируют use cases и импортируют чистый `game-core`. Публичные и приватные puzzle projections физически разделены, все персонализированные endpoints используют непрозрачную session token.

**Tech Stack:** Hono 4.12.33, Cloudflare Workers/Wrangler 4.118.0, D1 migrations, Workers Vitest pool 0.20.1, Vitest 4.1.10, Zod 4.4.3, Web Crypto.

---

**Порядок:** план 2 из 5. Требует завершённый план 1; Telegram identity добавляется только в плане 3.

## Карта файлов

- `apps/api/src/index.ts` — Worker `fetch`/`scheduled` export.
- `apps/api/src/app.ts` — композиция Hono routes/middleware без business logic.
- `apps/api/src/env.ts` — типизированные bindings/vars.
- `apps/api/src/http/api-error.ts` — публичные typed exceptions.
- `apps/api/src/http/error-handler.ts` — единый error envelope.
- `apps/api/src/middleware/request-id.ts` — request ID context/header.
- `apps/api/src/middleware/cors.ts` — точный allowlist.
- `apps/api/src/middleware/session.ts` — Bearer → `SessionActor`.
- `apps/api/src/crypto/opaque-token.ts` — генерация и purpose-separated HMAC.
- `apps/api/src/db/*.ts` — небольшие repositories по агрегатам.
- `apps/api/src/services/*.ts` — use cases для session/daily/attempt/hint/stats.
- `apps/api/src/routes/*.ts` — Zod parse и HTTP mapping.
- `apps/api/migrations/0001_initial.sql` — baseline D1 schema.
- `apps/api/test/*` — Worker-runtime tests с изолированной D1.
- `tools/src/import-plan.ts` — parameterized draft-first import plan.
- `tools/src/d1-http.ts` — Cloudflare D1 REST batch client.

### Task 1: Создать Hono Worker shell и актуальный Workers test harness

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/wrangler.jsonc`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/http/api-error.ts`
- Create: `apps/api/src/http/error-handler.ts`
- Create: `apps/api/src/middleware/request-id.ts`
- Create: `apps/api/src/middleware/cors.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/test/app.test.ts`

- [ ] **Step 1: Создать Worker package/config**

`apps/api/package.json`:

```json
{
  "name": "@a-move-ago/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "wrangler deploy --dry-run --outdir dist",
    "cf-typegen": "wrangler types src/worker-configuration.d.ts",
    "db:migrate:local": "wrangler d1 migrations apply a-move-ago --local",
    "dev": "wrangler dev",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@a-move-ago/api-contract": "0.0.0",
    "@a-move-ago/game-core": "0.0.0",
    "hono": "4.12.33",
    "jose": "6.2.3",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.20.1",
    "typescript": "7.0.2",
    "vitest": "4.1.10",
    "wrangler": "4.118.0"
  }
}
```

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["@cloudflare/vitest-pool-workers/types"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/api/wrangler.jsonc`:

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "a-move-ago-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-03",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "a-move-ago",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "ENVIRONMENT": "development",
    "ALLOWED_ORIGINS": "http://localhost:5173,https://agent-axiom.github.io,https://localhost",
    "SESSION_TTL_SECONDS": "7776000"
  },
  "observability": {
    "enabled": true
  }
}
```

`apps/api/vitest.config.ts`:

```ts
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { SESSION_PEPPER: "test-session-pepper-at-least-32-bytes" },
      },
    }),
  ],
});
```

- [ ] **Step 2: Write failing HTTP boundary tests**

`apps/api/test/app.test.ts`:

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Worker shell", () => {
  it("reports health and a request id", async () => {
    const response = await exports.default.fetch("https://api.test/v1/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the same request id in a not-found envelope", async () => {
    const response = await exports.default.fetch("https://api.test/nope");
    const requestId = response.headers.get("x-request-id");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Resource not found.", requestId },
    });
  });

  it("adds CORS only for an exact allowed origin", async () => {
    const allowed = await exports.default.fetch("https://api.test/v1/healthz", {
      headers: { origin: "https://agent-axiom.github.io" },
    });
    const denied = await exports.default.fetch("https://api.test/v1/healthz", {
      headers: { origin: "https://agent-axiom.github.io.evil.test" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://agent-axiom.github.io");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});
```

- [ ] **Step 3: Run RED**

Run: `npm test -w @a-move-ago/api -- test/app.test.ts`

Expected: FAIL because Worker entry/config does not exist.

- [ ] **Step 4: Implement request/error/CORS boundary**

`apps/api/src/env.ts`:

```ts
export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SECONDS: string;
  SESSION_PEPPER: string;
}

export type Variables = {
  requestId: string;
  session: SessionActor;
};

export type SessionActor = {
  sessionId: string;
  playerId: string | null;
  kind: "guest" | "telegram";
  channel: "web" | "telegram" | "android";
};
```

`apps/api/src/http/api-error.ts`:

```ts
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
```

`apps/api/src/middleware/request-id.ts`:

```ts
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../env";

export const requestId = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("x-request-id", id);
});
```

`apps/api/src/middleware/cors.ts`:

```ts
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../env";

export const exactCors = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = new Set(c.env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()));
  if (origin && allowed.has(origin)) {
    c.header("access-control-allow-origin", origin);
    c.header("vary", "Origin");
    c.header("access-control-allow-headers", "authorization,content-type");
    c.header("access-control-allow-methods", "GET,POST,OPTIONS");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});
```

`apps/api/src/http/error-handler.ts`:

```ts
import type { Context } from "hono";
import { ZodError } from "zod";
import type { Env, Variables } from "../env";
import { ApiError } from "./api-error";

export function errorResponse(error: Error, c: Context<{ Bindings: Env; Variables: Variables }>) {
  const publicError = error instanceof ApiError
    ? error
    : error instanceof ZodError || error instanceof SyntaxError
      ? new ApiError(400, "INVALID_REQUEST", "The request is malformed.")
      : new ApiError(500, "INTERNAL_ERROR", "Unexpected server error.");
  return c.json(
    {
      error: {
        code: publicError.code,
        message: publicError.message,
        requestId: c.get("requestId"),
      },
    },
    publicError.status,
  );
}
```

`apps/api/src/app.ts`:

```ts
import { Hono } from "hono";
import type { Env, Variables } from "./env";
import { ApiError } from "./http/api-error";
import { errorResponse } from "./http/error-handler";
import { exactCors } from "./middleware/cors";
import { requestId } from "./middleware/request-id";

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requestId);
app.use("*", exactCors);
app.get("/v1/healthz", (c) => c.json({ ok: true }));
app.notFound(() => {
  throw new ApiError(404, "NOT_FOUND", "Resource not found.");
});
app.onError(errorResponse);
```

`apps/api/src/index.ts`:

```ts
import { app } from "./app";

export default app;
```

- [ ] **Step 5: Generate types and run GREEN**

Run: `npm install`

Expected: workspace dependencies linked without `missing`.

Run: `npm run cf-typegen -w @a-move-ago/api`

Expected: created `apps/api/src/worker-configuration.d.ts`.

Run: `npm test -w @a-move-ago/api -- test/app.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api package.json package-lock.json
git commit -m "feat: add Hono Worker shell"
```

### Task 2: Создать D1 schema и migration harness

**Files:**
- Create: `apps/api/migrations/0001_initial.sql`
- Modify: `apps/api/vitest.config.ts`
- Create: `apps/api/test/apply-migrations.ts`
- Test: `apps/api/test/migrations.test.ts`

- [ ] **Step 1: Write failing migration test**

`apps/api/test/migrations.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 schema", () => {
  it("contains all gameplay tables", async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = rows.results.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      "players",
      "sessions",
      "puzzles",
      "puzzle_solutions",
      "puzzle_hints",
      "daily_cases",
      "daily_case_puzzles",
      "attempts",
      "hint_events",
      "content_imports",
    ]));
    const puzzleColumns = await env.DB.prepare("PRAGMA table_info(puzzles)")
      .all<{ name: string }>();
    expect(puzzleColumns.results.map((column) => column.name)).toContain("content_digest");
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/migrations.test.ts`

Expected: FAIL because gameplay tables do not exist.

- [ ] **Step 3: Add the complete baseline migration**

`apps/api/migrations/0001_initial.sql`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  oidc_issuer TEXT,
  oidc_subject TEXT,
  oidc_audience TEXT,
  display_name TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'telegram')),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'android')),
  rotated_from_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  CHECK ((kind = 'guest' AND player_id IS NULL) OR (kind = 'telegram' AND player_id IS NOT NULL))
);

CREATE TABLE puzzles (
  id TEXT PRIMARY KEY,
  content_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  provenance TEXT NOT NULL,
  license TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (content_key, version)
);

CREATE TABLE puzzle_solutions (
  id TEXT PRIMARY KEY,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  solution_key TEXT NOT NULL,
  solution_json TEXT NOT NULL CHECK (json_valid(solution_json)),
  contradiction_json TEXT NOT NULL CHECK (json_valid(contradiction_json)),
  sort_order INTEGER NOT NULL,
  UNIQUE (puzzle_id, solution_key)
);

CREATE TABLE puzzle_hints (
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  level INTEGER NOT NULL CHECK (level > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (puzzle_id, level)
);

CREATE TABLE daily_cases (
  id TEXT PRIMARY KEY,
  case_date TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE daily_case_puzzles (
  case_id TEXT NOT NULL REFERENCES daily_cases(id) ON DELETE RESTRICT,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  act_json TEXT NOT NULL CHECK (json_valid(act_json)),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, puzzle_id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  attempt_uuid TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES daily_cases(id) ON DELETE RESTRICT,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  normalized_answer_json TEXT NOT NULL CHECK (json_valid(normalized_answer_json)),
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  hints_used INTEGER NOT NULL DEFAULT 0 CHECK (hints_used >= 0),
  submitted_at INTEGER NOT NULL,
  UNIQUE (session_id, attempt_uuid)
);

CREATE TABLE hint_events (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  hint_level INTEGER NOT NULL CHECK (hint_level > 0),
  hint_json TEXT NOT NULL CHECK (json_valid(hint_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, hint_level)
);

CREATE TABLE content_imports (
  digest TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES daily_cases(id) ON DELETE RESTRICT,
  source_name TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX attempts_session_idx ON attempts(session_id, submitted_at);
CREATE INDEX attempts_player_idx ON attempts(player_id, submitted_at);
CREATE INDEX attempts_case_correct_idx ON attempts(case_id, puzzle_id, correct);
```

- [ ] **Step 4: Configure migrations in the Workers pool**

Replace `apps/api/vitest.config.ts` with:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SESSION_PEPPER: "test-session-pepper-at-least-32-bytes",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
```

`apps/api/test/apply-migrations.ts`:

```ts
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { Env } from "../src/env";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
```

- [ ] **Step 5: Run migration tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/migrations.test.ts`

Expected: PASS.

Run: `npm run db:migrate:local -w @a-move-ago/api`

Expected: Wrangler applies `0001_initial.sql` to local D1.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations apps/api/vitest.config.ts apps/api/test/apply-migrations.ts apps/api/test/migrations.test.ts
git commit -m "feat: add initial D1 schema"
```

### Task 3: Реализовать гостевые sessions, Bearer middleware, `/me` и logout

**Files:**
- Modify: `packages/api-contract/src/api.ts`
- Create: `apps/api/src/crypto/opaque-token.ts`
- Create: `apps/api/src/db/sessions.ts`
- Create: `apps/api/src/services/session-service.ts`
- Create: `apps/api/src/middleware/session.ts`
- Create: `apps/api/src/routes/sessions.ts`
- Create: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/sessions.test.ts`

- [ ] **Step 1: Extend the strict session contract**

Add to `packages/api-contract/src/api.ts`:

```ts
export const ClientChannelSchema = z.enum(["web", "telegram", "android"]);
export const GuestSessionRequestSchema = z.object({ channel: ClientChannelSchema }).strict();
```

- [ ] **Step 2: Write failing session lifecycle tests**

`apps/api/test/sessions.test.ts` must assert:

```ts
const issued = await requestJson("/v1/sessions/guest", {
  method: "POST",
  body: { channel: "web" },
});
expect(issued.response.status).toBe(201);
expect(issued.body).toMatchObject({ kind: "guest" });

const row = await env.DB.prepare("SELECT token_hash FROM sessions").first<{ token_hash: string }>();
expect(row?.token_hash).not.toBe(issued.body.token);

const me = await authenticatedJson("/v1/me", issued.body.token);
expect(me.body).toEqual({ kind: "guest", profile: null });

const logout = await authenticatedJson("/v1/auth/logout", issued.body.token, { method: "POST" });
expect(logout.body.kind).toBe("guest");
expect(logout.body.token).not.toBe(issued.body.token);
expect((await authenticatedJson("/v1/me", issued.body.token)).response.status).toBe(401);
```

- [ ] **Step 3: Run RED**

Run: `npm test -w @a-move-ago/api -- test/sessions.test.ts`

Expected: FAIL with 404 session routes.

- [ ] **Step 4: Implement opaque tokens and repository**

`apps/api/src/crypto/opaque-token.ts`:

```ts
const encoder = new TextEncoder();

export function newOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashSessionToken(token: string, pepper: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`session\0${token}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

`apps/api/src/db/sessions.ts` exposes exact functions:

```ts
export type SessionRow = {
  id: string;
  player_id: string | null;
  kind: "guest" | "telegram";
  channel: "web" | "telegram" | "android";
  expires_at: number;
  revoked_at: number | null;
};

export async function insertGuestSession(
  db: D1Database,
  input: { id: string; tokenHash: string; channel: SessionRow["channel"]; now: number; expiresAt: number },
): Promise<void> {
  await db.prepare(
    `INSERT INTO sessions
      (id, player_id, token_hash, kind, channel, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, NULL, ?, 'guest', ?, ?, ?, NULL, ?)`,
  ).bind(input.id, input.tokenHash, input.channel, input.now, input.expiresAt, input.now).run();
}

export async function findActiveSession(db: D1Database, tokenHash: string, now: number) {
  return db.prepare(
    `SELECT id, player_id, kind, channel, expires_at, revoked_at
       FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(tokenHash, now).first<SessionRow>();
}
```

- [ ] **Step 5: Implement service, middleware and routes**

`session-service.ts` creates a 90-day token, returns ISO expiry, and logout performs one D1 `batch()` containing old-session revoke plus new-session insert. `middleware/session.ts` parses only `Authorization: Bearer <token>`, hashes it, rejects expired/revoked rows with `401 INVALID_SESSION`, and sets `SessionActor`.

Routes must use these exact shapes:

```ts
sessions.post("/guest", async (c) => {
  const input = GuestSessionRequestSchema.parse(await c.req.json());
  const result = await issueGuest(c.env, input.channel, Math.floor(Date.now() / 1000));
  c.header("cache-control", "no-store");
  return c.json(result, 201);
});

export const logoutHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const result = await logoutToGuest(c.env, c.get("session"), Math.floor(Date.now() / 1000));
  c.header("cache-control", "no-store");
  return c.json(result);
};
```

Import `Context` from Hono and `Env`/`Variables` from `env.ts` in the route module.
The `sessions` router owns only `/guest`. Mount it once at `/v1/sessions`; in `app.ts`, register
`app.post("/v1/auth/logout", requireSession, logoutHandler)` and mount `/v1/me` separately. Plan 3
extracts that direct logout registration into the dedicated `session-auth` router when handoff exchange
is added. No temporary `/v1/sessions/logout` or `/v1/auth/guest` alias is allowed.

- [ ] **Step 6: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/sessions.test.ts`

Expected: guest issue, token hashing, `/me`, expiration/revocation and logout tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/api-contract/src/api.ts apps/api/src apps/api/test/sessions.test.ts
git commit -m "feat: add guest session lifecycle"
```

### Task 4: Отдать только публичную daily projection

**Files:**
- Create: `apps/api/src/db/content.ts`
- Create: `apps/api/src/services/daily-service.ts`
- Create: `apps/api/src/routes/daily.ts`
- Create: `apps/api/test/fixtures/content.ts`
- Test: `apps/api/test/daily.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Seed unmistakable private markers in a failing test**

`apps/api/test/daily.test.ts` inserts a published case for `2026-08-03`, `public_json` that parses `PuzzlePublicSchema`, and `solution_json` containing `previousFen: "reveal-secret"`.
The shared content fixture also supplies a deterministic 64-character lowercase hexadecimal
`puzzles.content_digest`; all later gameplay tests reuse that fixture instead of bypassing the new
immutable-version column.

Core assertion:

```ts
const response = await authenticatedJson("/v1/daily?date=2026-08-03", guestToken);
const serialized = JSON.stringify(response.body);
expect(response.response.status).toBe(200);
expect(DailyCaseResponseSchema.parse(response.body).date).toBe("2026-08-03");
expect(serialized).not.toContain("acceptedSolutions");
expect(serialized).not.toContain("previousFen");
expect(serialized).not.toContain("reveal-secret");
```

Also test default injected UTC date, ordered `position`, hidden draft case, past published archive
access, and `404 DAILY_NOT_FOUND` for any requested future date even if that case is already marked
published.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/daily.test.ts`

Expected: FAIL with 404 route.

- [ ] **Step 3: Implement the public-only query**

`apps/api/src/db/content.ts`:

```ts
export async function findPublishedDaily(db: D1Database, date: string, today: string) {
  return db.prepare(
    `SELECT dc.id AS case_id, dc.case_date, dc.title,
            dcp.position, p.id AS puzzle_row_id, p.content_key, p.public_json
       FROM daily_cases dc
       JOIN daily_case_puzzles dcp ON dcp.case_id = dc.id
       JOIN puzzles p ON p.id = dcp.puzzle_id
      WHERE dc.case_date = ?
        AND dc.case_date <= ?
        AND dc.status = 'published'
        AND p.status = 'published'
      ORDER BY dcp.position`,
  ).bind(date, today).all<{
    case_id: string;
    case_date: string;
    title: string;
    position: number;
    puzzle_row_id: string;
    content_key: string;
    public_json: string;
  }>();
}
```

`daily-service.ts` parses each `public_json` with `PuzzlePublicSchema`, requires its logical `id` to
equal `content_key`, loads solved physical row IDs scoped to `sessionId` or `playerId`, maps them back
to stable logical IDs through `puzzles.content_key`, and returns `DailyCaseResponseSchema.parse(...)`.
The route accepts only `z.iso.date()` query values and uses an injected UTC today (production:
`new Date().toISOString().slice(0, 10)`) when omitted. It rejects `requestedDate > today` before the
repository call; the SQL condition is defense in depth against prepublished future-content leakage.

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/daily.test.ts`

Expected: all projection/leakage/publication tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/content.ts apps/api/src/services/daily-service.ts apps/api/src/routes/daily.ts apps/api/src/app.ts apps/api/test
git commit -m "feat: serve published daily cases"
```

### Task 5: Сохранить и повторить attempt идемпотентно

**Files:**
- Create: `apps/api/src/db/attempts.ts`
- Create: `apps/api/src/services/attempt-service.ts`
- Create: `apps/api/src/routes/attempts.ts`
- Test: `apps/api/test/attempts.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write failing attempt tests**

Tests cover correct, incorrect, case/puzzle membership, malformed body, cross-session UUID reuse and concurrent replay. They also submit the same `(session, attemptUuid)` with a different case, puzzle, or retraction—both after a stored response and as two concurrent requests—and require one canonical result plus `409 IDEMPOTENCY_CONFLICT`; an idempotency key never aliases a different payload. The replay assertion is exact:

The fixture stores the public logical ID `opening-exd5` under physical row
`opening-exd5:v1`; a same-payload replay must succeed through the `content_key` join rather than
comparing the logical request ID directly with the physical foreign key.
Seed a published case dated one day after injected UTC today and require attempt submission to return
`404 PUZZLE_NOT_FOUND`; knowing future case/puzzle IDs must not reveal evaluation results.

```ts
const first = await authenticatedJson("/v1/attempts", token, {
  method: "POST",
  body: correctRequest,
});
const replay = await authenticatedJson("/v1/attempts", token, {
  method: "POST",
  body: correctRequest,
});

expect(first.response.status).toBe(201);
expect(replay.response.status).toBe(200);
expect(replay.response.headers.get("idempotency-replayed")).toBe("true");
expect(replay.body).toEqual(first.body);
expect(await countRows("attempts")).toBe(1);
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/attempts.test.ts`

Expected: FAIL with 404.

- [ ] **Step 3: Implement repository concurrency guard**

`apps/api/src/db/attempts.ts` must expose:

```ts
export async function findAttemptReplay(db: D1Database, sessionId: string, attemptUuid: string) {
  return db.prepare(
    `SELECT a.id, a.case_id, p.content_key AS puzzle_content_key,
            a.normalized_answer_json, a.response_json
       FROM attempts a
       JOIN puzzles p ON p.id = a.puzzle_id
      WHERE a.session_id = ? AND a.attempt_uuid = ?`,
  ).bind(sessionId, attemptUuid).first<{
    id: string;
    case_id: string;
    puzzle_content_key: string;
    normalized_answer_json: string;
    response_json: string;
  }>();
}

export async function insertAttempt(db: D1Database, row: AttemptInsert): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.attemptUuid,
    row.sessionId,
    row.playerId,
    row.caseId,
    row.puzzleId,
    row.answerJson,
    row.correct ? 1 : 0,
    row.responseJson,
    row.submittedAt,
  ).run();
  return result.meta.changes === 1;
}
```

- [ ] **Step 4: Implement service and HTTP mapping**

`attempt-service.ts` sequence:

1. when `(session_id, attempt_uuid)` exists, compare its case, joined logical
   `puzzles.content_key` and canonical
   `normalized_answer_json`; return the stored response only for an exact match, otherwise throw
   `409 IDEMPOTENCY_CONFLICT`;
2. query the published case membership by supplied logical `puzzles.content_key`, requiring
   `daily_cases.case_date <= injectedToday`, and returning the
   physical `puzzles.id`, `public_json`, and every ordered `solution_json` plus
   `contradiction_json`;
3. parse `public_json` with `PuzzlePublicSchema` and require its `id` to equal the requested
   `content_key`; parse each solution with `AcceptedSolutionSchema`, parse every contradiction map
   with `PuzzlePrivateSchema.shape.contradictionExplanations`, require the repeated maps to be
   identical, then validate `PuzzlePrivateSchema.parse({ public: parsedPublic, acceptedSolutions,
   hints: [], contradictionExplanations })`;
4. call `evaluateRetraction`;
5. build response with server `id` and client `attemptUuid`;
6. `INSERT OR IGNORE` using the returned physical `puzzles.id` as the attempt foreign key;
   replays recover the request-facing logical ID through the repository join shown above, while
   `normalized_answer_json` contains only the canonical retraction;
7. if another request won, re-read it and repeat the same case/puzzle/canonical-answer comparison;
   return its snapshot only for an exact match, otherwise throw `409 IDEMPOTENCY_CONFLICT`.

Derive `injectedToday` from the same injected `now` used for persistence (`new Date(now *
1_000).toISOString().slice(0, 10)`), so UTC access control and submitted timestamps cannot disagree
at midnight.

Route behavior:

```ts
const input = AttemptRequestSchema.parse(await c.req.json());
const result = await submitAttempt(
  c.env,
  c.get("session"),
  input,
  Math.floor(Date.now() / 1000),
);
if (result.replayed) c.header("idempotency-replayed", "true");
return c.json(result.body, result.replayed ? 200 : 201);
```

Incorrect is a successful business response with `correct: false`, not an error envelope.

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/attempts.test.ts`

Expected: all evaluation and concurrency/idempotency tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/attempts.ts apps/api/src/services/attempt-service.ts apps/api/src/routes/attempts.ts apps/api/src/app.ts apps/api/test/attempts.test.ts
git commit -m "feat: evaluate idempotent attempts"
```

### Task 6: Сделать hints ordered и retry-safe

**Files:**
- Modify: `apps/api/src/db/attempts.ts`
- Create: `apps/api/src/services/hint-service.ts`
- Modify: `apps/api/src/routes/attempts.ts`
- Test: `apps/api/test/hints.test.ts`

- [ ] **Step 1: Write failing hint tests**

Cover level 1, replay level 1, skip to level 3, exhaustion, correct-attempt rejection, other actor and concurrent same-level calls.

```ts
const first = await authenticatedJson(`/v1/attempts/${attemptId}/hints`, token, {
  method: "POST",
  body: { level: 1 },
});
const replay = await authenticatedJson(`/v1/attempts/${attemptId}/hints`, token, {
  method: "POST",
  body: { level: 1 },
});
expect(replay.body).toEqual(first.body);
expect(HintResponseSchema.parse(first.body)).toEqual({
  level: 1,
  text: "A pawn changed files.",
  exhausted: false,
});
expect(await countRows("hint_events")).toBe(1);
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/hints.test.ts`

Expected: FAIL with 404.

- [ ] **Step 3: Implement ordered persistence**

`requestHint` must:

```ts
const stored = await findHint(db, attemptId, requestedLevel);
if (stored) return JSON.parse(stored.hint_json);

const current = await maxHintLevel(db, attemptId);
if (requestedLevel !== current + 1) {
  throw new ApiError(409, "HINT_OUT_OF_ORDER", "Request the next hint level.");
}

const hintRow = await findPuzzleHint(db, puzzleId, requestedLevel);
if (!hintRow) throw new ApiError(409, "HINTS_EXHAUSTED", "No more hints are available.");
const hint = HintResponseSchema.parse(JSON.parse(hintRow.payload_json));
if (hint.level !== requestedLevel) throw new Error("Stored hint level does not match its key");

await db.batch([
  db.prepare(
    "INSERT OR IGNORE INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES (?, ?, ?, ?)",
  ).bind(attemptId, requestedLevel, JSON.stringify(hint), now),
  db.prepare("UPDATE attempts SET hints_used = MAX(hints_used, ?) WHERE id = ?")
    .bind(requestedLevel, attemptId),
]);
return HintResponseSchema.parse(
  JSON.parse((await findHint(db, attemptId, requestedLevel))!.hint_json),
);
```

Ownership query returns `404 ATTEMPT_NOT_FOUND` for another actor.
Import and apply `HintResponseSchema` at both the stored puzzle payload and replayed event boundaries;
no raw `{ text }` object may leave the service.

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/hints.test.ts`

Expected: all ordering, replay and ownership tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/attempts.ts apps/api/src/services/hint-service.ts apps/api/src/routes/attempts.ts apps/api/test/hints.test.ts
git commit -m "feat: add ordered attempt hints"
```

### Task 7: Вычислить guest/player stats и streak

**Files:**
- Create: `apps/api/src/db/stats.ts`
- Create: `apps/api/src/services/stats-service.ts`
- Modify: `apps/api/src/routes/me.ts`
- Test: `apps/api/test/stats.test.ts`

- [ ] **Step 1: Write failing aggregate tests**

Seed incomplete and complete multi-puzzle cases across consecutive dates. Assert:

```ts
expect(await getStats(token)).toEqual({
  attempts: 5,
  hintsUsed: 2,
  solvedPuzzles: 3,
  completedCases: 2,
  currentStreak: 2,
  bestStreak: 2,
  lastCompletedDate: "2026-08-03",
});
```

Also prove idempotent replay does not increase attempts, another session is isolated, and an
accidentally seeded future completion yields `currentStreak: 0` rather than a negative-delta streak.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/stats.test.ts`

Expected: FAIL with 404 `/v1/me/stats`.

- [ ] **Step 3: Implement actor-scoped aggregates**

Repository uses `player_id = ?` for an authenticated actor and `session_id = ?` for a guest. A case is completed only when the actor has a correct attempt for every row in `daily_case_puzzles`. `stats-service.ts` receives sorted completed dates and calculates current/best consecutive UTC-day runs in pure TypeScript.

Core streak function; `current` remains active only when the last completion is today or yesterday
in UTC:

```ts
export function streaks(dates: string[], today: string): { current: number; best: number } {
  const days = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    const value = Date.parse(`${day}T00:00:00Z`) / 86_400_000;
    run = previous !== null && value === previous + 1 ? run + 1 : 1;
    previous = value;
    best = Math.max(best, run);
  }
  const todayValue = Date.parse(`${today}T00:00:00Z`) / 86_400_000;
  const delta = previous === null ? null : todayValue - previous;
  const current = delta !== null && delta >= 0 && delta <= 1 ? run : 0;
  return { current, best };
}
```

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/api -- test/stats.test.ts`

Expected: all guest isolation, completion and streak tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/stats.ts apps/api/src/services/stats-service.ts apps/api/src/routes/me.ts apps/api/test/stats.test.ts
git commit -m "feat: derive guest and player stats"
```

### Task 8: Добавить parameterized draft-first content import

**Files:**
- Create: `tools/src/canonical-json.ts`
- Create: `tools/src/import-plan.ts`
- Create: `tools/src/d1-http.ts`
- Create: `tools/src/content-import.ts`
- Test: `tools/src/import-plan.test.ts`
- Test: `tools/src/d1-http.test.ts`
- Test: `tools/src/content-import.test.ts`
- Test: `apps/api/test/content-import.integration.test.ts`
- Modify: `tools/package.json`

- [ ] **Step 1: Write failing deterministic-plan tests**

```ts
const plan = await buildImportPlan(sampleCase, "sha256-digest");
expect(plan.draftStatements.every((statement) => !statement.sql.includes("The missing pawn"))).toBe(true);
expect(plan.draftStatements.flatMap((statement) => statement.params)).toContain("The missing pawn");
expect(plan.publishStatements.map((statement) => statement.sql).join("\n"))
  .toMatch(/UPDATE daily_cases SET status = 'published'/);
expect(JSON.stringify(plan)).not.toContain("DELETE FROM");
expect(plan.draftStatements.concat(plan.publishStatements)
  .flatMap((statement) => statement.params)
  .every((parameter) => typeof parameter === "string")).toBe(true);
```

`tools/src/content-import.test.ts` constructs two schema-valid documents that differ only in the
insertion order of two `contradictionExplanations` keys. It requires the canonical strings and
SHA-256 digests to be identical, while preserving array order. A genuinely changed explanation
must produce a different digest. This prevents a semantically identical reordered source from
colliding with `content_imports.case_id UNIQUE` as a false new import.

Mock fetch verifies the D1 REST URL, Bearer header and exact JSON `batch` body with only string
parameters, matching Cloudflare's current D1 REST contract; missing credentials must fail before
fetch.

The D1 integration test imports one digest twice and expects an idempotent no-op, then imports the
same `case.id` with a different digest and expects the draft batch to fail on
`content_imports.case_id UNIQUE` without partially changing the case.
It also imports version 1 and version 2 of one logical `PuzzlePublic.id` in two different cases and
expects two physical `puzzles` rows (`<logical-id>:v1`, `<logical-id>:v2`) while both public payloads
retain the stable logical ID.

It then parameterizes changes to public data, an accepted solution, a contradiction explanation and
a hint while deliberately reusing the same logical puzzle ID and version in a new case. Every
variant must make the draft D1 batch fail and roll back the new case and child rows; the originally
published puzzle remains byte-for-byte unchanged. Reordering object keys alone uses the same
per-puzzle digest and remains an idempotent no-op.

Implement that as `apps/api/test/content-import.integration.test.ts` under the existing Workers
Vitest pool and migrated `env.DB`: import `buildImportPlan` from `tools/src/import-plan.ts`, bind every
statement into `env.DB.batch()`, and assert real D1 rows/foreign keys/transaction rollback. The mock
HTTP test alone is not accepted as evidence of D1 transactional behavior.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/tools -- src/import-plan.test.ts src/d1-http.test.ts src/content-import.test.ts`

Expected: FAIL because import modules are absent.

Run: `npm test -w @a-move-ago/api -- test/content-import.integration.test.ts`

Expected: FAIL because the deterministic import planner is absent.

- [ ] **Step 3: Implement exact plan and client interfaces**

`tools/src/canonical-json.ts` owns both whole-document and per-puzzle canonicalization:

```ts
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(canonicalValue(value));
  if (result === undefined) throw new Error("Content is not JSON serializable.");
  return result;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}
```

`tools/src/import-plan.ts`:

```ts
import type { PuzzlePrivate } from "@a-move-ago/api-contract";
import { canonicalJson, sha256Hex } from "./canonical-json";

export type D1Statement = {
  sql: string;
  params: string[];
};

export type ContentCaseSource = {
  case: {
    id: string;
    date: string;
    slug: string;
    title: string;
    generatedAt: number;
  };
  puzzles: PuzzlePrivate[];
};

export type ImportPlan = {
  digest: string;
  draftStatements: D1Statement[];
  publishStatements: D1Statement[];
};

export async function buildImportPlan(
  source: ContentCaseSource,
  digest: string,
): Promise<ImportPlan> {
  const metadata = source.case;
  const draftStatements: D1Statement[] = [
    {
      sql: `INSERT INTO daily_cases
        (id, case_date, slug, title, status, published_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = CASE
            WHEN daily_cases.case_date = excluded.case_date
             AND daily_cases.slug = excluded.slug
             AND daily_cases.title = excluded.title
             AND daily_cases.created_at = excluded.created_at
            THEN daily_cases.title ELSE NULL END`,
      params: [
        metadata.id,
        metadata.date,
        metadata.slug,
        metadata.title,
        String(metadata.generatedAt),
        String(metadata.generatedAt),
      ],
    },
  ];

  for (const [puzzleIndex, puzzle] of source.puzzles.entries()) {
    const puzzleRowId = `${puzzle.public.id}:v${puzzle.public.version}`;
    const puzzleDigest = await sha256Hex(canonicalJson(puzzle));
    draftStatements.push({
      sql: `INSERT INTO puzzles
        (id, content_key, version, content_digest, status, public_json,
         provenance, license, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
        ON CONFLICT(content_key, version) DO UPDATE SET
          content_digest = CASE
            WHEN puzzles.id = excluded.id
             AND puzzles.content_digest = excluded.content_digest
            THEN puzzles.content_digest ELSE NULL END`,
      params: [
        puzzleRowId,
        puzzle.public.id,
        String(puzzle.public.version),
        puzzleDigest,
        canonicalJson(puzzle.public),
        puzzle.public.provenance,
        puzzle.public.license,
        String(metadata.generatedAt),
        String(metadata.generatedAt),
      ],
    });

    puzzle.acceptedSolutions.forEach((solution, solutionIndex) => {
      draftStatements.push({
        sql: `INSERT INTO puzzle_solutions
          (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(puzzle_id, solution_key) DO UPDATE SET
            solution_json = CASE
              WHEN puzzle_solutions.id = excluded.id
               AND puzzle_solutions.solution_json = excluded.solution_json
               AND puzzle_solutions.contradiction_json = excluded.contradiction_json
               AND puzzle_solutions.sort_order = excluded.sort_order
              THEN puzzle_solutions.solution_json ELSE NULL END`,
        params: [
          `${puzzleRowId}:solution:${solutionIndex + 1}`,
          puzzleRowId,
          `solution-${solutionIndex + 1}`,
          canonicalJson(solution),
          canonicalJson(puzzle.contradictionExplanations),
          String(solutionIndex + 1),
        ],
      });
    });

    puzzle.hints.forEach((hint, hintIndex) => {
      draftStatements.push({
        sql: `INSERT INTO puzzle_hints (puzzle_id, level, payload_json)
          VALUES (?, ?, ?)
          ON CONFLICT(puzzle_id, level) DO UPDATE SET
            payload_json = CASE
              WHEN puzzle_hints.payload_json = excluded.payload_json
              THEN puzzle_hints.payload_json ELSE NULL END`,
        params: [
          puzzleRowId,
          String(hintIndex + 1),
          canonicalJson({
            level: hintIndex + 1,
            text: hint,
            exhausted: hintIndex + 1 === puzzle.hints.length,
          }),
        ],
      });
    });

    draftStatements.push({
      sql: `INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(case_id, position) DO UPDATE SET
          act_json = CASE
            WHEN daily_case_puzzles.puzzle_id = excluded.puzzle_id
             AND daily_case_puzzles.act_json = excluded.act_json
            THEN daily_case_puzzles.act_json ELSE NULL END`,
      params: [
        metadata.id,
        puzzleRowId,
        String(puzzleIndex + 1),
        canonicalJson({ index: puzzleIndex + 1, total: source.puzzles.length }),
      ],
    });
  }

  draftStatements.push({
    sql: `INSERT INTO content_imports (digest, case_id, source_name, imported_at, published_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(digest) DO UPDATE SET
        case_id = CASE
          WHEN content_imports.case_id = excluded.case_id
           AND content_imports.source_name = excluded.source_name
           AND content_imports.imported_at = excluded.imported_at
          THEN content_imports.case_id ELSE NULL END`,
    params: [digest, metadata.id, metadata.slug, String(metadata.generatedAt)],
  });

  return {
    digest,
    draftStatements,
    publishStatements: [
      {
        sql: `UPDATE puzzles SET status = 'published', updated_at = ?
          WHERE id IN (SELECT puzzle_id FROM daily_case_puzzles WHERE case_id = ?)
            AND status = 'draft'`,
        params: [String(metadata.generatedAt), metadata.id],
      },
      {
        sql: `UPDATE daily_cases SET status = 'published', published_at = ?, updated_at = ?
          WHERE id = ? AND status = 'draft'`,
        params: [String(metadata.generatedAt), String(metadata.generatedAt), metadata.id],
      },
      {
        sql: "UPDATE content_imports SET published_at = ? WHERE digest = ? AND published_at IS NULL",
        params: [String(metadata.generatedAt), digest],
      },
    ],
  };
}
```

`tools/src/d1-http.ts`:

```ts
import type { D1Statement } from "./import-plan";

export async function executeD1Batch(input: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  statements: D1Statement[];
  fetch: typeof fetch;
}) {
  const response = await input.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ batch: input.statements }),
    },
  );
  if (!response.ok) throw new Error(`D1 query failed with HTTP ${response.status}`);
  return response.json();
}
```

- [ ] **Step 4: Implement explicit dry-run/publish command**

`content-import.ts` accepts only `--file <path>` plus exactly one of `--dry-run` or `--publish`.
It calls `validateContentDocument(sourceText)`, canonicalizes the parsed result with a recursive
stable-key serializer, and calculates SHA-256 over the UTF-8 canonical string. Object keys are sorted
at every depth, undefined object members are omitted like JSON, array order is preserved, and
non-JSON top-level values are rejected. Import and use `canonicalJson` and `sha256Hex` from
`./canonical-json`; plain `JSON.stringify(validated)` is forbidden. The same helper already gives
`buildImportPlan` an immutable digest of every complete `PuzzlePrivate`.

```ts
const validated = validateContentDocument(sourceText);
const canonical = canonicalJson(validated);
const digest = await sha256Hex(canonical);
const plan = await buildImportPlan(validated, digest);
```

It prints only digest/IDs/counts. `--dry-run` returns at that point without reading credentials and
with zero `fetch` calls. Only `--publish` requires `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `D1_DATABASE_ID`; it executes all draft statements, checks the
top-level Cloudflare `success` and every `result[].success`, and only then executes the fixed publish
batch. Tests assert stable reordered-input digest, zero-network dry-run and exactly two ordered
transactional REST batches for publish.

Add script:

```json
"content:import": "tsx src/content-import.ts"
```

- [ ] **Step 5: Run GREEN and dry-run**

Run: `npm test -w @a-move-ago/tools -- src/import-plan.test.ts src/d1-http.test.ts src/content-import.test.ts`

Expected: PASS; no dynamic source value appears in SQL text.

Run: `npm test -w @a-move-ago/api -- test/content-import.integration.test.ts`

Expected: PASS for idempotency, different-digest rollback and two physical puzzle versions.

Run: `npm run content:import -w @a-move-ago/tools -- --file ../content/samples/2026-08-03.json --dry-run`

Expected: digest and row counts only; no solution JSON printed.

- [ ] **Step 6: Commit**

```bash
git add tools/src tools/package.json apps/api/test/content-import.integration.test.ts package-lock.json
git commit -m "feat: import validated content into D1"
```

### Task 9: Закрыть gameplay security, cleanup и full-flow gate

**Files:**
- Create: `apps/api/src/middleware/rate-limit.ts`
- Create: `apps/api/src/middleware/structured-log.ts`
- Create: `apps/api/src/scheduled.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/*.ts`
- Modify: `apps/api/wrangler.jsonc`
- Test: `apps/api/test/security.test.ts`
- Test: `apps/api/test/flow.integration.test.ts`

- [ ] **Step 1: Write failing security tests**

Assert exact origin matching, unauthenticated OPTIONS, `429 RATE_LIMITED`, safe log fields, no Authorization/body/query values, and no-store session responses. Cleanup tests prove that expired unlinked guest attempts are removed while an attempt with `player_id` survives deletion of its originating session and remains visible in player stats. Full flow:

```text
guest → daily → incorrect → hint level 1 → correct → stats
```

The full-flow test also asserts that initial daily JSON never contains the sample `previousFen`.

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api -- test/security.test.ts test/flow.integration.test.ts`

Expected: rate-limit/log/cleanup assertions FAIL.

- [ ] **Step 3: Implement limiter port and safe logging**

```ts
export interface Limiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export async function enforceLimit(limiter: Limiter, key: string): Promise<void> {
  if (!(await limiter.limit({ key })).success) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
  }
}
```

Use coarse HMACed IP only for guest issue; all other keys use internal `sessionId`, never raw Bearer. Logs contain only method, matched route, status, duration, request ID and session kind.

Starting limits: guest `10/min`, attempts `60/min`, hints `30/min`. Add corresponding Rate Limiting
bindings with development-only namespace sentinels and inject fake bindings in tests. Namespace IDs
must be unique across the owner's entire Cloudflare account; plan 5 replaces all four gameplay/auth
sentinels from reviewed deployment configuration before any production dry-run or deploy.

Add the binding shape before `Env`, then add the three fields after `SESSION_PEPPER`:

```ts
export type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS: string;
  SESSION_TTL_SECONDS: string;
  SESSION_PEPPER: string;
  GUEST_RATE_LIMITER: RateLimitBinding;
  ATTEMPT_RATE_LIMITER: RateLimitBinding;
  HINT_RATE_LIMITER: RateLimitBinding;
}
```

Add the exact production bindings and cleanup trigger to `apps/api/wrangler.jsonc`:

```jsonc
"ratelimits": [
  {
    "name": "GUEST_RATE_LIMITER",
    "namespace_id": "900000001",
    "simple": { "limit": 10, "period": 60 }
  },
  {
    "name": "ATTEMPT_RATE_LIMITER",
    "namespace_id": "900000002",
    "simple": { "limit": 60, "period": 60 }
  },
  {
    "name": "HINT_RATE_LIMITER",
    "namespace_id": "900000003",
    "simple": { "limit": 30, "period": 60 }
  }
],
"triggers": { "crons": ["17 0 * * *"] }
```

- [ ] **Step 4: Implement scheduled cleanup**

`apps/api/src/scheduled.ts`:

```ts
import type { Env } from "./env";

export async function cleanupExpired(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM attempts
        WHERE player_id IS NULL
          AND session_id IN (
            SELECT id FROM sessions WHERE expires_at < ? OR revoked_at < ?
          )`,
    ).bind(now, now - 2_592_000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?")
      .bind(now, now - 2_592_000),
    env.DB.prepare("DELETE FROM hint_events WHERE created_at < ?")
      .bind(now - 31_536_000),
  ]);
}
```

The nullable `attempts.session_id ... ON DELETE SET NULL` is intentional: attempts already linked to
a Telegram `player_id` survive cleanup of the guest or Telegram session that created them. The first
cleanup statement removes only truly unlinked guest attempts; profile deletion still removes linked
attempts through `attempts.player_id ON DELETE CASCADE`.

`apps/api/src/index.ts`:

```ts
import { app } from "./app";
import type { Env } from "./env";
import { cleanupExpired } from "./scheduled";

export default {
  fetch: app.fetch,
  scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanupExpired(env, Math.floor(Date.now() / 1000)));
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 5: Run complete backend gate**

Run: `npm run check`

Expected: exit `0`.

Run: `npm run typecheck`

Expected: exit `0`.

Run: `npm test -w @a-move-ago/api-contract`

Expected: all strict contract tests PASS.

Run: `npm test -w @a-move-ago/api`

Expected: all Worker/D1/gameplay tests PASS.

Run: `npm test -w @a-move-ago/tools`

Expected: all content validation/import tests PASS.

Run: `npm run build -w @a-move-ago/api`

Expected: Wrangler produces a dry-run Worker bundle without network deployment.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "test: cover complete guest gameplay flow"
```

## Milestone exit

- Гость может получить session, прочитать published daily, отправить несколько реконструкций, повторить потерянный POST тем же `attemptUuid`, запросить ordered hint и получить stats.
- Daily projection не содержит `puzzle_solutions` или `puzzle_hints` до соответствующего действия.
- Worker/D1 tests выполняются локально в `workerd`; production deploy ещё не запускается.
