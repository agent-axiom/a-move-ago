# A MOVE AGO Telegram Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить добровольную Telegram-идентичность поверх существующей guest-first игры: Mini App HMAC login, Web/Android OIDC Authorization Code + PKCE, одноразовый handoff, перенос прогресса, безопасные `/me` и logout.

**Architecture:** Guest Bearer session остаётся обязательным якорем каждого login flow. Mini App proof и OIDC ID token проверяются только Worker'ом; после успешной проверки общий account-link service атомарно связывает guest attempts с Telegram player, создаёт replacement session и отзывает guest token. OIDC state, nonce, PKCE verifier и handoff хранятся server-side; state/handoff сохраняются только как purpose-separated hash. Callback выбирает return target из закрытого server-side отображения записанного channel: Web использует `WEB_AUTH_RETURN_URL`, Android — `ANDROID_AUTH_RETURN_URL`; request и state никогда не содержат и не переопределяют return URL.

**Tech Stack:** Hono 4.12.33, Cloudflare Workers/Web Crypto, Cloudflare D1, Workers Rate Limiting binding, Telegram Mini Apps, Telegram OpenID Connect, PKCE S256, jose 6.2.3, Zod 4.4.3, Workers Vitest pool 0.20.1.

---

**Порядок:** план 3 из 5. Требует полностью завершённые планы `01-foundation-game-core` и `02-api-gameplay`; после него выполнять `04-client` и `05-android-delivery`.

## Зафиксированный внешний контракт

| Endpoint | Authorization | Request | Success |
|---|---|---|---|
| `POST /v1/auth/telegram/mini-app` | current guest Bearer, channel `telegram` | `{ initData: string }` | `200 TelegramSessionIssued` |
| `POST /v1/auth/telegram/oidc/start` | current guest Bearer, channel `web | android` | `{ channel: "web" | "android" }` | `200 { authorizationUrl, expiresAt }` |
| `GET /v1/auth/telegram/oidc/callback` | one-time `state` query | Telegram `code` or OAuth error | fixed `302` to configured Web/Android target |
| `POST /v1/auth/session/exchange` | the same guest Bearer used at start | `{ handoffCode: string }` | `200 TelegramSessionIssued` |
| `GET /v1/me` | any active Bearer | none | existing `MeResponseSchema` |
| `POST /v1/auth/logout` | any active Bearer | none | existing guest `SessionIssuedSchema` |

`TelegramSessionIssued` is deliberately flat so the client stores tokens through the same path as guest issue/logout:

```json
{
  "token": "opaque-base64url-token",
  "expiresAt": "2026-11-01T00:00:00.000Z",
  "kind": "telegram",
  "profile": {
    "telegramUserId": "987654321",
    "displayName": "Ada Lovelace",
    "username": "ada",
    "avatarUrl": "https://cdn.example/avatar.jpg"
  }
}
```

No endpoint accepts `returnUrl`, OIDC issuer, JWKS URI, scope or algorithm from the client.

Android return configuration is exact and allowlisted. Production must set `ANDROID_AUTH_RETURN_URL` to `${API_ORIGIN}/auth/android`, a verified HTTPS App Link. Local/test debug builds use exactly `amoveago-debug://auth`. Neither target is accepted from the start request, callback query, serialized `state`, or handoff exchange.

## Карта файлов

- `packages/api-contract/src/api.ts` — strict Mini App/OIDC/handoff request and response schemas.
- `apps/api/migrations/0002_telegram_auth.sql` — short-lived OIDC transaction and handoff state.
- `apps/api/src/env.ts` — Telegram secrets, fixed URLs, TTLs and auth rate-limit binding.
- `apps/api/src/crypto/encoding.ts` — UTF-8, hex and unpadded base64url conversion.
- `apps/api/src/crypto/opaque-token.ts` — existing session HMAC plus purpose-separated state/handoff hashes.
- `apps/api/src/crypto/pkce.ts` — 32-byte verifier and RFC 7636 S256 challenge.
- `apps/api/src/auth/types.ts` — provider-neutral verified Telegram identity.
- `apps/api/src/auth/telegram-mini-app.ts` — raw initData parsing, HMAC, TTL and profile validation.
- `apps/api/src/auth/telegram-oidc.ts` — token exchange, jose/JWKS verification and claim narrowing.
- `apps/api/src/auth/return-target.ts` — typed, closed Web/Android return-target mapping and production/debug validation.
- `apps/api/src/db/players.ts` — Mini App/OIDC identity upserts and safe profile reads.
- `apps/api/src/db/auth-flows.ts` — create/claim/complete state and one-time handoff.
- `apps/api/src/services/account-link-service.ts` — atomic attempt merge, replacement session and guest revoke.
- `apps/api/src/services/oidc-service.ts` — fixed-channel start/callback/exchange orchestration.
- `apps/api/src/routes/mini-app-auth.ts` — explicit Mini App consent endpoint.
- `apps/api/src/routes/oidc-auth.ts` — Telegram OIDC start and callback HTTP mapping.
- `apps/api/src/routes/session-auth.ts` — exact `/logout` and `/session/exchange` session mutations.
- `apps/api/src/routes/me.ts` — authenticated Telegram profile projection.
- `apps/api/src/services/session-service.ts` — logout rotation uses the same concurrency guard as login.
- `apps/api/src/middleware/origin.ts` — exact browser-origin enforcement for auth mutations.
- `apps/api/src/middleware/rate-limit.ts` — existing limiter extended with auth policy.
- `apps/api/src/middleware/structured-log.ts` — confirms URL query/auth payloads are never logged.
- `apps/api/src/scheduled.ts` — expired auth-flow cleanup.
- `apps/api/src/app.ts` — mounts auth routes and exposes a narrow OIDC dependency seam for tests.
- `apps/api/wrangler.jsonc` — required secret names, fixed provider/return vars, TTLs and the appended `AUTH_RATE_LIMITER`.
- `apps/api/vitest.config.ts` — non-production Telegram test secrets and URLs.
- `apps/api/test/fixtures/telegram.ts` — independent Mini App signer and local RS256 OIDC issuer.
- `apps/api/test/telegram-mini-app.test.ts` — HMAC/TTL/malformed proof tests.
- `apps/api/test/mini-app-auth.test.ts` — proof-to-player guest merge tests.
- `apps/api/test/oidc-start.test.ts` — state/nonce/PKCE/redirect construction tests.
- `apps/api/test/telegram-oidc.test.ts` — token endpoint and jose fail-closed tests.
- `apps/api/test/oidc-callback.test.ts` — state, callback, handoff binding/expiry/replay tests.
- `apps/api/test/auth-return-target.test.ts` — fixed Web, production App Link and debug-scheme allowlist tests.
- `apps/api/test/auth-security.test.ts` — origin, rate limit, safe logs, `/me`, logout and cleanup tests.
- `apps/api/test/telegram-auth.integration.test.ts` — complete Mini App and OIDC merge journeys.

### Task 1: Зафиксировать auth contract, D1 transaction state и Worker configuration

**Files:**
- Modify: `packages/api-contract/src/api.ts`
- Create: `apps/api/migrations/0002_telegram_auth.sql`
- Modify: `apps/api/test/migrations.test.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/wrangler.jsonc`
- Modify: `apps/api/vitest.config.ts`
- Test: `packages/api-contract/src/contracts.test.ts`

- [ ] **Step 1: Написать failing contract tests**

Append to `packages/api-contract/src/contracts.test.ts`:

```ts
import {
  HandoffExchangeRequestSchema,
  OidcStartRequestSchema,
  OidcStartResponseSchema,
  TelegramMiniAppAuthRequestSchema,
  TelegramSessionIssuedSchema,
} from "./index";

it("accepts only the intended Telegram login payloads", () => {
  expect(TelegramMiniAppAuthRequestSchema.parse({ initData: "auth_date=1&hash=aa" }))
    .toEqual({ initData: "auth_date=1&hash=aa" });
  expect(OidcStartRequestSchema.parse({ channel: "android" })).toEqual({ channel: "android" });
  expect(OidcStartRequestSchema.safeParse({ channel: "telegram" }).success).toBe(false);
  expect(OidcStartRequestSchema.safeParse({ channel: "web", returnUrl: "https://evil.test" }).success)
    .toBe(false);
  expect(HandoffExchangeRequestSchema.safeParse({ handoffCode: "a".repeat(43) }).success).toBe(true);
});

it("shares one flat authenticated-session response", () => {
  const value = {
    token: "a".repeat(43),
    expiresAt: "2026-11-01T00:00:00.000Z",
    kind: "telegram",
    profile: {
      telegramUserId: "987654321",
      displayName: "Ada Lovelace",
      username: "ada",
      avatarUrl: "https://cdn.example/avatar.jpg",
    },
  };
  expect(TelegramSessionIssuedSchema.parse(value)).toEqual(value);
  expect(OidcStartResponseSchema.parse({
    authorizationUrl: "https://oauth.telegram.org/auth?response_type=code",
    expiresAt: "2026-08-03T12:10:00.000Z",
  }).authorizationUrl).toContain("oauth.telegram.org");
});
```

- [ ] **Step 2: Run contract tests RED**

Run: `npm test -w @a-move-ago/api-contract -- src/contracts.test.ts`

Expected: FAIL with missing Telegram auth schema exports.

- [ ] **Step 3: Add the strict schemas**

Append to `packages/api-contract/src/api.ts`:

```ts
export const TelegramMiniAppAuthRequestSchema = z.object({
  initData: z.string().min(1).max(8192),
}).strict();

export const OidcStartRequestSchema = z.object({
  channel: z.enum(["web", "android"]),
}).strict();

export const OidcStartResponseSchema = z.object({
  authorizationUrl: z.url(),
  expiresAt: z.iso.datetime(),
}).strict();

export const HandoffExchangeRequestSchema = z.object({
  handoffCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const TelegramSessionIssuedSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  kind: z.literal("telegram"),
  profile: TelegramProfileSchema,
}).strict();

export type TelegramProfile = z.infer<typeof TelegramProfileSchema>;
export type TelegramMiniAppAuthRequest = z.infer<typeof TelegramMiniAppAuthRequestSchema>;
export type OidcStartRequest = z.infer<typeof OidcStartRequestSchema>;
export type OidcStartResponse = z.infer<typeof OidcStartResponseSchema>;
export type HandoffExchangeRequest = z.infer<typeof HandoffExchangeRequestSchema>;
export type TelegramSessionIssued = z.infer<typeof TelegramSessionIssuedSchema>;
```

- [ ] **Step 4: Write the failing migration assertion**

Append to `apps/api/test/migrations.test.ts`:

```ts
it("stores hashed one-time OIDC state and handoff data", async () => {
  const columns = await env.DB.prepare("PRAGMA table_info(auth_flows)")
    .all<{ name: string }>();
  expect(columns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
    "state_hash",
    "guest_session_id",
    "channel",
    "nonce",
    "pkce_verifier",
    "callback_claimed_at",
    "player_id",
    "handoff_hash",
    "handoff_expires_at",
    "handoff_consumed_at",
    "handoff_session_id",
  ]));
  expect(columns.results.map((column) => column.name)).not.toContain("state");
  expect(columns.results.map((column) => column.name)).not.toContain("handoff_code");
});
```

- [ ] **Step 5: Run migration test RED**

Run: `npm test -w @a-move-ago/api -- test/migrations.test.ts`

Expected: FAIL with `no such table: auth_flows`.

- [ ] **Step 6: Create the auth migration**

`apps/api/migrations/0002_telegram_auth.sql`:

```sql
CREATE TABLE auth_flows (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  guest_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'android')),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  callback_claimed_at INTEGER,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  handoff_hash TEXT UNIQUE,
  handoff_expires_at INTEGER,
  handoff_consumed_at INTEGER,
  handoff_session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (
    (handoff_hash IS NULL AND handoff_expires_at IS NULL AND player_id IS NULL)
    OR
    (handoff_hash IS NOT NULL AND handoff_expires_at IS NOT NULL AND player_id IS NOT NULL)
  ),
  CHECK (
    (handoff_consumed_at IS NULL AND handoff_session_id IS NULL)
    OR
    (handoff_consumed_at IS NOT NULL AND handoff_session_id IS NOT NULL)
  )
);

CREATE INDEX auth_flows_expiry_idx ON auth_flows(expires_at);
CREATE INDEX auth_flows_guest_idx ON auth_flows(guest_session_id, created_at);
```

- [ ] **Step 7: Extend bindings and deployment configuration**

Add to `apps/api/src/env.ts` `Env`:

```ts
TELEGRAM_BOT_TOKEN: string;
TELEGRAM_OIDC_CLIENT_ID: string;
TELEGRAM_OIDC_CLIENT_SECRET: string;
TELEGRAM_OIDC_CALLBACK_URL: string;
API_ORIGIN: string;
WEB_AUTH_RETURN_URL: string;
ANDROID_AUTH_RETURN_URL: string;
TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: string;
TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS: string;
OIDC_FLOW_TTL_SECONDS: string;
HANDOFF_TTL_SECONDS: string;
AUTH_RATE_LIMITER: RateLimitBinding;
```

`RateLimitBinding` is the binding type already introduced by plan 02. Do not introduce a second `RateLimit`/`Limiter` environment type.

Add this supported top-level required-secret declaration to `apps/api/wrangler.jsonc`:

```jsonc
"secrets": {
  "required": [
    "SESSION_PEPPER",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OIDC_CLIENT_SECRET"
  ]
}
```

This declares names only, never values. Current Wrangler validates required secrets during local development and deploy and uses the list as the source of truth for type generation.

Append this object to the existing top-level `ratelimits` array created by plan 02; keep its three gameplay entries and do not create a second `ratelimits` key:

```jsonc
{
  "name": "AUTH_RATE_LIMITER",
  "namespace_id": "900000004",
  "simple": { "limit": 10, "period": 60 }
}
```

Replace the existing `observability` object with:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "invocation_logs": false
  }
}
```

Cloudflare invocation logs include the request URL, so leaving them enabled would persist OIDC `code`, `state`, or `handoff` query values. Custom `console.log` events remain enabled and Task 7 restricts them to safe structured fields.

Keep the three values out of `vars`, source files, and Git. Local development loads matching names from ignored `.dev.vars`; production plan 05 supplies them through an ephemeral mode-`0600` secrets file to Wrangler.

Add to existing `vars`:

```jsonc
"TELEGRAM_OIDC_CLIENT_ID": "123456789",
"TELEGRAM_OIDC_CALLBACK_URL": "https://a-move-ago-api.example.invalid/v1/auth/telegram/oidc/callback",
"API_ORIGIN": "https://a-move-ago-api.example.invalid",
"WEB_AUTH_RETURN_URL": "https://agent-axiom.github.io/a-move-ago/",
"ANDROID_AUTH_RETURN_URL": "amoveago-debug://auth",
"TELEGRAM_INIT_DATA_MAX_AGE_SECONDS": "3600",
"TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS": "30",
"OIDC_FLOW_TTL_SECONDS": "600",
"HANDOFF_TTL_SECONDS": "60"
```

Add non-production secrets to `apps/api/vitest.config.ts` `miniflare.bindings`:

```ts
TELEGRAM_BOT_TOKEN: "123456:test-bot-secret",
TELEGRAM_OIDC_CLIENT_SECRET: "test-oidc-client-secret",
ENVIRONMENT: "test",
API_ORIGIN: "https://api.test",
WEB_AUTH_RETURN_URL: "https://agent-axiom.github.io/a-move-ago/",
ANDROID_AUTH_RETURN_URL: "amoveago-debug://auth",
```

Production deployment overrides must satisfy this exact tuple:

```text
API_ORIGIN=https://<the Worker API host>
TELEGRAM_OIDC_CALLBACK_URL=${API_ORIGIN}/v1/auth/telegram/oidc/callback
ANDROID_AUTH_RETURN_URL=${API_ORIGIN}/auth/android
```

`API_ORIGIN` must be an HTTPS origin without path/query/fragment. `ANDROID_AUTH_RETURN_URL` is still an independently supplied fixed server variable so a bad deployment fails preflight instead of silently deriving or accepting a client target.

- [ ] **Step 8: Run contract, migration and type generation GREEN**

Run: `npm test -w @a-move-ago/api-contract -- src/contracts.test.ts`

Expected: all contract tests PASS.

Run: `npm test -w @a-move-ago/api -- test/migrations.test.ts`

Expected: both baseline and `auth_flows` assertions PASS.

Run: `npm run cf-typegen -w @a-move-ago/api`

Expected: generated Worker bindings include the three names from `secrets.required`, all configured non-secret Telegram vars, and `AUTH_RATE_LIMITER`; Wrangler accepts `observability.logs.invocation_logs: false`.

- [ ] **Step 9: Commit**

```bash
git add packages/api-contract/src/api.ts packages/api-contract/src/contracts.test.ts
git add apps/api/migrations/0002_telegram_auth.sql apps/api/test/migrations.test.ts
git add apps/api/src/env.ts apps/api/wrangler.jsonc apps/api/vitest.config.ts apps/api/src/worker-configuration.d.ts
git commit -m "feat: define Telegram auth transactions"
```

### Task 2: Проверить Telegram Mini App initData fail-closed

**Files:**
- Create: `apps/api/src/crypto/encoding.ts`
- Modify: `apps/api/src/crypto/opaque-token.ts`
- Create: `apps/api/src/auth/types.ts`
- Create: `apps/api/src/auth/telegram-mini-app.ts`
- Create: `apps/api/test/fixtures/telegram.ts`
- Test: `apps/api/test/telegram-mini-app.test.ts`

- [ ] **Step 1: Create an independent test signer and failing verifier tests**

`apps/api/test/fixtures/telegram.ts`:

```ts
const encoder = new TextEncoder();

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signedMiniAppData(input: {
  botToken: string;
  authDate: number;
  user?: Record<string, unknown>;
  extra?: Record<string, string>;
}): Promise<string> {
  const fields = new URLSearchParams({
    auth_date: String(input.authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(input.user ?? {
      id: 987654321,
      first_name: "Ada",
      last_name: "Lovelace",
      username: "ada",
      photo_url: "https://cdn.example/avatar.jpg",
    }),
    ...input.extra,
  });
  const checkString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), input.botToken);
  const signature = await hmac(secret, checkString);
  fields.set(
    "hash",
    Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  return fields.toString();
}
```

`apps/api/test/telegram-mini-app.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifyMiniAppInitData } from "../src/auth/telegram-mini-app";
import { signedMiniAppData } from "./fixtures/telegram";

const botToken = "123456:test-bot-secret";
const now = 1_785_758_400;

describe("Telegram Mini App proof", () => {
  it("verifies HMAC, auth_date and profile fields", async () => {
    const raw = await signedMiniAppData({ botToken, authDate: now - 300 });
    await expect(verifyMiniAppInitData(raw, {
      botToken,
      nowSeconds: now,
      maxAgeSeconds: 3600,
      futureSkewSeconds: 30,
    })).resolves.toEqual({
      telegramUserId: "987654321",
      displayName: "Ada Lovelace",
      username: "ada",
      avatarUrl: "https://cdn.example/avatar.jpg",
    });
  });

  it("includes the modern signature field in bot-token HMAC input", async () => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now,
      extra: { signature: "third-party-signature" },
    });
    await expect(verifyMiniAppInitData(raw, {
      botToken,
      nowSeconds: now,
      maxAgeSeconds: 3600,
      futureSkewSeconds: 30,
    })).resolves.toMatchObject({ telegramUserId: "987654321" });
  });

  it.each([
    ["tampered", async () => `${await signedMiniAppData({ botToken, authDate: now })}x`],
    ["bad hash length", async () => `auth_date=${now}&user=%7B%7D&hash=aa`],
    ["duplicate field", async () => `${await signedMiniAppData({ botToken, authDate: now })}&auth_date=${now}`],
    ["non-decimal auth_date", async () => signedMiniAppData({
      botToken,
      authDate: now,
      extra: { auth_date: "1e3" },
    })],
    ["missing user id", async () => signedMiniAppData({ botToken, authDate: now, user: { first_name: "Ada" } })],
  ])("rejects %s without throwing secret values", async (_name, makeRaw) => {
    await expect(verifyMiniAppInitData(await makeRaw(), {
      botToken,
      nowSeconds: now,
      maxAgeSeconds: 3600,
      futureSkewSeconds: 30,
    })).rejects.toMatchObject({ code: "TELEGRAM_PROOF_INVALID" });
  });

  it("rejects expired and future proofs", async () => {
    const expired = await signedMiniAppData({ botToken, authDate: now - 3601 });
    const future = await signedMiniAppData({ botToken, authDate: now + 31 });
    await expect(verifyMiniAppInitData(expired, {
      botToken,
      nowSeconds: now,
      maxAgeSeconds: 3600,
      futureSkewSeconds: 30,
    })).rejects.toMatchObject({ code: "TELEGRAM_PROOF_EXPIRED" });
    await expect(verifyMiniAppInitData(future, {
      botToken,
      nowSeconds: now,
      maxAgeSeconds: 3600,
      futureSkewSeconds: 30,
    })).rejects.toMatchObject({ code: "TELEGRAM_PROOF_INVALID" });
  });
});
```

- [ ] **Step 2: Run Mini App tests RED**

Run: `npm test -w @a-move-ago/api -- test/telegram-mini-app.test.ts`

Expected: FAIL because `telegram-mini-app.ts` does not exist.

- [ ] **Step 3: Implement encoding and identity types**

`apps/api/src/crypto/encoding.ts`:

```ts
export const utf8 = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}
```

`apps/api/src/auth/types.ts`:

```ts
export type VerifiedTelegramIdentity = {
  telegramUserId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  oidc?: {
    issuer: "https://oauth.telegram.org";
    subject: string;
    audience: string;
  };
};
```

Extend `apps/api/src/crypto/opaque-token.ts` by **replacing** the plan-2
`hashSessionToken` implementation with the generic helper plus wrapper below. Keep the existing
module-level `encoder` and `newOpaqueToken`; do not append a second `hashSessionToken` declaration:

```ts
export async function hashOpaqueToken(
  token: string,
  pepper: string,
  purpose: "session" | "oidc-state" | "oidc-handoff",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\0${token}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashSessionToken(token: string, pepper: string): Promise<string> {
  return hashOpaqueToken(token, pepper, "session");
}
```

- [ ] **Step 4: Implement raw initData verification**

`apps/api/src/auth/telegram-mini-app.ts`:

```ts
import { z } from "zod";
import type { VerifiedTelegramIdentity } from "./types";
import { hexToBytes, utf8 } from "../crypto/encoding";

const WebAppUserSchema = z.object({
  id: z.number().int().safe().positive(),
  first_name: z.string().min(1),
  last_name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  photo_url: z.url().optional(),
}).passthrough();

export class TelegramProofError extends Error {
  constructor(readonly code: "TELEGRAM_PROOF_INVALID" | "TELEGRAM_PROOF_EXPIRED") {
    super(code);
    this.name = "TelegramProofError";
  }
}

async function hmac(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(value)));
}

export async function verifyMiniAppInitData(
  raw: string,
  options: {
    botToken: string;
    nowSeconds: number;
    maxAgeSeconds: number;
    futureSkewSeconds: number;
  },
): Promise<VerifiedTelegramIdentity> {
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size) throw new TelegramProofError("TELEGRAM_PROOF_INVALID");

  const received = hexToBytes(params.get("hash") ?? "");
  const rawAuthDate = params.get("auth_date");
  const authDate = Number(rawAuthDate);
  const rawUser = params.get("user");
  if (!received || !rawAuthDate || !/^\d+$/.test(rawAuthDate) || !Number.isSafeInteger(authDate) || !rawUser) {
    throw new TelegramProofError("TELEGRAM_PROOF_INVALID");
  }

  const checkString = keys
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${params.get(key) ?? ""}`)
    .join("\n");
  const secret = await hmac(utf8.encode("WebAppData"), options.botToken);
  const expected = await hmac(secret, checkString);
  if (received.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(received, expected)) {
    throw new TelegramProofError("TELEGRAM_PROOF_INVALID");
  }
  if (authDate > options.nowSeconds + options.futureSkewSeconds) {
    throw new TelegramProofError("TELEGRAM_PROOF_INVALID");
  }
  if (options.nowSeconds - authDate > options.maxAgeSeconds) {
    throw new TelegramProofError("TELEGRAM_PROOF_EXPIRED");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawUser);
  } catch {
    throw new TelegramProofError("TELEGRAM_PROOF_INVALID");
  }
  const parsed = WebAppUserSchema.safeParse(decoded);
  if (!parsed.success) throw new TelegramProofError("TELEGRAM_PROOF_INVALID");
  const displayName = [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" ");
  return {
    telegramUserId: String(parsed.data.id),
    displayName,
    username: parsed.data.username ?? null,
    avatarUrl: parsed.data.photo_url ?? null,
  };
}
```

- [ ] **Step 5: Run Mini App tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/telegram-mini-app.test.ts`

Expected: all valid, tamper, malformed, duplicate, expiry and skew cases PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/crypto/encoding.ts apps/api/src/crypto/opaque-token.ts
git add apps/api/src/auth apps/api/test/fixtures/telegram.ts apps/api/test/telegram-mini-app.test.ts
git commit -m "feat: verify Telegram Mini App proofs"
```

### Task 3: Upsert Telegram players, merge guest progress и rotate the session

**Files:**
- Create: `apps/api/src/db/players.ts`
- Create: `apps/api/src/services/account-link-service.ts`
- Create: `apps/api/src/routes/mini-app-auth.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/mini-app-auth.test.ts`

- [ ] **Step 1: Write the failing Mini App account-link test**

`apps/api/test/mini-app-auth.test.ts`:

```ts
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { signedMiniAppData } from "./fixtures/telegram";
import { authenticatedJson, issueGuest, resetDatabase, seedAttempt } from "./helpers/http";

describe("POST /v1/auth/telegram/mini-app", () => {
  beforeEach(resetDatabase);

  it("links verified progress and revokes the guest token", async () => {
    const guest = await issueGuest("telegram");
    await seedAttempt({ sessionId: guest.sessionId, attemptId: "attempt-before-login" });
    const initData = await signedMiniAppData({
      botToken: env.TELEGRAM_BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
    });
    const login = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData },
    });

    expect(login.response.status).toBe(200);
    expect(login.body).toMatchObject({
      kind: "telegram",
      profile: { telegramUserId: "987654321", displayName: "Ada Lovelace" },
    });
    expect(login.body.token).not.toBe(guest.token);
    const attempt = await env.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind("attempt-before-login").first<{ player_id: string | null }>();
    expect(attempt?.player_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(401);
    expect((await authenticatedJson("/v1/me", login.body.token)).body)
      .toEqual({ kind: "telegram", profile: login.body.profile });
  });

  it("keeps the guest session intact when proof verification fails", async () => {
    const guest = await issueGuest("telegram");
    const login = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: "auth_date=1&hash=00" },
    });
    expect(login.response.status).toBe(401);
    expect(login.body.error.code).toBe("TELEGRAM_PROOF_INVALID");
    expect((await authenticatedJson("/v1/me", guest.token)).response.status).toBe(200);
  });

  it("rejects a non-Telegram guest channel", async () => {
    const guest = await issueGuest("web");
    const response = await authenticatedJson("/v1/auth/telegram/mini-app", guest.token, {
      method: "POST",
      body: { initData: "unused" },
    });
    expect(response.response.status).toBe(409);
    expect(response.body.error.code).toBe("AUTH_CHANNEL_MISMATCH");
  });
});
```

- [ ] **Step 2: Run account-link test RED**

Run: `npm test -w @a-move-ago/api -- test/mini-app-auth.test.ts`

Expected: FAIL with 404 Mini App auth route.

- [ ] **Step 3: Implement player repository**

`apps/api/src/db/players.ts`:

```ts
import type { TelegramProfile } from "@a-move-ago/api-contract";
import type { VerifiedTelegramIdentity } from "../auth/types";

export type PlayerRow = {
  id: string;
  telegram_user_id: string;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  oidc_audience: string | null;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
};

export function toTelegramProfile(row: PlayerRow): TelegramProfile {
  return {
    telegramUserId: row.telegram_user_id,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
  };
}

export async function upsertMiniAppPlayer(
  db: D1Database,
  identity: VerifiedTelegramIdentity,
  now: number,
): Promise<PlayerRow> {
  const row = await db.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET
       display_name = excluded.display_name,
       username = excluded.username,
       avatar_url = excluded.avatar_url,
       updated_at = excluded.updated_at
     RETURNING id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
               display_name, username, avatar_url`,
  ).bind(
    crypto.randomUUID(),
    identity.telegramUserId,
    identity.displayName,
    identity.username,
    identity.avatarUrl,
    now,
    now,
  ).first<PlayerRow>();
  if (!row) throw new Error("Player upsert returned no row");
  return row;
}

export async function findPlayer(db: D1Database, playerId: string): Promise<PlayerRow | null> {
  return db.prepare(
    `SELECT id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
            display_name, username, avatar_url
       FROM players WHERE id = ?`,
  ).bind(playerId).first<PlayerRow>();
}
```

- [ ] **Step 4: Implement atomic guest-to-player rotation**

`apps/api/src/services/account-link-service.ts`:

```ts
import { TelegramSessionIssuedSchema } from "@a-move-ago/api-contract";
import type { Env, SessionActor } from "../env";
import { hashSessionToken, newOpaqueToken } from "../crypto/opaque-token";
import type { PlayerRow } from "../db/players";
import { toTelegramProfile } from "../db/players";
import { ApiError } from "../http/api-error";

export async function linkGuestToPlayer(
  env: Env,
  guest: SessionActor,
  player: PlayerRow,
  now: number,
) {
  if (guest.kind !== "guest" || guest.playerId !== null) {
    throw new ApiError(409, "AUTH_REQUIRES_GUEST", "Start login from a guest session.");
  }
  const token = newOpaqueToken();
  const sessionId = crypto.randomUUID();
  const tokenHash = await hashSessionToken(token, env.SESSION_PEPPER);
  const expiresAt = now + Number(env.SESSION_TTL_SECONDS);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, NULL, ?)`,
      ).bind(sessionId, player.id, tokenHash, guest.channel, guest.sessionId, now, expiresAt, now),
      env.DB.prepare(
        "UPDATE attempts SET player_id = ? WHERE session_id = ? AND player_id IS NULL",
      ).bind(player.id, guest.sessionId),
      env.DB.prepare(
        "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND kind = 'guest'",
      ).bind(now, guest.sessionId),
    ]);
  } catch (error) {
    const replacement = await env.DB.prepare(
      "SELECT id FROM sessions WHERE rotated_from_session_id = ?",
    ).bind(guest.sessionId).first<{ id: string }>().catch(() => null);
    if (replacement) {
      throw new ApiError(401, "INVALID_SESSION", "The guest session is no longer active.");
    }
    throw error;
  }
  return TelegramSessionIssuedSchema.parse({
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    kind: "telegram",
    profile: toTelegramProfile(player),
  });
}
```

The unique `sessions.rotated_from_session_id` constraint is the concurrency guard: only one Mini App login, OIDC exchange or logout can replace a guest session.

`attempts.session_id` is nullable with `ON DELETE SET NULL` after the plan 02 retention fix. Linking runs while the original guest session still exists, so the `WHERE session_id = ?` update remains valid; later session cleanup may null only that provenance column while `attempts.player_id` preserves account history. All post-login stats/ownership queries must scope by `player_id` and tolerate a null originating `session_id`.

- [ ] **Step 5: Implement the Mini App route and mount it**

`apps/api/src/routes/mini-app-auth.ts`:

```ts
import { TelegramMiniAppAuthRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { verifyMiniAppInitData, TelegramProofError } from "../auth/telegram-mini-app";
import { upsertMiniAppPlayer } from "../db/players";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { enforceLimit } from "../middleware/rate-limit";
import { linkGuestToPlayer } from "../services/account-link-service";

export const miniAppAuth = new Hono<{ Bindings: Env; Variables: Variables }>();

miniAppAuth.post("/", requireSession, async (c) => {
  const guest = c.get("session");
  if (guest.kind !== "guest" || guest.channel !== "telegram") {
    throw new ApiError(409, "AUTH_CHANNEL_MISMATCH", "Use a Telegram guest session.");
  }
  await enforceLimit(c.env.AUTH_RATE_LIMITER, `auth:${guest.sessionId}`);
  const parsed = TelegramMiniAppAuthRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", "Invalid request body.");
  const now = Math.floor(Date.now() / 1000);
  try {
    const identity = await verifyMiniAppInitData(parsed.data.initData, {
      botToken: c.env.TELEGRAM_BOT_TOKEN,
      nowSeconds: now,
      maxAgeSeconds: Number(c.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS),
      futureSkewSeconds: Number(c.env.TELEGRAM_INIT_DATA_FUTURE_SKEW_SECONDS),
    });
    const player = await upsertMiniAppPlayer(c.env.DB, identity, now);
    const result = await linkGuestToPlayer(c.env, guest, player, now);
    c.header("cache-control", "no-store");
    return c.json(result);
  } catch (error) {
    if (error instanceof TelegramProofError) {
      throw new ApiError(401, error.code, "Telegram proof is invalid or expired.");
    }
    throw error;
  }
});
```

Mount in `apps/api/src/app.ts`:

```ts
app.route("/v1/auth/telegram/mini-app", miniAppAuth);
```

- [ ] **Step 6: Run Mini App link tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/mini-app-auth.test.ts`

Expected: valid merge, old-token rejection, profile `/me`, invalid-proof preservation and channel rejection PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/players.ts apps/api/src/services/account-link-service.ts
git add apps/api/src/routes/mini-app-auth.ts apps/api/src/app.ts apps/api/test/mini-app-auth.test.ts
git commit -m "feat: link Mini App guests to Telegram"
```

### Task 4: Создать state/nonce и PKCE S256 OIDC start

**Files:**
- Create: `apps/api/src/crypto/pkce.ts`
- Create: `apps/api/src/db/auth-flows.ts`
- Create: `apps/api/src/services/oidc-service.ts`
- Create: `apps/api/src/routes/oidc-auth.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/oidc-start.test.ts`

- [ ] **Step 1: Write failing RFC vector and start-route tests**

`apps/api/test/oidc-start.test.ts`:

```ts
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { pkceChallenge } from "../src/crypto/pkce";
import { authenticatedJson, issueGuest, resetDatabase } from "./helpers/http";

describe("Telegram OIDC start", () => {
  beforeEach(resetDatabase);

  it("matches the RFC 7636 S256 vector", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("stores only hashed state and returns a fixed Telegram URL", async () => {
    const guest = await issueGuest("web");
    const response = await authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
      method: "POST",
      body: { channel: "web" },
    });
    expect(response.response.status).toBe(200);
    const url = new URL(response.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has("phone")).toBe(false);
    expect(response.body.authorizationUrl).not.toContain("telegram%3Abot_access");

    const flow = await env.DB.prepare(
      "SELECT state_hash, nonce, pkce_verifier, guest_session_id, channel FROM auth_flows",
    ).first<Record<string, string>>();
    expect(flow?.state_hash).not.toBe(url.searchParams.get("state"));
    expect(flow?.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(flow?.pkce_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow?.guest_session_id).toBe(guest.sessionId);
    expect(flow?.channel).toBe("web");
  });

  it("rejects channel substitution and arbitrary return URLs", async () => {
    const guest = await issueGuest("android");
    const mismatch = await authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
      method: "POST",
      body: { channel: "web" },
    });
    const injected = await authenticatedJson("/v1/auth/telegram/oidc/start", guest.token, {
      method: "POST",
      body: { channel: "android", returnUrl: "https://evil.test" },
    });
    expect(mismatch.response.status).toBe(409);
    expect(injected.response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run OIDC start tests RED**

Run: `npm test -w @a-move-ago/api -- test/oidc-start.test.ts`

Expected: FAIL because PKCE and OIDC route are absent.

- [ ] **Step 3: Implement PKCE**

`apps/api/src/crypto/pkce.ts`:

```ts
import { bytesToBase64Url, utf8 } from "./encoding";
import { newOpaqueToken } from "./opaque-token";

export async function pkceChallenge(verifier: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(verifier))));
}

export async function newPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = newOpaqueToken();
  return { verifier, challenge: await pkceChallenge(verifier) };
}
```

- [ ] **Step 4: Implement auth-flow creation repository**

Start `apps/api/src/db/auth-flows.ts` with:

```ts
export type AuthFlowRow = {
  id: string;
  guest_session_id: string;
  channel: "web" | "android";
  nonce: string;
  pkce_verifier: string;
  expires_at: number;
  callback_claimed_at: number | null;
  player_id: string | null;
  handoff_expires_at: number | null;
};

export async function insertAuthFlow(db: D1Database, input: {
  id: string;
  stateHash: string;
  guestSessionId: string;
  channel: "web" | "android";
  nonce: string;
  pkceVerifier: string;
  now: number;
  expiresAt: number;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO auth_flows
      (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
       expires_at, callback_claimed_at, player_id, handoff_hash,
       handoff_expires_at, handoff_consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).bind(
    input.id,
    input.stateHash,
    input.guestSessionId,
    input.channel,
    input.nonce,
    input.pkceVerifier,
    input.expiresAt,
    input.now,
  ).run();
}
```

- [ ] **Step 5: Implement OIDC start service and route**

Start `apps/api/src/services/oidc-service.ts` with:

```ts
import type { Env, SessionActor } from "../env";
import { newOpaqueToken, hashOpaqueToken } from "../crypto/opaque-token";
import { newPkcePair } from "../crypto/pkce";
import { insertAuthFlow } from "../db/auth-flows";
import { ApiError } from "../http/api-error";

export async function startOidcFlow(
  env: Env,
  guest: SessionActor,
  channel: "web" | "android",
  now: number,
) {
  if (guest.kind !== "guest" || guest.channel !== channel) {
    throw new ApiError(409, "AUTH_CHANNEL_MISMATCH", "OIDC channel does not match the guest session.");
  }
  const state = newOpaqueToken();
  const nonce = newOpaqueToken();
  const pkce = await newPkcePair();
  const expiresAt = now + Number(env.OIDC_FLOW_TTL_SECONDS);
  await insertAuthFlow(env.DB, {
    id: crypto.randomUUID(),
    stateHash: await hashOpaqueToken(state, env.SESSION_PEPPER, "oidc-state"),
    guestSessionId: guest.sessionId,
    channel,
    nonce,
    pkceVerifier: pkce.verifier,
    now,
    expiresAt,
  });
  const authorizationUrl = new URL("https://oauth.telegram.org/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: env.TELEGRAM_OIDC_CLIENT_ID,
    redirect_uri: env.TELEGRAM_OIDC_CALLBACK_URL,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  }).toString();
  return {
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
```

Start `apps/api/src/routes/oidc-auth.ts`:

```ts
import { OidcStartRequestSchema, OidcStartResponseSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { ApiError } from "../http/api-error";
import { enforceLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { startOidcFlow } from "../services/oidc-service";

export const oidcStartRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

oidcStartRoutes.post("/start", requireSession, async (c) => {
  const guest = c.get("session");
  await enforceLimit(c.env.AUTH_RATE_LIMITER, `auth:${guest.sessionId}`);
  const parsed = OidcStartRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", "Invalid request body.");
  const result = OidcStartResponseSchema.parse(
    await startOidcFlow(c.env, guest, parsed.data.channel, Math.floor(Date.now() / 1000)),
  );
  c.header("cache-control", "no-store");
  return c.json(result);
});
```

Mount in `apps/api/src/app.ts`:

```ts
app.route("/v1/auth/telegram/oidc", oidcStartRoutes);
```

- [ ] **Step 6: Run OIDC start tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/oidc-start.test.ts`

Expected: RFC vector, exact provider URL, hashed state and channel rejection PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/crypto/pkce.ts apps/api/src/db/auth-flows.ts
git add apps/api/src/services/oidc-service.ts apps/api/src/routes/oidc-auth.ts
git add apps/api/src/app.ts apps/api/test/oidc-start.test.ts
git commit -m "feat: start Telegram OIDC with PKCE"
```

### Task 5: Exchange the code and verify Telegram ID tokens with jose

**Files:**
- Create: `apps/api/src/auth/telegram-oidc.ts`
- Test: `apps/api/test/telegram-oidc.test.ts`

- [ ] **Step 1: Write failing token exchange and JWT validation tests**

`apps/api/test/telegram-oidc.test.ts`:

```ts
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exchangeAndVerifyTelegramCode } from "../src/auth/telegram-oidc";

const issuer = "https://oauth.telegram.org";
const clientId = "123456789";
const nonce = "n".repeat(43);
let privateKey: CryptoKey;
let wrongAlgorithmKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  wrongAlgorithmKey = (await generateKeyPair("ES256")).privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = createLocalJWKSet({ keys: [{ ...publicJwk, alg: "RS256", kid: "test-key" }] });
});

async function token(
  overrides: Record<string, unknown> = {},
  signing: { algorithm: "RS256" | "ES256"; key: CryptoKey } = {
    algorithm: "RS256",
    key: privateKey,
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: clientId,
    sub: "telegram-subject-987654321",
    iat: now,
    exp: now + 300,
    nonce,
    id: 987654321,
    name: "Ada Lovelace",
    preferred_username: "ada",
    picture: "https://cdn.example/avatar.jpg",
    ...overrides,
  })
    .setProtectedHeader({
      alg: signing.algorithm,
      kid: signing.algorithm === "RS256" ? "test-key" : "wrong-alg-key",
    })
    .sign(signing.key);
}

describe("Telegram OIDC provider", () => {
  it("uses client_secret_basic and validates all identity claims", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa(`${clientId}:test-client-secret`)}`,
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain("code_verifier=verifier");
      return Response.json({
        access_token: "discarded-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: await token(),
      });
    });
    await expect(exchangeAndVerifyTelegramCode({
      code: "authorization-code",
      verifier: "verifier",
      expectedNonce: nonce,
      clientId,
      clientSecret: "test-client-secret",
      redirectUri: "https://api.test/v1/auth/telegram/oidc/callback",
    }, { fetch: fetchMock, jwks })).resolves.toEqual({
      telegramUserId: "987654321",
      displayName: "Ada Lovelace",
      username: "ada",
      avatarUrl: "https://cdn.example/avatar.jpg",
      oidc: { issuer, subject: "telegram-subject-987654321", audience: clientId },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["nonce", { nonce: "wrong" }],
    ["missing expiration", { exp: undefined }],
    ["profile id", { id: undefined }],
    ["subject", { sub: undefined }],
  ])("rejects an invalid %s", async (_name, overrides) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id_token: await token(overrides) }));
    await expect(exchangeAndVerifyTelegramCode({
      code: "code",
      verifier: "verifier",
      expectedNonce: nonce,
      clientId,
      clientSecret: "secret",
      redirectUri: "https://api.test/v1/auth/telegram/oidc/callback",
    }, { fetch: fetchMock, jwks })).rejects.toMatchObject({ code: "OIDC_TOKEN_INVALID" });
  });

  it("rejects issuer, audience, expiry, non-RS256 algorithm and signature changes", async () => {
    const invalidTokens = [
      await token({ iss: "https://evil.test" }),
      await token({ aud: "other-client" }),
      await token({ exp: 1 }),
      await token({}, { algorithm: "ES256", key: wrongAlgorithmKey }),
      `${await token()}x`,
    ];
    for (const idToken of invalidTokens) {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id_token: idToken }));
      await expect(exchangeAndVerifyTelegramCode({
        code: "code",
        verifier: "verifier",
        expectedNonce: nonce,
        clientId,
        clientSecret: "secret",
        redirectUri: "https://api.test/v1/auth/telegram/oidc/callback",
      }, { fetch: fetchMock, jwks })).rejects.toMatchObject({ code: "OIDC_TOKEN_INVALID" });
    }
  });
});
```

- [ ] **Step 2: Run provider tests RED**

Run: `npm test -w @a-move-ago/api -- test/telegram-oidc.test.ts`

Expected: FAIL because `telegram-oidc.ts` is absent.

- [ ] **Step 3: Implement token exchange and fail-closed jose verification**

`apps/api/src/auth/telegram-oidc.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { VerifiedTelegramIdentity } from "./types";

const issuer = "https://oauth.telegram.org" as const;
const remoteJwks = createRemoteJWKSet(new URL("https://oauth.telegram.org/.well-known/jwks.json"));

const TokenResponseSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
}).passthrough();

const TelegramClaimsSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int(),
  iat: z.number().int(),
  nonce: z.string().min(1),
  id: z.union([z.number().int().safe().positive(), z.string().regex(/^[1-9]\d*$/)]),
  name: z.string().min(1),
  preferred_username: z.string().min(1).optional(),
  picture: z.url().optional(),
}).passthrough();

export class OidcProviderError extends Error {
  constructor(readonly code: "OIDC_PROVIDER_ERROR" | "OIDC_TOKEN_INVALID") {
    super(code);
    this.name = "OidcProviderError";
  }
}

export interface TelegramOidcProvider {
  exchangeAndVerify(input: {
    code: string;
    verifier: string;
    expectedNonce: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<VerifiedTelegramIdentity>;
}

export async function exchangeAndVerifyTelegramCode(
  input: Parameters<TelegramOidcProvider["exchangeAndVerify"]>[0],
  dependencies: { fetch: typeof fetch; jwks: Parameters<typeof jwtVerify>[1] } = {
    fetch,
    jwks: remoteJwks,
  },
): Promise<VerifiedTelegramIdentity> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await dependencies.fetch("https://oauth.telegram.org/token", {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
  } catch {
    throw new OidcProviderError("OIDC_PROVIDER_ERROR");
  }
  if (!response.ok) throw new OidcProviderError("OIDC_PROVIDER_ERROR");
  const tokens = TokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!tokens.success) throw new OidcProviderError("OIDC_PROVIDER_ERROR");

  try {
    const verified = await jwtVerify(tokens.data.id_token, dependencies.jwks, {
      algorithms: ["RS256"],
      issuer,
      audience: input.clientId,
    });
    const claims = TelegramClaimsSchema.parse(verified.payload);
    if (claims.nonce !== input.expectedNonce) throw new Error("nonce mismatch");
    return {
      telegramUserId: String(claims.id),
      displayName: claims.name,
      username: claims.preferred_username ?? null,
      avatarUrl: claims.picture ?? null,
      oidc: { issuer, subject: claims.sub, audience: input.clientId },
    };
  } catch {
    throw new OidcProviderError("OIDC_TOKEN_INVALID");
  }
}

export const telegramOidcProvider: TelegramOidcProvider = {
  exchangeAndVerify: (input) => exchangeAndVerifyTelegramCode(input),
};
```

No UserInfo call is made. `access_token` is parsed only so an otherwise valid provider response is accepted, then discarded without persistence or logs.

- [ ] **Step 4: Run provider tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/telegram-oidc.test.ts`

Expected: token request, valid identity and all fail-closed claim/signature cases PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/telegram-oidc.ts apps/api/test/telegram-oidc.test.ts
git commit -m "feat: verify Telegram OIDC tokens"
```

### Task 6: Complete callback and exchange a guest-bound one-time handoff

**Files:**
- Create: `apps/api/src/auth/return-target.ts`
- Modify: `apps/api/src/db/auth-flows.ts`
- Modify: `apps/api/src/db/players.ts`
- Modify: `apps/api/src/services/account-link-service.ts`
- Modify: `apps/api/src/services/oidc-service.ts`
- Modify: `apps/api/src/routes/oidc-auth.ts`
- Create: `apps/api/src/routes/session-auth.ts`
- Modify: `apps/api/src/routes/sessions.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/auth-return-target.test.ts`
- Test: `apps/api/test/oidc-callback.test.ts`

- [ ] **Step 1: Write failing callback/handoff tests**

`apps/api/test/oidc-callback.test.ts` uses `createApp({ oidcProvider: fakeProvider })` and asserts this complete sequence:

```ts
const guest = await issueGuest("web");
const start = await appJson(app, env, "/v1/auth/telegram/oidc/start", guest.token, {
  method: "POST",
  body: { channel: "web" },
});
const state = new URL(start.body.authorizationUrl).searchParams.get("state")!;
const injectedReturn = await app.request(
  `https://api.test/v1/auth/telegram/oidc/callback?code=provider-code&state=${state}&returnUrl=https://evil.test`,
  {},
  env,
);
expect(injectedReturn.status).toBe(400);

const callback = await app.request(
  `https://api.test/v1/auth/telegram/oidc/callback?code=provider-code&state=${state}`,
  {},
  env,
);
expect(callback.status).toBe(302);
expect(callback.headers.get("cache-control")).toBe("no-store");
expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
const returnUrl = new URL(callback.headers.get("location")!);
expect(returnUrl.origin + returnUrl.pathname).toBe("https://agent-axiom.github.io/a-move-ago/");
const handoffCode = returnUrl.searchParams.get("handoff")!;

const persisted = await env.DB.prepare(
  "SELECT handoff_hash, handoff_consumed_at FROM auth_flows",
).first<{ handoff_hash: string; handoff_consumed_at: number | null }>();
expect(persisted?.handoff_hash).not.toBe(handoffCode);
expect(persisted?.handoff_hash).toMatch(/^[0-9a-f]{64}$/);

const thief = await issueGuest("web");
expect((await appJson(app, env, "/v1/auth/session/exchange", thief.token, {
  method: "POST",
  body: { handoffCode },
})).response.status).toBe(401);

const exchange = await appJson(app, env, "/v1/auth/session/exchange", guest.token, {
  method: "POST",
  body: { handoffCode },
});
expect(exchange.response.status).toBe(200);
expect(exchange.body).toMatchObject({ kind: "telegram", profile: { telegramUserId: "987654321" } });
expect((await appJson(app, env, "/v1/auth/session/exchange", guest.token, {
  method: "POST",
  body: { handoffCode },
})).response.status).toBe(401);
```

The same file also asserts unknown state, expired state, callback replay, expired handoff, fixed Android return URL, provider denial, provider failure, and OIDC identity conflicts. Add a rollback test that installs a temporary D1 trigger which aborts the replacement-session insert, observes a `500`, removes the trigger, and then successfully exchanges the **same** guest-bound handoff. That test proves a failure after the claim statement rolls back the claim, attempt merge and guest revocation together. Every callback response, including `4xx/5xx`, must retain `cache-control: no-store` and `referrer-policy: no-referrer`. It also proves route ownership is exact:

```ts
expect((await app.request("https://api.test/v1/auth/start", { method: "POST" }, env)).status)
  .toBe(404);
expect((await app.request("https://api.test/v1/auth/callback", {}, env)).status)
  .toBe(404);
expect((await app.request(
  "https://api.test/v1/auth/telegram/oidc/session/exchange",
  { method: "POST" },
  env,
)).status).toBe(404);
```

- [ ] **Step 2: Run callback tests RED**

Run: `npm test -w @a-move-ago/api -- test/oidc-callback.test.ts`

Expected: FAIL because callback/exchange routes and app dependency seam are absent.

- [ ] **Step 3: Add one-time auth-flow claims**

Append to `apps/api/src/db/auth-flows.ts`:

```ts
export async function claimAuthFlow(
  db: D1Database,
  stateHash: string,
  now: number,
): Promise<AuthFlowRow | null> {
  return db.prepare(
    `UPDATE auth_flows SET callback_claimed_at = ?
      WHERE state_hash = ? AND callback_claimed_at IS NULL AND expires_at > ?
      RETURNING id, guest_session_id, channel, nonce, pkce_verifier, expires_at,
                callback_claimed_at, player_id, handoff_expires_at`,
  ).bind(now, stateHash, now).first<AuthFlowRow>();
}

export async function completeAuthFlow(db: D1Database, input: {
  flowId: string;
  playerId: string;
  handoffHash: string;
  handoffExpiresAt: number;
}): Promise<void> {
  const result = await db.prepare(
    `UPDATE auth_flows
        SET player_id = ?, handoff_hash = ?, handoff_expires_at = ?
      WHERE id = ? AND callback_claimed_at IS NOT NULL AND handoff_hash IS NULL`,
  ).bind(input.playerId, input.handoffHash, input.handoffExpiresAt, input.flowId).run();
  if (result.meta.changes !== 1) throw new Error("Auth flow completion failed");
}

export async function findClaimableHandoff(db: D1Database, input: {
  handoffHash: string;
  guestSessionId: string;
  channel: "web" | "android";
  now: number;
}): Promise<{ id: string; player_id: string } | null> {
  return db.prepare(
    `SELECT id, player_id FROM auth_flows
      WHERE handoff_hash = ?
        AND guest_session_id = ?
        AND channel = ?
        AND handoff_consumed_at IS NULL
        AND handoff_expires_at > ?
        AND player_id IS NOT NULL`,
  ).bind(
    input.handoffHash,
    input.guestSessionId,
    input.channel,
    input.now,
  ).first<{ id: string; player_id: string }>();
}

export function claimHandoffForSession(db: D1Database, input: {
  flowId: string;
  handoffHash: string;
  guestSessionId: string;
  channel: "web" | "android";
  replacementSessionId: string;
  now: number;
}): D1PreparedStatement {
  return db.prepare(
    `UPDATE auth_flows
        SET handoff_consumed_at = ?, handoff_session_id = ?
      WHERE id = ?
        AND handoff_hash = ?
        AND guest_session_id = ?
        AND channel = ?
        AND handoff_consumed_at IS NULL
        AND handoff_expires_at > ?
        AND player_id IS NOT NULL`,
  ).bind(
    input.now,
    input.replacementSessionId,
    input.flowId,
    input.handoffHash,
    input.guestSessionId,
    input.channel,
    input.now,
  );
}
```

`findClaimableHandoff` is read-only. It must never consume the handoff by itself. The prepared
claim is executed only inside the same D1 `batch()` that inserts the replacement session, moves
attempt ownership and revokes the guest session; `handoff_session_id` is the unique per-exchange
gate used by every following statement in that batch.

- [ ] **Step 4: Implement and test the closed return-target mapping**

Create `apps/api/test/auth-return-target.test.ts` first:

```ts
import { describe, expect, it } from "vitest";
import { resolveAuthReturnTarget } from "../src/auth/return-target";

const base = {
  ENVIRONMENT: "test",
  ALLOWED_ORIGINS: "https://agent-axiom.github.io,http://localhost:5173",
  API_ORIGIN: "https://api.test",
  WEB_AUTH_RETURN_URL: "https://agent-axiom.github.io/a-move-ago/",
  ANDROID_AUTH_RETURN_URL: "amoveago-debug://auth",
};

describe("auth return targets", () => {
  it("maps only stored channels to fixed server configuration", () => {
    expect(resolveAuthReturnTarget(base, "web").toString())
      .toBe("https://agent-axiom.github.io/a-move-ago/");
    expect(resolveAuthReturnTarget(base, "android").toString())
      .toBe("amoveago-debug://auth");
  });

  it("requires the production Android App Link at API_ORIGIN/auth/android", () => {
    expect(resolveAuthReturnTarget({
      ...base,
      ENVIRONMENT: "production",
      API_ORIGIN: "https://api.example.com",
      ANDROID_AUTH_RETURN_URL: "https://api.example.com/auth/android",
    }, "android").toString()).toBe("https://api.example.com/auth/android");

    expect(() => resolveAuthReturnTarget({
      ...base,
      ENVIRONMENT: "production",
      API_ORIGIN: "https://api.example.com",
      ANDROID_AUTH_RETURN_URL: "https://evil.test/auth/android",
    }, "android")).toThrow("Invalid production Android auth return target");
  });

  it("rejects a production API_ORIGIN with a path and any debug target substitution", () => {
    expect(() => resolveAuthReturnTarget({
      ...base,
      ENVIRONMENT: "production",
      API_ORIGIN: "https://api.example.com/prefix",
      ANDROID_AUTH_RETURN_URL: "https://api.example.com/auth/android",
    }, "android")).toThrow("API_ORIGIN must be an HTTPS origin");
    expect(() => resolveAuthReturnTarget({
      ...base,
      ANDROID_AUTH_RETURN_URL: "other-app://auth",
    }, "android")).toThrow("Invalid debug Android auth return target");
  });

  it.each([
    "javascript:alert(1)",
    "http://agent-axiom.github.io/a-move-ago/",
    "https://evil.test/a-move-ago/",
    "https://user:pass@agent-axiom.github.io/a-move-ago/",
    "https://agent-axiom.github.io/a-move-ago/?next=https://evil.test",
    "https://agent-axiom.github.io/a-move-ago/#fragment",
  ])("rejects an unsafe or non-allowlisted Web target: %s", (WEB_AUTH_RETURN_URL) => {
    expect(() => resolveAuthReturnTarget({ ...base, WEB_AUTH_RETURN_URL }, "web"))
      .toThrow("Invalid Web auth return target");
  });
});
```

Run: `npm test -w @a-move-ago/api -- test/auth-return-target.test.ts`

Expected: FAIL because the resolver is absent.

Create `apps/api/src/auth/return-target.ts`:

```ts
import type { Env } from "../env";

export type OidcChannel = "web" | "android";
export type AuthReturnEnv = Pick<
  Env,
  | "ENVIRONMENT"
  | "ALLOWED_ORIGINS"
  | "API_ORIGIN"
  | "WEB_AUTH_RETURN_URL"
  | "ANDROID_AUTH_RETURN_URL"
>;

function productionAndroidTarget(env: AuthReturnEnv): string {
  const apiOrigin = new URL(env.API_ORIGIN);
  if (
    apiOrigin.protocol !== "https:"
    || apiOrigin.username !== ""
    || apiOrigin.password !== ""
    || apiOrigin.pathname !== "/"
    || apiOrigin.search !== ""
    || apiOrigin.hash !== ""
  ) {
    throw new Error("API_ORIGIN must be an HTTPS origin");
  }
  return `${apiOrigin.origin}/auth/android`;
}

export function resolveAuthReturnTarget(env: AuthReturnEnv, channel: OidcChannel): URL {
  const configured = {
    web: env.WEB_AUTH_RETURN_URL,
    android: env.ANDROID_AUTH_RETURN_URL,
  } satisfies Record<OidcChannel, string>;
  const isDebug = env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";
  if (channel === "android") {
    if (isDebug && configured.android !== "amoveago-debug://auth") {
      throw new Error("Invalid debug Android auth return target");
    }
    if (!isDebug && configured.android !== productionAndroidTarget(env)) {
      throw new Error("Invalid production Android auth return target");
    }
  }
  const target = new URL(configured[channel]);
  if (channel === "web") {
    const allowedOrigins = new Set(
      env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    );
    if (
      target.protocol !== "https:"
      || target.username !== ""
      || target.password !== ""
      || target.search !== ""
      || target.hash !== ""
      || !allowedOrigins.has(target.origin)
    ) {
      throw new Error("Invalid Web auth return target");
    }
  }
  if (!target.protocol) throw new Error("Invalid auth return target");
  return target;
}
```

Run: `npm test -w @a-move-ago/api -- test/auth-return-target.test.ts`

Expected: all fixed-target, App Link, debug scheme and invalid-config assertions PASS.

- [ ] **Step 5: Add conflict-safe OIDC player linking**

First extend `apps/api/test/oidc-callback.test.ts` with three persisted-mapping cases:

```ts
const verifiedOidcIdentity = {
  telegramUserId: "987654321",
  displayName: "Ada Lovelace",
  username: "ada",
  avatarUrl: "https://cdn.example/avatar.jpg",
  oidc: {
    issuer: "https://oauth.telegram.org" as const,
    subject: "telegram-subject-987654321",
    audience: "123456789",
  },
};

async function seedPlayerMapping(existing: {
  telegramUserId: string;
  issuer: string;
  subject: string;
  audience: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Existing', NULL, NULL, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    existing.telegramUserId,
    existing.issuer,
    existing.subject,
    existing.audience,
    now,
    now,
  ).run();
}

async function readAllPlayerMappings() {
  return (await env.DB.prepare(
    `SELECT telegram_user_id, oidc_issuer, oidc_subject, oidc_audience
       FROM players ORDER BY telegram_user_id`,
  ).all()).results;
}

async function completeCallbackForIdentity(identity: typeof verifiedOidcIdentity) {
  const app = createApp({ oidcProvider: { exchangeAndVerify: async () => identity } });
  const guest = await issueGuest("web");
  const start = await appJson(app, env, "/v1/auth/telegram/oidc/start", guest.token, {
    method: "POST",
    body: { channel: "web" },
  });
  const state = new URL(start.body.authorizationUrl).searchParams.get("state")!;
  return app.request(
    `https://api.test/v1/auth/telegram/oidc/callback?code=provider-code&state=${state}`,
    {},
    env,
  );
}

it.each([
  {
    name: "subject already belongs to another Telegram player",
    existing: {
      telegramUserId: "111111111",
      issuer: "https://oauth.telegram.org",
      subject: "telegram-subject-987654321",
      audience: "123456789",
    },
  },
  {
    name: "Telegram player already has a different subject",
    existing: {
      telegramUserId: "987654321",
      issuer: "https://oauth.telegram.org",
      subject: "different-subject",
      audience: "123456789",
    },
  },
  {
    name: "Telegram player already has a different audience",
    existing: {
      telegramUserId: "987654321",
      issuer: "https://oauth.telegram.org",
      subject: "telegram-subject-987654321",
      audience: "other-client",
    },
  },
])("rejects when $name without changing the stored mapping", async ({ existing }) => {
  await seedPlayerMapping(existing);
  const before = await readAllPlayerMappings();
  const response = await completeCallbackForIdentity(verifiedOidcIdentity);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("TELEGRAM_IDENTITY_CONFLICT");
  expect(await readAllPlayerMappings()).toEqual(before);
});

it("links an unclaimed Mini App player once and accepts only the exact tuple later", async () => {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, '987654321', NULL, NULL, NULL, 'Ada', NULL, NULL, ?, ?)`,
  ).bind(crypto.randomUUID(), now, now).run();
  expect((await completeCallbackForIdentity(verifiedOidcIdentity)).status).toBe(302);
  expect((await completeCallbackForIdentity(verifiedOidcIdentity)).status).toBe(302);
  expect(await readAllPlayerMappings()).toEqual([{
    telegram_user_id: "987654321",
    oidc_issuer: "https://oauth.telegram.org",
    oidc_subject: "telegram-subject-987654321",
    oidc_audience: "123456789",
  }]);
});
```

Run the callback test now; the overwrite cases must FAIL before the repository change.

Append to `apps/api/src/db/players.ts`:

```ts
type VerifiedOidcIdentity = VerifiedTelegramIdentity & {
  oidc: NonNullable<VerifiedTelegramIdentity["oidc"]>;
};

async function findPlayerByTelegramId(
  db: D1Database,
  telegramUserId: string,
): Promise<PlayerRow | null> {
  return db.prepare(
    `SELECT id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
            display_name, username, avatar_url
       FROM players WHERE telegram_user_id = ?`,
  ).bind(telegramUserId).first<PlayerRow>();
}

async function findPlayerByOidcSubject(
  db: D1Database,
  issuer: string,
  subject: string,
): Promise<PlayerRow | null> {
  return db.prepare(
    `SELECT id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
            display_name, username, avatar_url
       FROM players WHERE oidc_issuer = ? AND oidc_subject = ?`,
  ).bind(issuer, subject).first<PlayerRow>();
}

function mappingMatches(row: PlayerRow, identity: VerifiedOidcIdentity): boolean {
  return row.telegram_user_id === identity.telegramUserId
    && row.oidc_issuer === identity.oidc.issuer
    && row.oidc_subject === identity.oidc.subject
    && row.oidc_audience === identity.oidc.audience;
}

function identityConflict(): never {
  throw new ApiError(409, "TELEGRAM_IDENTITY_CONFLICT", "Telegram identity is already linked.");
}

export async function upsertOidcPlayer(
  db: D1Database,
  identity: VerifiedOidcIdentity,
  now: number,
): Promise<PlayerRow> {
  // Read both unique identity axes before mutation. Never resolve a conflict by overwriting a tuple.
  const byTelegram = await findPlayerByTelegramId(db, identity.telegramUserId);
  const bySubject = await findPlayerByOidcSubject(db, identity.oidc.issuer, identity.oidc.subject);
  if (byTelegram && bySubject && byTelegram.id !== bySubject.id) identityConflict();
  if (bySubject && bySubject.telegram_user_id !== identity.telegramUserId) identityConflict();

  if (byTelegram) {
    const hasStoredOidc = byTelegram.oidc_issuer !== null
      || byTelegram.oidc_subject !== null
      || byTelegram.oidc_audience !== null;
    if (hasStoredOidc && !mappingMatches(byTelegram, identity)) identityConflict();

    let row: PlayerRow | null;
    try {
      row = await db.prepare(
        `UPDATE players
            SET oidc_issuer = ?, oidc_subject = ?, oidc_audience = ?,
                display_name = ?, username = ?, avatar_url = ?, updated_at = ?
          WHERE id = ?
            AND (
              (oidc_issuer IS NULL AND oidc_subject IS NULL AND oidc_audience IS NULL)
              OR (oidc_issuer = ? AND oidc_subject = ? AND oidc_audience = ?)
            )
          RETURNING id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
                    display_name, username, avatar_url`,
      ).bind(
        identity.oidc.issuer,
        identity.oidc.subject,
        identity.oidc.audience,
        identity.displayName,
        identity.username,
        identity.avatarUrl,
        now,
        byTelegram.id,
        identity.oidc.issuer,
        identity.oidc.subject,
        identity.oidc.audience,
      ).first<PlayerRow>();
    } catch (error) {
      const concurrentSubject = await findPlayerByOidcSubject(
        db,
        identity.oidc.issuer,
        identity.oidc.subject,
      );
      if (concurrentSubject && concurrentSubject.id !== byTelegram.id) identityConflict();
      throw error;
    }
    if (!row) identityConflict(); // a concurrent writer changed the tuple
    return row;
  }

  if (bySubject) identityConflict();
  try {
    const row = await db.prepare(
      `INSERT INTO players
        (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
         display_name, username, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
                 display_name, username, avatar_url`,
    ).bind(
      crypto.randomUUID(),
      identity.telegramUserId,
      identity.oidc.issuer,
      identity.oidc.subject,
      identity.oidc.audience,
      identity.displayName,
      identity.username,
      identity.avatarUrl,
      now,
      now,
    ).first<PlayerRow>();
    if (!row) throw new Error("Player upsert returned no row");
    return row;
  } catch (error) {
    // Unique constraints are the race guard; a retry may accept only the exact same tuple.
    const concurrentByTelegram = await findPlayerByTelegramId(db, identity.telegramUserId)
      .catch(() => null);
    const concurrentBySubject = await findPlayerByOidcSubject(
      db,
      identity.oidc.issuer,
      identity.oidc.subject,
    ).catch(() => null);
    if (
      concurrentByTelegram
      && mappingMatches(concurrentByTelegram, identity)
      && (!concurrentBySubject || concurrentBySubject.id === concurrentByTelegram.id)
    ) {
      return concurrentByTelegram;
    }
    if (concurrentByTelegram || concurrentBySubject) identityConflict();
    throw error;
  }
}
```

Add imports for `VerifiedTelegramIdentity` and `ApiError` at the top of the file. The code intentionally has no `ON CONFLICT ... DO UPDATE` for identity columns: pre-read checks provide a useful `409`, the conditional update blocks stale-read overwrites, and the existing unique constraints guard concurrent inserts.

- [ ] **Step 6: Complete OIDC service orchestration**

First extend `apps/api/src/services/account-link-service.ts` with
`exchangeHandoffAndLinkGuest(env, guest, input, now)`. It reuses the token/session construction and
response parsing from `linkGuestToPlayer`, but its mutation boundary is different and must follow
this exact order:

1. reject a non-guest or Telegram-channel actor;
2. call the read-only `findClaimableHandoff` with the purpose-hashed code, original guest session,
   exact `web | android` channel and current time;
3. fetch the returned player **before** any claim; a missing player is `HANDOFF_INVALID`;
4. generate the replacement token/session ID and prepare `claimHandoffForSession`;
5. execute one `env.DB.batch()` containing, in order:
   - the prepared claim, which writes both `handoff_consumed_at` and the unique
     `handoff_session_id`;
   - `INSERT ... SELECT` for the Telegram replacement session, gated by an `EXISTS` on that exact
     auth-flow ID, player ID and `handoff_session_id`;
   - the guest-attempt `player_id` update, gated by existence of that exact replacement session;
   - guest revocation, gated by the same replacement session;
6. require both the claim and replacement insert results to report exactly one changed row; zero
   means `HANDOFF_INVALID`. Any thrown batch statement rolls back **all four** statements, so the
   same handoff remains retryable after a transient failure. The unique
   `sessions.rotated_from_session_id` remains the concurrent login/logout guard;
7. return `TelegramSessionIssuedSchema` with the already-fetched player and newly generated token.

Every SQL statement after the claim must include its gate; no call site may execute
`claimHandoffForSession` outside this batch. The rollback test from Step 1 is the executable proof
that there is no commit point between handoff consumption and guest rotation.

Import `resolveAuthReturnTarget` into `apps/api/src/services/oidc-service.ts` and add this line in `startOidcFlow` immediately after the guest/channel check and before generating or persisting state:

```ts
resolveAuthReturnTarget(env, channel); // fail before redirect if fixed server config is unsafe
```

Then append the callback/exchange orchestration:

```ts
import type { TelegramOidcProvider } from "../auth/telegram-oidc";
import { OidcProviderError } from "../auth/telegram-oidc";
import { resolveAuthReturnTarget, type OidcChannel } from "../auth/return-target";
import { claimAuthFlow, completeAuthFlow } from "../db/auth-flows";
import { upsertOidcPlayer } from "../db/players";
import { exchangeHandoffAndLinkGuest } from "./account-link-service";

export function fixedReturnUrl(env: Env, channel: OidcChannel, query: Record<string, string>) {
  const url = resolveAuthReturnTarget(env, channel);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export async function completeOidcCallback(input: {
  env: Env;
  provider: TelegramOidcProvider;
  state: string;
  code: string;
  now: number;
}): Promise<string> {
  const stateHash = await hashOpaqueToken(input.state, input.env.SESSION_PEPPER, "oidc-state");
  const flow = await claimAuthFlow(input.env.DB, stateHash, input.now);
  if (!flow) throw new ApiError(400, "OIDC_STATE_INVALID", "OIDC state is invalid or expired.");
  try {
    const identity = await input.provider.exchangeAndVerify({
      code: input.code,
      verifier: flow.pkce_verifier,
      expectedNonce: flow.nonce,
      clientId: input.env.TELEGRAM_OIDC_CLIENT_ID,
      clientSecret: input.env.TELEGRAM_OIDC_CLIENT_SECRET,
      redirectUri: input.env.TELEGRAM_OIDC_CALLBACK_URL,
    });
    if (!identity.oidc) throw new ApiError(401, "OIDC_TOKEN_INVALID", "OIDC token is invalid.");
    const player = await upsertOidcPlayer(input.env.DB, { ...identity, oidc: identity.oidc }, input.now);
    const handoffCode = newOpaqueToken();
    await completeAuthFlow(input.env.DB, {
      flowId: flow.id,
      playerId: player.id,
      handoffHash: await hashOpaqueToken(handoffCode, input.env.SESSION_PEPPER, "oidc-handoff"),
      handoffExpiresAt: input.now + Number(input.env.HANDOFF_TTL_SECONDS),
    });
    return fixedReturnUrl(input.env, flow.channel, { handoff: handoffCode });
  } catch (error) {
    if (error instanceof OidcProviderError) {
      throw new ApiError(
        error.code === "OIDC_PROVIDER_ERROR" ? 503 : 401,
        error.code,
        "Telegram login could not be verified.",
      );
    }
    throw error;
  }
}

export async function exchangeOidcHandoff(
  env: Env,
  guest: SessionActor,
  handoffCode: string,
  now: number,
) {
  if (guest.kind !== "guest" || guest.channel === "telegram") {
    throw new ApiError(409, "AUTH_REQUIRES_GUEST", "Exchange requires the original guest session.");
  }
  return exchangeHandoffAndLinkGuest(env, guest, {
    handoffHash: await hashOpaqueToken(handoffCode, env.SESSION_PEPPER, "oidc-handoff"),
    channel: guest.channel,
  }, now);
}
```

- [ ] **Step 7: Split callback/start and session mutation routers**

Extend `apps/api/src/routes/oidc-auth.ts` with a Telegram-prefix-only factory:

```ts
import { z } from "zod";
import type { TelegramOidcProvider } from "../auth/telegram-oidc";
import { hashOpaqueToken } from "../crypto/opaque-token";
import { claimAuthFlow } from "../db/auth-flows";
import { fixedReturnUrl, completeOidcCallback } from "../services/oidc-service";

const CallbackQuerySchema = z.union([
  z.object({ state: z.string().min(1), code: z.string().min(1) }).strict(),
  z.object({ state: z.string().min(1), error: z.string().min(1), error_description: z.string().optional() }).strict(),
]);

export function createTelegramOidcRoutes(provider: TelegramOidcProvider) {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>();
  router.route("/", oidcStartRoutes);

  router.get("/callback", async (c) => {
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    const parsed = CallbackQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new ApiError(400, "OIDC_CALLBACK_INVALID", "Invalid OIDC callback.");
    if ("error" in parsed.data) {
      const stateHash = await hashOpaqueToken(parsed.data.state, c.env.SESSION_PEPPER, "oidc-state");
      const flow = await claimAuthFlow(c.env.DB, stateHash, Math.floor(Date.now() / 1000));
      if (!flow) throw new ApiError(400, "OIDC_STATE_INVALID", "OIDC state is invalid or expired.");
      return c.redirect(fixedReturnUrl(c.env, flow.channel, { authError: "access_denied" }), 302);
    }
    const location = await completeOidcCallback({
      env: c.env,
      provider,
      state: parsed.data.state,
      code: parsed.data.code,
      now: Math.floor(Date.now() / 1000),
    });
    return c.redirect(location, 302);
  });
  return router;
}
```

Create `apps/api/src/routes/session-auth.ts` for routes that live directly below `/v1/auth`:

```ts
import { HandoffExchangeRequestSchema } from "@a-move-ago/api-contract";
import { Hono } from "hono";
import type { Env, Variables } from "../env";
import { ApiError } from "../http/api-error";
import { requireSession } from "../middleware/session";
import { exchangeOidcHandoff } from "../services/oidc-service";
import { logoutToGuest } from "../services/session-service";

export const sessionAuthRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

sessionAuthRoutes.post("/logout", requireSession, async (c) => {
  const result = await logoutToGuest(c.env, c.get("session"), Math.floor(Date.now() / 1000));
  c.header("cache-control", "no-store");
  return c.json(result);
});

sessionAuthRoutes.post("/session/exchange", requireSession, async (c) => {
  const parsed = HandoffExchangeRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", "Invalid request body.");
  const result = await exchangeOidcHandoff(
    c.env,
    c.get("session"),
    parsed.data.handoffCode,
    Math.floor(Date.now() / 1000),
  );
  c.header("cache-control", "no-store");
  return c.json(result);
});
```

Move the existing logout handler out of `apps/api/src/routes/sessions.ts`; that router now owns only `/guest`. Use one mount per router in `apps/api/src/app.ts`:

```ts
app.route(
  "/v1/auth/telegram/oidc",
  createTelegramOidcRoutes(dependencies.oidcProvider),
);
app.route("/v1/auth", sessionAuthRoutes);
```

Preserve all middleware and gameplay mounts already present in `app.ts`. Exact ownership is:

```text
createTelegramOidcRoutes: POST /v1/auth/telegram/oidc/start
createTelegramOidcRoutes: GET  /v1/auth/telegram/oidc/callback
sessionAuthRoutes:        POST /v1/auth/session/exchange
sessionAuthRoutes:        POST /v1/auth/logout
```

Never mount either router a second time. The three negative `404` assertions from Step 1 prevent `/v1/auth/start`, `/v1/auth/callback`, and `/v1/auth/telegram/oidc/session/exchange` from appearing.

- [ ] **Step 8: Run callback/handoff tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/oidc-callback.test.ts`

Expected: fixed redirect, state claim, guest binding, expiry, replay, denial, provider failure, Android channel and identity conflict cases PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/auth/return-target.ts apps/api/src/db/auth-flows.ts apps/api/src/db/players.ts
git add apps/api/src/services/oidc-service.ts apps/api/src/routes/oidc-auth.ts
git add apps/api/src/routes/session-auth.ts apps/api/src/routes/sessions.ts apps/api/src/app.ts
git add apps/api/test/auth-return-target.test.ts apps/api/test/oidc-callback.test.ts
git commit -m "feat: exchange one-time Telegram handoffs"
```

### Task 7: Harden `/me`, logout, origin checks, auth rate limits and logs

**Files:**
- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/services/session-service.ts`
- Create: `apps/api/src/middleware/origin.ts`
- Modify: `apps/api/src/middleware/structured-log.ts`
- Modify: `apps/api/src/routes/mini-app-auth.ts`
- Modify: `apps/api/src/routes/oidc-auth.ts`
- Modify: `apps/api/src/routes/session-auth.ts`
- Modify: `apps/api/src/scheduled.ts`
- Test: `apps/api/test/auth-security.test.ts`

- [ ] **Step 1: Write failing security/profile/logout tests**

`apps/api/test/auth-security.test.ts` must execute these exact assertions:

```ts
const me = await authenticatedJson("/v1/me", telegramToken);
expect(me.body).toEqual({ kind: "telegram", profile: expectedProfile });
expect(me.response.headers.get("cache-control")).toBe("no-store");

const logout = await authenticatedJson("/v1/auth/logout", telegramToken, { method: "POST" });
expect(logout.body).toMatchObject({ kind: "guest" });
expect((await authenticatedJson("/v1/me", telegramToken)).response.status).toBe(401);

const deniedOrigin = await authenticatedJson("/v1/auth/telegram/oidc/start", webGuestToken, {
  method: "POST",
  headers: { origin: "https://agent-axiom.github.io.evil.test" },
  body: { channel: "web" },
});
expect(deniedOrigin.response.status).toBe(403);
expect(deniedOrigin.body.error.code).toBe("ORIGIN_NOT_ALLOWED");

const logs: string[] = [];
vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
await authenticatedJson("/v1/auth/telegram/mini-app", telegramGuestToken, {
  method: "POST",
  body: { initData: rawInitData },
});
expect(logs.join("\n")).not.toContain(rawInitData);
expect(logs.join("\n")).not.toContain(telegramGuestToken);
expect(logs.join("\n")).not.toContain("handoff=");
```

The same file invokes the auth limiter with a fake `{ success: false }` result and expects `429 RATE_LIMITED`, then inserts an expired `auth_flows` row, calls `cleanupExpired`, and expects the row to be deleted.

- [ ] **Step 2: Run security tests RED**

Run: `npm test -w @a-move-ago/api -- test/auth-security.test.ts`

Expected: authenticated `/me`, origin rejection, rotation guard or auth cleanup assertions FAIL.

- [ ] **Step 3: Return a verified player from `/me`**

Update `apps/api/src/routes/me.ts` handler:

```ts
me.get("/", requireSession, async (c) => {
  const session = c.get("session");
  c.header("cache-control", "no-store");
  if (!session.playerId) return c.json(MeResponseSchema.parse({ kind: "guest", profile: null }));
  const player = await findPlayer(c.env.DB, session.playerId);
  if (!player) throw new ApiError(401, "INVALID_SESSION", "Session player does not exist.");
  return c.json(MeResponseSchema.parse({ kind: "telegram", profile: toTelegramProfile(player) }));
});
```

- [ ] **Step 4: Make logout share the rotation concurrency guard**

In `apps/api/src/services/session-service.ts`, the replacement-session insert inside `logoutToGuest` must include `rotated_from_session_id`:

```sql
INSERT INTO sessions
  (id, player_id, token_hash, kind, channel, rotated_from_session_id,
   created_at, expires_at, revoked_at, last_seen_at)
VALUES (?, NULL, ?, 'guest', ?, ?, ?, ?, NULL, ?)
```

Bind the previous `actor.sessionId` to `rotated_from_session_id`. Keep the new guest unlinked: logout never copies or deletes player attempts.
On batch failure, use the same `SELECT id FROM sessions WHERE rotated_from_session_id = ?` classification as `linkGuestToPlayer`: return `401 INVALID_SESSION` only when another replacement won; rethrow unrelated D1 failures for the normal `500` envelope.

- [ ] **Step 5: Enforce exact Origin on browser auth mutations**

`apps/api/src/middleware/origin.ts`:

```ts
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../env";
import { ApiError } from "../http/api-error";

export const requireAllowedMutationOrigin = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const origin = c.req.header("origin");
  if (origin) {
    const allowed = new Set(c.env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()));
    if (!allowed.has(origin)) {
      throw new ApiError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed.");
    }
  }
  await next();
});
```

Apply it after `requireSession` to Mini App login, OIDC start, handoff exchange and logout. Do not apply it to Telegram's top-level callback. A missing Origin is accepted for native/system-browser clients because authorization is the Bearer plus one-time proof, not a cookie.

- [ ] **Step 6: Keep structured logs free of auth material**

Update `apps/api/src/middleware/structured-log.ts` to log only:

```ts
console.log(JSON.stringify({
  requestId: c.get("requestId"),
  method: c.req.method,
  path: c.req.path,
  status: c.res.status,
  sessionKind: c.get("session")?.kind ?? "none",
}));
```

Do not log `c.req.url`, headers, query values, JSON bodies, provider errors or thrown error messages.
Keep `observability.logs.invocation_logs` set to `false`: Cloudflare enriches automatic invocation logs with the full request URL. Safe custom structured logs remain available, but re-enabling invocation logs would violate the no-code/state/handoff logging invariant.

- [ ] **Step 7: Delete expired auth transactions**

Add this statement to `cleanupExpired` in `apps/api/src/scheduled.ts`:

```ts
env.DB.prepare(
  `DELETE FROM auth_flows
    WHERE expires_at < ?
       OR (handoff_expires_at IS NOT NULL AND handoff_expires_at < ?)`,
).bind(now - 86_400, now - 86_400),
```

The one-day grace period retains enough metadata to diagnose aggregate failure rates without retaining raw Telegram proof, code or token values, which are never stored.

- [ ] **Step 8: Run security tests GREEN**

Run: `npm test -w @a-move-ago/api -- test/auth-security.test.ts`

Expected: Telegram `/me`, logout, exact Origin, limiter failure, safe logging and auth-flow cleanup PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/services/session-service.ts
git add apps/api/src/middleware/origin.ts apps/api/src/middleware/structured-log.ts
git add apps/api/src/routes/mini-app-auth.ts apps/api/src/routes/oidc-auth.ts
git add apps/api/src/routes/session-auth.ts apps/api/src/scheduled.ts
git add apps/api/test/auth-security.test.ts
git commit -m "feat: harden Telegram session lifecycle"
```

### Task 8: Verify complete Mini App and OIDC journeys

**Files:**
- Test: `apps/api/test/telegram-auth.integration.test.ts`
- Modify: `apps/api/test/fixtures/telegram.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing cross-channel integration test**

`apps/api/test/telegram-auth.integration.test.ts` contains two complete scenarios.

Mini App scenario:

```text
telegram guest → correct attempt → signed initData → Telegram session
→ old guest rejected → `/me` returns profile → `/me/stats` includes guest attempt
```

OIDC scenario:

```text
web guest → correct attempt → OIDC start → callback with fake verified identity
→ handoff theft rejected → original guest exchange succeeds → handoff replay rejected
→ `/me/stats` includes guest attempt → logout returns isolated guest
```

The concrete merge assertions are:

```ts
expect((await authenticatedJson("/v1/me/stats", miniAppSession.token)).body.solvedPuzzles).toBe(1);
expect((await authenticatedJson("/v1/me/stats", oidcSession.token)).body.solvedPuzzles).toBe(2);
const players = await env.DB.prepare(
  "SELECT id, telegram_user_id, oidc_subject FROM players WHERE telegram_user_id = ?",
).bind("987654321").all();
expect(players.results).toHaveLength(1);
expect(players.results[0]).toMatchObject({ oidc_subject: "telegram-subject-987654321" });
```

Use the same Telegram numeric ID for Mini App and OIDC to prove both mechanisms converge on one player while retaining both guest histories.

- [ ] **Step 2: Run integration test RED**

Run: `npm test -w @a-move-ago/api -- test/telegram-auth.integration.test.ts`

Expected: at least one merge, replay, logout isolation or app dependency assertion FAILS.

- [ ] **Step 3: Complete the app factory without duplicating route mounts**

Make `apps/api/src/app.ts` end with this shape after all middleware and gameplay routes have been mounted inside the factory:

```ts
export type AppDependencies = {
  oidcProvider: TelegramOidcProvider;
};

export function createApp(
  dependencies: AppDependencies = { oidcProvider: telegramOidcProvider },
) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use("*", requestId);
  app.use("*", exactCors);
  app.use("*", structuredLog);
  app.route("/v1/sessions", sessions);
  app.route("/v1/auth/telegram/mini-app", miniAppAuth);
  app.route("/v1/auth/telegram/oidc", createTelegramOidcRoutes(dependencies.oidcProvider));
  app.route("/v1/auth", sessionAuthRoutes);
  app.route("/v1/me", me);
  app.route("/v1/daily", daily);
  app.route("/v1/attempts", attempts);
  app.get("/v1/healthz", (c) => c.json({ ok: true }));
  app.notFound(() => {
    throw new ApiError(404, "NOT_FOUND", "Resource not found.");
  });
  app.onError(errorResponse);
  return app;
}

export const app = createApp();
```

`createTelegramOidcRoutes()` owns only `/start` and `/callback`; `sessionAuthRoutes` owns only `/session/exchange` and `/logout`. The integration test must keep the three negative `404` route assertions from Task 6 so neither router can accidentally leak endpoints under the other prefix.

- [ ] **Step 4: Run the complete auth and regression gates**

Run: `npm test -w @a-move-ago/api -- test/telegram-auth.integration.test.ts`

Expected: both full journeys PASS and only one player row exists.

Run: `npm test -w @a-move-ago/api`

Expected: all gameplay, session, Mini App, OIDC, security and integration tests PASS.

Run: `npm test -w @a-move-ago/api-contract`

Expected: all strict contract tests PASS.

Run: `npm run typecheck -w @a-move-ago/api`

Expected: exit `0` with Workers, Hono and jose types.

Run: `npm run check`

Expected: exit `0`; Biome reports no formatting or lint errors.

Run: `npm run build -w @a-move-ago/api`

Expected: Wrangler creates a dry-run bundle and performs no deployment.

Deployment handoff to plan 05 (not a plan 03 local gate): validate exact GitHub-environment inputs for `SESSION_PEPPER`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_OIDC_CLIENT_SECRET`, write only those values to an ephemeral mode-`0600` JSON file, and pass it to both the pre-migration dry-run and final deploy with `wrangler deploy --secrets-file`. This supports first-Worker bootstrap; `secrets.required` remains the source of truth for type generation and Wrangler's deploy guard. Destroy the ephemeral file in an unconditional cleanup step and never print its contents.

The same plan 05 preflight must parse the rendered `apps/api/wrangler.production.jsonc`, require `ENVIRONMENT === "production"`, validate `API_ORIGIN` as a bare HTTPS origin, require `TELEGRAM_OIDC_CALLBACK_URL === ${API_ORIGIN}/v1/auth/telegram/oidc/callback`, require `ANDROID_AUTH_RETURN_URL === ${API_ORIGIN}/auth/android`, require `WEB_AUTH_RETURN_URL` to be a credential/query/fragment-free HTTPS URL whose origin is in `ALLOWED_ORIGINS`, and reject every `.invalid` callback/origin value. Local/test runs instead require exact `amoveago-debug://auth`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/telegram-auth.integration.test.ts apps/api/test/fixtures/telegram.ts apps/api/src/app.ts
git commit -m "test: cover complete Telegram auth journeys"
```

## Milestone exit

- Mini App login accepts only fresh, constant-time-verified raw `initData` after explicit user action.
- Web/Android login uses Telegram Authorization Code flow, server-held PKCE verifier, checked state/nonce, pinned RS256 JWKS verification and fixed callback/return URLs.
- Handoff is hashed, expires after 60 seconds, is bound to the original guest session/channel and is single-use.
- Both login mechanisms converge on one Telegram player and transfer confirmed guest attempts without deleting them.
- Old guest tokens are revoked; Telegram logout returns a new unlinked guest without deleting account progress.
- Application logs never contain initData, OIDC code/token/state/handoff, Authorization header or full query string; Cloudflare URL-bearing invocation logs are explicitly disabled while safe custom structured logs remain enabled.
- No phone or `telegram:bot_access` scope is requested, and no Telegram access token is persisted.

## Production risks that remain explicit

1. Telegram's current discovery document does not advertise `nonce` or the profile `id` claim even though Telegram Login/OIDC documentation describes them. Before production, run a real BotFather staging login and require both claims fail-closed; do not relax verification to make an incompatible token pass.
2. BotFather must register the exact Worker callback and Pages origin. The `.invalid` Worker URLs in repository config are safe scaffold defaults and must be replaced by deployment configuration before enabling login. Production must also keep `ANDROID_AUTH_RETURN_URL` equal to `${API_ORIGIN}/auth/android` and publish matching Android App Link verification in plan 05; debug alone may use `amoveago-debug://auth`.
3. BotFather can change ID-token signing algorithms. This implementation intentionally pins the default `RS256`; changing BotFather configuration requires an explicit reviewed code/config change.
4. Handoff appears briefly in the return query string. Its guest binding, 60-second TTL, `no-store`, `no-referrer` and one-time consumption reduce interception risk; plan 4 must remove it from browser history immediately after exchange.
5. D1 automatically encrypts the short-lived PKCE verifier at rest, but the verifier is not application-level encrypted. If the threat model later requires protection from a D1 data-plane credential compromise, introduce a separate encryption secret rather than reusing `SESSION_PEPPER`.
6. Workers Rate Limiting is permissive, eventually consistent and per-colo. It limits abuse but is not an accounting or replay-control mechanism; D1 state/unique constraints remain authoritative.
7. Profile deletion UI is outside MVP. Preserve `attempts.player_id REFERENCES players(id) ON DELETE CASCADE` so a later profile deletion removes account attempts; do not change the separate nullable `attempts.session_id REFERENCES sessions(id) ON DELETE SET NULL`, which lets linked history survive originating-session cleanup. Player-owned sessions and outstanding auth flows may continue to cascade from `players` as defined by the schema.

## Primary implementation references

- [Telegram Mini App data validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
- [Telegram Login and OpenID Connect](https://core.telegram.org/bots/telegram-login)
- [Telegram OIDC discovery](https://oauth.telegram.org/.well-known/openid-configuration)
- [Telegram JWKS](https://oauth.telegram.org/.well-known/jwks.json)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0-final.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/info/rfc7636/)
- [jose Web-interoperable runtimes](https://github.com/panva/jose)
- [Cloudflare Web Crypto timingSafeEqual](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal)
- [Cloudflare D1 transactional batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Cloudflare Wrangler required secrets](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Cloudflare Workers invocation logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs)
