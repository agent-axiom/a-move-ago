# Telegram Profile Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать владельцу активной Telegram-сессии двухшаговое, атомарное и безопасно повторяемое удаление профиля A MOVE AGO с продолжением игры как guest под тем же opaque token.

**Architecture:** Общий contract добавляет guest-only ответ и typed `DELETE /v1/me`; Worker выполняет guarded D1 batch, который сначала отвязывает текущую сессию, затем каскадно удаляет player graph и классифицирует неоднозначный outcome повторным чтением. React provider владеет единственным запросом и переходом Telegram → guest, а отдельный доступный компонент — confirmation, pending/error/success UI; реальные D1 и production-like Playwright тесты закрывают concurrency, lost acknowledgement и повторный Telegram login.

**Tech Stack:** TypeScript 7.0, Zod 4.4, Hono 4.12, Cloudflare Workers/D1/Rate Limiting, React 19, Vitest 4, Testing Library, Playwright 1.62, Biome 2.5.

---

Этот feature затрагивает contract, Worker и три client surface, но остаётся одним планом: ни один слой отдельно не снимает privacy release blocker, а единый guest-only response является общей границей всех слоёв. Migration, новый secret, новый binding и изменение Android native project не требуются.

## Карта файлов

### Создать

- `apps/api/src/services/profile-deletion-service.ts` — единственный владелец D1 batch, constraint guard, guest no-op и outcome classifier.
- `apps/api/test/helpers/profile-deletion.ts` — детерминированный player/session/attempt/hint/auth-flow graph для service и integration tests.
- `apps/api/test/profile-deletion.test.ts` — contract route, cascade, rollback, origin, limiter, CORS, response/log privacy и direct-service races.
- `apps/api/test/profile-deletion.integration.test.ts` — concurrent requests, lost acknowledgement и late OIDC/Mini App interleavings.
- `apps/client/src/features/session/ProfileDeletion.tsx` — inline disclosure и локальный accessible deletion lifecycle.
- `apps/client/src/features/session/ProfileDeletion.test.tsx` — visibility, keyboard/focus, single-flight, errors, retry и unmount semantics.
- `apps/client/src/styles/profile-deletion.css` — изолированные destructive-control styles.
- `apps/client/e2e/profile-deletion.spec.ts` — собранный Pages artifact: happy path и response-lost retry.

### Изменить

- `packages/api-contract/src/api.ts` — exported `GuestMeResponseSchema`/type и его reuse в `MeResponseSchema`.
- `packages/api-contract/src/contracts.test.ts` — strict guest-only schema assertions.
- `packages/api-contract/src/client.ts` — разрешённый `DELETE` и `deleteProfile(signal?)` без request body.
- `packages/api-contract/src/client.test.ts` — exact wire request, guest-only success и failure semantics.
- `apps/api/src/routes/me.ts` — `DELETE /` с session → exact origin → limiter → service chain.
- `apps/api/src/middleware/cors.ts` — exact allow-methods `GET,POST,DELETE,OPTIONS`.
- `apps/api/test/boundary.test.ts` — exact allowed/denied preflight assertions.
- `apps/client/src/features/session/session-service.ts` — deletion wrapper без token rotation и automatic retry.
- `apps/client/src/features/session/session-service.test.ts` — неизменность runtime token/token store при success и failure.
- `apps/client/src/features/session/SessionProvider.tsx` — provider action, shared action slot и reset Telegram-auth lifecycle после deletion.
- `apps/client/src/features/session/SessionProvider.test.tsx` — success/failure/abort/single-flight/new-handoff regression.
- `apps/client/src/test/runtime-fixture.ts` — typed mock `deleteProfile`.
- `apps/client/src/App.tsx` — постоянная composition deletion component на Progress screen.
- `apps/client/src/App.test.tsx` — identity-key daily/stat refresh и surviving success state.
- `apps/client/src/styles/base.css` — импорт isolated deletion stylesheet.
- `apps/client/e2e/api-mock.ts` — stateful Telegram → guest DELETE и lost-response observation.
- `apps/client/test/artifact-profile-verifier.ts` — запрет static credentials/profile fixtures в public bundles.
- `apps/client/test/artifact-profile-verifier.test.ts` — positive и negative artifact fixtures.
- `apps/client/test/verify-builds.mjs` — вызов sensitive-marker gate для обоих build profiles.
- `README.md` — пользовательский deletion flow и production smoke gate.
- `PRIVACY.md` — фактический scope удаления, retained pseudonymous fields, races, logs и backups.

### Осознанно не изменять

- `apps/api/migrations/*` — все нужные `ON DELETE CASCADE` уже существуют; scan `auth_flows.player_id` допустим для MVP.
- `apps/api/src/env.ts`, `apps/api/wrangler.jsonc` — endpoint использует существующий `AUTH_RATE_LIMITER`.
- `apps/client/src/features/session/session-state.ts` — pending/error удаления локальны, глобальный state остаётся `ready/telegram` до подтверждённого guest response.
- `apps/client/src/features/session/SaveProgressButton.tsx` и `apps/client/src/features/stats/StatsPanel.tsx` — их текущие interfaces уже достаточны.
- `.github/workflows/ci.yml` — существующий pipeline автоматически подхватит новые Vitest/Playwright/artifact tests.

## Зафиксированные инварианты

| Событие | Provider state | Component state | Token |
| --- | --- | --- | --- |
| Disclosure открыт | `ready/telegram` | `confirming` | тот же |
| DELETE pending | `ready/telegram` | `pending` | тот же |
| Guest-only `200` | `ready/guest` | focused `success` | тот же |
| API/contract/transport error | `ready/telegram` | retryable `error` | тот же |
| Profile component unmount | provider action продолжается | local update подавлен | тот же |
| Provider/runtime replacement | action abort; late result ignored | child unmounted | lifecycle заменён |
| Поздний новый sign-in | guest → Telegram | прежний success трактуется как closed | обычные auth rules |

### Task 1: Зафиксировать guest-only contract и typed DELETE client

**Files:**

- Modify: `packages/api-contract/src/api.ts:79`
- Modify: `packages/api-contract/src/contracts.test.ts:1`
- Modify: `packages/api-contract/src/client.ts:3,61,119`
- Modify: `packages/api-contract/src/client.test.ts:1`

- [ ] **Step 1: Написать failing schema test**

Добавить `GuestMeResponseSchema` в import из `./index` и append в `packages/api-contract/src/contracts.test.ts`:

```ts
it("keeps profile deletion success guest-only and strict", () => {
  const guest = { kind: "guest", profile: null } as const;
  const telegram = {
    kind: "telegram",
    profile: {
      telegramUserId: "42",
      displayName: "Ada",
      username: null,
      avatarUrl: null,
    },
  } as const;

  expect(GuestMeResponseSchema.parse(guest)).toEqual(guest);
  expect(GuestMeResponseSchema.safeParse(telegram).success).toBe(false);
  expect(GuestMeResponseSchema.safeParse({ ...guest, deletedRows: 7 }).success).toBe(false);
});
```

- [ ] **Step 2: Запустить schema test и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/api-contract -- src/contracts.test.ts
```

Expected: FAIL на отсутствующем export `GuestMeResponseSchema`.

- [ ] **Step 3: Вынести guest schema и type**

Заменить inline guest branch в `packages/api-contract/src/api.ts`:

```ts
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
```

- [ ] **Step 4: Написать failing transport tests**

Append в `packages/api-contract/src/client.test.ts`:

```ts
it("deletes the current profile with an authenticated bodyless DELETE", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({ kind: "guest", profile: null }, { status: 200 }),
  );
  const signal = new AbortController().signal;
  const api = createApiClient({
    baseUrl: "https://api.test/",
    fetch,
    getToken: () => "x".repeat(43),
  });

  await expect(api.deleteProfile(signal)).resolves.toEqual({ kind: "guest", profile: null });
  expect(fetch).toHaveBeenCalledWith("https://api.test/v1/me", {
    method: "DELETE",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${"x".repeat(43)}`,
    },
    signal,
  });
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has("content-type")).toBe(false);
});

it("rejects a Telegram-shaped profile deletion success", async () => {
  const api = createApiClient({
    baseUrl: "https://api.test",
    fetch: vi.fn().mockResolvedValue(
      Response.json({ kind: "telegram", profile: profileFixture }),
    ),
    getToken: () => "x".repeat(43),
  });

  await expect(api.deleteProfile()).rejects.toBeInstanceOf(ApiContractError);
});

it.each([
  { kind: "guest" },
  { kind: "guest", profile: null, deletedRows: 1 },
])("rejects malformed deletion response %#", async (payload) => {
  const api = createApiClient({
    baseUrl: "https://api.test",
    fetch: vi.fn().mockResolvedValue(Response.json(payload)),
    getToken: () => "x".repeat(43),
  });

  await expect(api.deleteProfile()).rejects.toBeInstanceOf(ApiContractError);
});

it("preserves deletion error-envelope, transport, and AbortError semantics", async () => {
  const apiErrorClient = createApiClient({
    baseUrl: "https://api.test",
    fetch: vi.fn().mockResolvedValue(
      Response.json(
        { error: { code: "INVALID_SESSION", message: "Expired.", requestId: "req-delete" } },
        { status: 401 },
      ),
    ),
    getToken: () => "x".repeat(43),
  });
  await expect(apiErrorClient.deleteProfile()).rejects.toEqual(
    new ApiError(401, "INVALID_SESSION", "Expired.", "req-delete", null),
  );

  const networkFailure = new TypeError("response lost");
  const transportClient = createApiClient({
    baseUrl: "https://api.test",
    fetch: vi.fn().mockRejectedValue(networkFailure),
    getToken: () => "x".repeat(43),
  });
  const transportError = await transportClient.deleteProfile().catch((error: unknown) => error);
  expect(transportError).toBeInstanceOf(ApiTransportError);
  expect((transportError as ApiTransportError).cause).toBe(networkFailure);

  const abortError = new DOMException("aborted", "AbortError");
  const abortClient = createApiClient({
    baseUrl: "https://api.test",
    fetch: vi.fn().mockRejectedValue(abortError),
    getToken: () => "x".repeat(43),
  });
  await expect(abortClient.deleteProfile()).rejects.toBe(abortError);
});
```

- [ ] **Step 5: Запустить client tests и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/api-contract -- src/client.test.ts
```

Expected: TypeScript/Vitest FAIL, потому что `ApiClient.deleteProfile` отсутствует.

- [ ] **Step 6: Реализовать минимальный typed DELETE**

Добавить `GuestMeResponseSchema` в import `packages/api-contract/src/client.ts`, расширить request method и вставить метод после `getMe`:

```ts
async function request<TSchema extends z.ZodType>(input: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  responseSchema: TSchema;
  body?: unknown;
  authenticated?: boolean;
  signal?: AbortSignal | undefined;
}): Promise<z.infer<TSchema>> {
```

```ts
deleteProfile(signal?: AbortSignal) {
  return request({
    method: "DELETE",
    path: "/v1/me",
    responseSchema: GuestMeResponseSchema,
    signal,
  });
},
```

Не добавлять body, retry или token mutation.

- [ ] **Step 7: Подтвердить GREEN и types**

Run:

```bash
npm test -w @a-move-ago/api-contract -- src/contracts.test.ts src/client.test.ts
npm run typecheck -w @a-move-ago/api-contract
```

Expected: обе suites PASS; typecheck exit `0`.

- [ ] **Step 8: Закоммитить contract boundary**

```bash
git add packages/api-contract/src/api.ts packages/api-contract/src/contracts.test.ts packages/api-contract/src/client.ts packages/api-contract/src/client.test.ts
git commit -m "feat(api-contract): add profile deletion contract"
```

### Task 2: Реализовать атомарный D1 deletion service

**Files:**

- Create: `apps/api/src/services/profile-deletion-service.ts`
- Create: `apps/api/test/helpers/profile-deletion.ts`
- Create: `apps/api/test/profile-deletion.test.ts`

- [ ] **Step 1: Создать точный reusable deletion graph fixture**

Создать `apps/api/test/helpers/profile-deletion.ts` с exported `seedProfileDeletionGraph()` и import `SessionActor` из `../../src/env`. Он должен вызвать `issueGuest("telegram")` ровно пять раз для ancestor, predecessor, current, other и independent guest, вызвать один `seedContentFixture(testEnv.DB)` и создать следующие строки с фиксированным `now = 1_785_715_200`:

```ts
export const deletionNow = 1_785_715_200;

export interface ProfileDeletionGraph {
  playerId: string;
  telegramUserId: string;
  current: { token: string; sessionId: string; tokenHash: string };
  other: { token: string; sessionId: string };
  ancestorId: string;
  predecessorId: string;
  independentGuest: { token: string; sessionId: string };
  linkedAttemptIds: string[];
  unrelatedPlayerId: string;
  unrelatedAttemptId: string;
  unrelatedFlowId: string;
  linkedFlowId: string;
  unlinkedFlowId: string;
}

export function telegramDeletionActor(graph: ProfileDeletionGraph): SessionActor {
  return {
    sessionId: graph.current.sessionId,
    playerId: graph.playerId,
    kind: "telegram",
    channel: "telegram",
  };
}
```

Создание graph выполняется в этом порядке, чтобы все существующие CHECK/FK/attempt trigger оставались активны:

```sql
INSERT INTO players
  (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
   display_name, username, avatar_url, created_at, updated_at)
VALUES (?, '987654321', 'https://oauth.telegram.org',
        'telegram-subject-987654321', 'client-id',
        'Deletion Marker Ada', 'delete_marker', 'https://example.com/delete-marker.png', ?, ?)
```

```sql
UPDATE sessions
   SET kind = 'telegram', player_id = ?, rotated_from_session_id = ?
 WHERE id = ?
```

Predecessor оставить guest, установить `rotated_from_session_id = ancestorId` и `revoked_at = deletionNow - 10`. Текущую session связать с `predecessorId`; вторую Telegram session связать с тем же player без rotation. До установки `player_id` у transferred attempt вставить его под predecessor как guest, затем выполнить:

```sql
UPDATE attempts SET player_id = ? WHERE id = ?
```

Остальные exact fixture rows:

```ts
const linkedAttemptIds = ["delete-attempt-current", "delete-attempt-transferred"];
const unrelatedAttemptId = "keep-attempt";
const unrelatedFlowId = "keep-unrelated-linked-flow";
const linkedFlowId = "delete-linked-flow";
const unlinkedFlowId = "keep-unlinked-flow";
```

Каждый linked attempt использует seeded `caseId`/`puzzle.rowId`, `correct = 0`, валидные JSON columns и уникальный UUID; для `delete-attempt-current` вставить `hint_events(attempt_id, hint_level = 1, hint_json, created_at)`. Linked flow обязан иметь ненулевые `player_id`, `handoff_hash`, `handoff_expires_at`; unlinked flow использует independent guest и оставляет эти три поля `NULL`. Создать отдельный unrelated player, Telegram session, `unrelatedAttemptId`, его hint и `unrelatedFlowId`. После `seedContentFixture` вставить `content_imports(digest, case_id, source_name, imported_at, published_at)` с digest `"f".repeat(64)`, чтобы test доказывал сохранение import history, а не сравнивал два пустых набора. Вернуть token hash текущей session из:

```ts
const currentRow = await testEnv.DB.prepare(
  "SELECT token_hash FROM sessions WHERE id = ?",
)
  .bind(current.sessionId)
  .first<{ token_hash: string }>();
if (!currentRow) throw new Error("Current deletion session is missing.");
```

- [ ] **Step 2: Написать failing service tests**

В `apps/api/test/profile-deletion.test.ts` импортировать `beforeEach/afterEach/describe/expect/it/vi`, `Env`, `deleteProfileForActor`, `cleanupExpired`, `app`, `authenticatedJson`, `issueGuest`, `requestJson`, `resetDatabase`, `testEnv` и fixture exports. Использовать общий exported actor helper:

```ts
import {
  deletionNow,
  seedProfileDeletionGraph,
  telegramDeletionActor,
} from "./helpers/profile-deletion";
```

Добавить основной test:

```ts
it("atomically keeps the current token as guest and deletes only its player graph", async () => {
  const graph = await seedProfileDeletionGraph();
  const currentBefore = await testEnv.DB.prepare(
    `SELECT id, token_hash, channel, created_at, expires_at, revoked_at
       FROM sessions WHERE id = ?`,
  )
    .bind(graph.current.sessionId)
    .first<Record<string, unknown>>();
  const contentBefore = await testEnv.DB.prepare(
    `SELECT
       (SELECT count(*) FROM puzzles) AS puzzles,
       (SELECT count(*) FROM daily_cases) AS cases,
       (SELECT count(*) FROM content_imports) AS imports`,
  ).first<{ puzzles: number; cases: number; imports: number }>();

  await expect(
    deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
  ).resolves.toEqual({ kind: "guest", profile: null });

  const current = await testEnv.DB.prepare(
    `SELECT id, token_hash, kind, channel, player_id, rotated_from_session_id,
            created_at, expires_at, revoked_at, last_seen_at
       FROM sessions WHERE id = ?`,
  )
    .bind(graph.current.sessionId)
    .first<Record<string, unknown>>();
  expect(current).toMatchObject({
    id: graph.current.sessionId,
    token_hash: graph.current.tokenHash,
    kind: "guest",
    channel: "telegram",
    player_id: null,
    rotated_from_session_id: null,
    revoked_at: null,
    last_seen_at: deletionNow,
  });
  expect(current?.created_at).toBe(currentBefore?.created_at);
  expect(current?.expires_at).toBe(currentBefore?.expires_at);
  expect(current?.revoked_at).toBe(currentBefore?.revoked_at);

  for (const [table, predicate] of [
    ["players", "id = ?"],
    ["sessions", "player_id = ?"],
    ["attempts", "player_id = ?"],
    ["auth_flows", "player_id = ?"],
  ] as const) {
    const row = await testEnv.DB.prepare(
      `SELECT count(*) AS count FROM ${table} WHERE ${predicate}`,
    )
      .bind(graph.playerId)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  }
  const linkedHints = await testEnv.DB.prepare(
    `SELECT count(*) AS count FROM hint_events
      WHERE attempt_id IN ('delete-attempt-current', 'delete-attempt-transferred')`,
  ).first<{ count: number }>();
  expect(linkedHints?.count).toBe(0);

  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(graph.unrelatedPlayerId)
      .first(),
  ).not.toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
      .bind(graph.unrelatedAttemptId)
      .first(),
  ).not.toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT attempt_id FROM hint_events WHERE attempt_id = ?")
      .bind(graph.unrelatedAttemptId)
      .first(),
  ).not.toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT id FROM auth_flows WHERE id = ?")
      .bind(graph.unrelatedFlowId)
      .first(),
  ).not.toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT id FROM auth_flows WHERE id = ?")
      .bind(graph.unlinkedFlowId)
      .first(),
  ).not.toBeNull();
  expect(
    await testEnv.DB.prepare(
      "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
    )
      .bind(graph.predecessorId)
      .first(),
  ).toEqual({
    kind: "guest",
    player_id: null,
    rotated_from_session_id: graph.ancestorId,
  });
  expect(
    await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE id = ?")
      .bind(graph.ancestorId)
      .first(),
  ).toEqual({ kind: "guest", player_id: null });
  expect(
    await testEnv.DB.prepare(
      `SELECT
         (SELECT count(*) FROM puzzles) AS puzzles,
         (SELECT count(*) FROM daily_cases) AS cases,
         (SELECT count(*) FROM content_imports) AS imports`,
    ).first(),
  ).toEqual(contentBefore);
});
```

Добавить guest no-op и inactive actor cases:

```ts
it("treats an active guest as a byte-for-byte no-op", async () => {
  const guest = await issueGuest("web");
  const before = await testEnv.DB.prepare("SELECT * FROM sessions WHERE id = ?")
    .bind(guest.sessionId)
    .first();
  await expect(
    deleteProfileForActor(
      testEnv,
      { sessionId: guest.sessionId, playerId: null, kind: "guest", channel: "web" },
      deletionNow,
    ),
  ).resolves.toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT * FROM sessions WHERE id = ?")
      .bind(guest.sessionId)
      .first(),
  ).toEqual(before);
});

it("keeps retained predecessor cleanup eligible after deletion", async () => {
  const graph = await seedProfileDeletionGraph();
  await deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow);
  await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
    .bind(deletionNow - 2_592_001, graph.predecessorId)
    .run();

  await cleanupExpired(testEnv, deletionNow);
  expect(
    await testEnv.DB.prepare("SELECT id FROM sessions WHERE id = ?")
      .bind(graph.predecessorId)
      .first(),
  ).toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT kind FROM sessions WHERE id = ?")
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({ kind: "guest" });
});

it.each(["missing", "revoked", "expired"] as const)(
  "classifies an inter-phase %s session as INVALID_SESSION",
  async (state) => {
    const graph = await seedProfileDeletionGraph();
    if (state === "missing") {
      await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(graph.current.sessionId)
        .run();
    } else if (state === "revoked") {
      await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
        .bind(deletionNow, graph.current.sessionId)
        .run();
    } else {
      await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(deletionNow, graph.current.sessionId)
        .run();
    }

    await expect(
      deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
    ).rejects.toMatchObject({ status: 401, code: "INVALID_SESSION" });
  },
);
```

В `beforeEach` вызывать `resetDatabase()`. В `afterEach` выполнить оба exact cleanup statements:

```ts
await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_profile_delete_player").run();
await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_abort_profile_delete_player").run();
```

- [ ] **Step 3: Запустить service tests и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.test.ts
```

Expected: FAIL на отсутствующих module/export `profile-deletion-service` и fixture helper.

- [ ] **Step 4: Реализовать guest validation и outcome classifier**

Создать `apps/api/src/services/profile-deletion-service.ts` с imports и types:

```ts
import {
  type GuestMeResponse,
  GuestMeResponseSchema,
} from "@a-move-ago/api-contract";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";

type DeletionState = {
  kind: "guest" | "telegram";
  player_id: string | null;
  channel: SessionActor["channel"];
  rotated_from_session_id: string | null;
  revoked_at: number | null;
  expires_at: number;
  player_exists: number;
  linked_sessions_exist: number;
  linked_attempts_exist: number;
  linked_auth_flows_exist: number;
};

const guestResponse = (): GuestMeResponse =>
  GuestMeResponseSchema.parse({ kind: "guest", profile: null });

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The session is no longer active.");
}
```

Добавить exact active guest query; rotation link намеренно не проверяется для guest no-op, потому что logout-created guest chains валидны:

```ts
async function activeGuest(env: Env, actor: SessionActor, now: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM sessions
      WHERE id = ?
        AND kind = 'guest'
        AND player_id IS NULL
        AND channel = ?
        AND revoked_at IS NULL
        AND expires_at > ?`,
  )
    .bind(actor.sessionId, actor.channel, now)
    .first<{ id: string }>();
  return row !== null;
}
```

Добавить classifier, который проверяет старый player UUID, но никогда Telegram ID:

```ts
async function classifyDeletionOutcome(
  env: Env,
  actor: SessionActor & { playerId: string },
  now: number,
  failure: unknown,
): Promise<GuestMeResponse> {
  let state: DeletionState | null;
  try {
    state = await env.DB.prepare(
      `SELECT current.kind,
              current.player_id,
              current.channel,
              current.rotated_from_session_id,
              current.revoked_at,
              current.expires_at,
              EXISTS (SELECT 1 FROM players WHERE id = ?) AS player_exists,
              EXISTS (SELECT 1 FROM sessions WHERE player_id = ?) AS linked_sessions_exist,
              EXISTS (SELECT 1 FROM attempts WHERE player_id = ?) AS linked_attempts_exist,
              EXISTS (SELECT 1 FROM auth_flows WHERE player_id = ?) AS linked_auth_flows_exist
         FROM sessions current
        WHERE current.id = ?`,
    )
      .bind(
        actor.playerId,
        actor.playerId,
        actor.playerId,
        actor.playerId,
        actor.sessionId,
      )
      .first<DeletionState>();
  } catch {
    throw failure;
  }

  if (!state || state.revoked_at !== null || state.expires_at <= now) throw invalidSession();
  if (
    state.kind === "guest" &&
    state.player_id === null &&
    state.channel === actor.channel &&
    state.rotated_from_session_id === null &&
    state.player_exists === 0 &&
    state.linked_sessions_exist === 0 &&
    state.linked_attempts_exist === 0 &&
    state.linked_auth_flows_exist === 0
  ) {
    return guestResponse();
  }
  throw failure;
}
```

- [ ] **Step 5: Реализовать guarded batch**

Append public service. Guard ID и token hash генерируются отдельно, чтобы их UNIQUE constraints не маскировали intended invalid-kind CHECK:

```ts
function expectedBatchResults(results: D1Result[]): boolean {
  if (results.length !== 3) return false;
  const update = results[0]?.meta.changes;
  const deletePlayer = results[1]?.meta.changes;
  const guard = results[2]?.meta.changes;
  return (
    guard === 0 &&
    ((update === 1 && deletePlayer === 1) || (update === 0 && deletePlayer === 0))
  );
}

export async function deleteProfileForActor(
  env: Env,
  actor: SessionActor,
  now: number,
): Promise<GuestMeResponse> {
  if (actor.kind === "guest" && actor.playerId === null) {
    if (!(await activeGuest(env, actor, now))) throw invalidSession();
    return guestResponse();
  }
  if (actor.kind !== "telegram" || actor.playerId === null) throw invalidSession();

  const telegramActor = actor as SessionActor & { playerId: string };
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE sessions
            SET kind = 'guest',
                player_id = NULL,
                rotated_from_session_id = NULL,
                last_seen_at = ?
          WHERE id = ?
            AND kind = ?
            AND player_id IS ?
            AND channel = ?
            AND revoked_at IS NULL
            AND expires_at > ?`,
      ).bind(now, actor.sessionId, actor.kind, actor.playerId, actor.channel, now),
      env.DB.prepare(
        `DELETE FROM players
          WHERE id = ?
            AND changes() = 1
            AND EXISTS (
              SELECT 1 FROM sessions current
               WHERE current.id = ?
                 AND current.kind = 'guest'
                 AND current.player_id IS NULL
                 AND current.channel = ?
                 AND current.rotated_from_session_id IS NULL
                 AND current.revoked_at IS NULL
                 AND current.expires_at > ?
            )`,
      ).bind(actor.playerId, actor.sessionId, actor.channel, now),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, player_id, token_hash, kind, channel, rotated_from_session_id,
           created_at, expires_at, revoked_at, last_seen_at)
         SELECT ?, NULL, ?, 'profile-delete-transaction-guard', ?, NULL,
                ?, ?, NULL, ?
          WHERE NOT (
            EXISTS (
              SELECT 1 FROM sessions current
               WHERE current.id = ?
                 AND current.kind = 'guest'
                 AND current.player_id IS NULL
                 AND current.channel = ?
                 AND current.rotated_from_session_id IS NULL
                 AND current.revoked_at IS NULL
                 AND current.expires_at > ?
            )
            AND NOT EXISTS (SELECT 1 FROM players WHERE id = ?)
            AND NOT EXISTS (SELECT 1 FROM sessions WHERE player_id = ?)
            AND NOT EXISTS (SELECT 1 FROM attempts WHERE player_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_flows WHERE player_id = ?)
          )`,
      ).bind(
        crypto.randomUUID(),
        `profile-delete-guard:${crypto.randomUUID()}`,
        actor.channel,
        now,
        now + 1,
        now,
        actor.sessionId,
        actor.channel,
        now,
        actor.playerId,
        actor.playerId,
        actor.playerId,
        actor.playerId,
      ),
    ]);
  } catch (error) {
    return classifyDeletionOutcome(env, telegramActor, now, error);
  }

  if (!expectedBatchResults(results)) {
    return classifyDeletionOutcome(
      env,
      telegramActor,
      now,
      new Error("Profile deletion changed an unexpected number of rows."),
    );
  }
  return guestResponse();
}
```

- [ ] **Step 6: Добавить in-batch rollback tests**

Append в `apps/api/test/profile-deletion.test.ts`:

```ts
it.each([
  ["IGNORE", "test_ignore_profile_delete_player"],
  ["ABORT", "test_abort_profile_delete_player"],
] as const)("rolls back the full batch when player deletion raises %s", async (mode, name) => {
  const graph = await seedProfileDeletionGraph();
  const raise =
    mode === "IGNORE"
      ? "RAISE(IGNORE)"
      : "RAISE(ABORT, 'forced_profile_delete_failure')";
  await testEnv.DB.prepare(
    `CREATE TRIGGER ${name}
       BEFORE DELETE ON players
       WHEN OLD.id = '${graph.playerId}'
       BEGIN
         SELECT ${raise};
       END`,
  ).run();

  await expect(
    deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
  ).rejects.toBeInstanceOf(Error);
  expect(
    await testEnv.DB.prepare(
      "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
    )
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({
    kind: "telegram",
    player_id: graph.playerId,
    rotated_from_session_id: graph.predecessorId,
  });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).not.toBeNull();

  await testEnv.DB.prepare(`DROP TRIGGER ${name}`).run();
  await expect(
    deleteProfileForActor(testEnv, telegramDeletionActor(graph), deletionNow),
  ).resolves.toEqual({ kind: "guest", profile: null });
});
```

Для `IGNORE` test expected failure приходит от invalid `sessions.kind` guard; для `ABORT` — от D1 delete statement. Оба пути обязаны сохранить original rotation link и весь player graph до retry.

- [ ] **Step 7: Добавить post-commit sanity classifier test**

Создать thin `Proxy` только в test: все методы делегируют real DB, `batch` сначала реально commit'ит, затем возвращает копию results с `results[0].meta.changes = 9`. Проверить guest success плюс отсутствие graph:

```ts
const wrappedDb = new Proxy(testEnv.DB, {
  get(target, property, receiver) {
    if (property === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        const committed = await target.batch(statements);
        return committed.map((result, index) =>
          index === 0
            ? { ...result, meta: { ...result.meta, changes: 9 } }
            : result,
        ) as D1Result[];
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const wrappedEnv = Object.assign(Object.create(testEnv) as Env, { DB: wrappedDb });

await expect(
  deleteProfileForActor(wrappedEnv, telegramDeletionActor(graph), deletionNow),
).resolves.toEqual({ kind: "guest", profile: null });
expect(
  await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
    .bind(graph.playerId)
    .first(),
).toBeNull();
```

- [ ] **Step 8: Подтвердить service GREEN и types**

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.test.ts
npm run typecheck -w @a-move-ago/api
```

Expected: service tests PASS; typecheck exit `0`.

- [ ] **Step 9: Закоммитить service**

```bash
git add apps/api/src/services/profile-deletion-service.ts apps/api/test/helpers/profile-deletion.ts apps/api/test/profile-deletion.test.ts
git commit -m "feat(api): add atomic profile deletion service"
```

### Task 3: Выставить DELETE route, exact CORS, limiter и privacy boundary

**Files:**

- Modify: `apps/api/src/routes/me.ts:1-46`
- Modify: `apps/api/src/middleware/cors.ts:37`
- Modify: `apps/api/test/boundary.test.ts:227-252`
- Modify: `apps/api/test/profile-deletion.test.ts`

- [ ] **Step 1: Написать failing route success и idempotency tests**

В test setup зафиксировать общий clock и очищать spies:

```ts
beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(Date, "now").mockReturnValue(deletionNow * 1_000);
});

afterEach(async () => {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_profile_delete_player").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_abort_profile_delete_player").run();
  vi.restoreAllMocks();
});
```

Append exact HTTP assertions:

```ts
it("returns a no-store guest response and safely repeats with the same token", async () => {
  const graph = await seedProfileDeletionGraph();
  const first = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    { method: "DELETE" },
  );
  expect(first.response.status).toBe(200);
  expect(first.response.headers.get("cache-control")).toBe("no-store");
  expect(first.body).toEqual({ kind: "guest", profile: null });
  expect(JSON.stringify(first.body)).not.toMatch(
    /deleted|count|row|987654321|Deletion Marker Ada/i,
  );

  const second = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    { method: "DELETE" },
  );
  expect(second.response.status).toBe(200);
  expect(second.body).toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT count(*) AS count FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first<{ count: number }>(),
  ).toEqual({ count: 0 });
});

it("invalidates every other Telegram token linked to the deleted player", async () => {
  const graph = await seedProfileDeletionGraph();
  await authenticatedJson("/v1/me", graph.current.token, { method: "DELETE" });

  const response = await authenticatedJson("/v1/me", graph.other.token);
  expect(response.response.status).toBe(401);
  expect(response.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
});
```

- [ ] **Step 2: Написать failing middleware-order tests**

Append:

```ts
it("runs bearer, exact Origin, limiter, then deletion in that order", async () => {
  const graph = await seedProfileDeletionGraph();
  const limit = vi.fn(async () => ({ success: true }));
  const requestEnv = Object.assign(Object.create(testEnv) as Env, {
    AUTH_RATE_LIMITER: { limit },
  });

  const missingBearer = await requestJson(
    "/v1/me",
    { method: "DELETE", headers: { origin: "https://evil.test" } },
    requestEnv,
  );
  expect(missingBearer.response.status).toBe(401);
  expect(limit).not.toHaveBeenCalled();

  const denied = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    { method: "DELETE", headers: { origin: "https://evil.test" } },
    requestEnv,
  );
  expect(denied.response.status).toBe(403);
  expect(denied.body).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
  expect(limit).not.toHaveBeenCalled();

  const allowed = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    {
      method: "DELETE",
      headers: { origin: "https://agent-axiom.github.io" },
    },
    requestEnv,
  );
  expect(allowed.response.status).toBe(200);
  expect(limit).toHaveBeenCalledOnce();
  expect(limit).toHaveBeenCalledWith({
    key: `profile-delete:${graph.current.sessionId}`,
  });
});

it("returns 429 before mutation and applies the limiter to guest no-op retries", async () => {
  const graph = await seedProfileDeletionGraph();
  const deniedLimit = vi.fn(async () => ({ success: false }));
  const requestEnv = Object.assign(Object.create(testEnv) as Env, {
    AUTH_RATE_LIMITER: { limit: deniedLimit },
  });
  const before = await testEnv.DB.prepare(
    "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
  )
    .bind(graph.current.sessionId)
    .first();

  const limited = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    { method: "DELETE" },
    requestEnv,
  );
  expect(limited.response.status).toBe(429);
  expect(limited.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  expect(
    await testEnv.DB.prepare(
      "SELECT kind, player_id, rotated_from_session_id FROM sessions WHERE id = ?",
    )
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual(before);

  const guest = await issueGuest("web");
  const guestLimited = await authenticatedJson(
    "/v1/me",
    guest.token,
    { method: "DELETE" },
    requestEnv,
  );
  expect(guestLimited.response.status).toBe(429);
  expect(deniedLimit).toHaveBeenLastCalledWith({
    key: `profile-delete:${guest.sessionId}`,
  });
});

it.each(["revoked", "expired"] as const)(
  "rejects a %s bearer before limiter and mutation",
  async (state) => {
    const graph = await seedProfileDeletionGraph();
    if (state === "revoked") {
      await testEnv.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
        .bind(deletionNow, graph.current.sessionId)
        .run();
    } else {
      await testEnv.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(deletionNow, graph.current.sessionId)
        .run();
    }
    const limit = vi.fn(async () => ({ success: true }));
    const requestEnv = Object.assign(Object.create(testEnv) as Env, {
      AUTH_RATE_LIMITER: { limit },
    });

    const result = await authenticatedJson(
      "/v1/me",
      graph.current.token,
      { method: "DELETE" },
      requestEnv,
    );
    expect(result.response.status).toBe(401);
    expect(result.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
    expect(limit).not.toHaveBeenCalled();
    expect(
      await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
        .bind(graph.playerId)
        .first(),
    ).not.toBeNull();
  },
);

it("rejects an unknown bearer before limiter", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  const requestEnv = Object.assign(Object.create(testEnv) as Env, {
    AUTH_RATE_LIMITER: { limit },
  });
  const result = await authenticatedJson(
    "/v1/me",
    "A".repeat(43),
    { method: "DELETE" },
    requestEnv,
  );
  expect(result.response.status).toBe(401);
  expect(result.body).toMatchObject({ error: { code: "INVALID_SESSION" } });
  expect(limit).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Написать failing exact CORS tests**

В `apps/api/test/boundary.test.ts` заменить единственное exact ожидание:

```ts
expect(allowed.headers.get("access-control-allow-methods")).toBe(
  "GET,POST,DELETE,OPTIONS",
);
```

В `profile-deletion.test.ts` добавить protected preflight test, который использует `app.fetch()` напрямую, потому что `OPTIONS` body пустой:

```ts
it("terminates profile deletion preflight before auth, limiter, and service", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  const requestEnv = Object.assign(Object.create(testEnv) as Env, {
    AUTH_RATE_LIMITER: { limit },
  });
  const allowed = await app.fetch(
    new Request("https://api.test/v1/me", {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io" },
    }),
    requestEnv,
  );
  const denied = await app.fetch(
    new Request("https://api.test/v1/me", {
      method: "OPTIONS",
      headers: { origin: "https://agent-axiom.github.io.evil.test" },
    }),
    requestEnv,
  );

  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("access-control-allow-origin")).toBe(
    "https://agent-axiom.github.io",
  );
  expect(allowed.headers.get("access-control-allow-methods")).toBe(
    "GET,POST,DELETE,OPTIONS",
  );
  expect(denied.status).toBe(204);
  expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  expect(denied.headers.get("access-control-allow-methods")).toBeNull();
  expect(limit).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Запустить route/CORS tests и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.test.ts test/boundary.test.ts
```

Expected: DELETE возвращает `404`; allowed preflight всё ещё рекламирует `GET,POST,OPTIONS`.

- [ ] **Step 5: Реализовать route с точным middleware order**

В `apps/api/src/routes/me.ts` добавить imports:

```ts
import {
  GuestMeResponseSchema,
  MeResponseSchema,
  StatsResponseSchema,
} from "@a-move-ago/api-contract";
import { requireAllowedMutationOrigin } from "../middleware/origin";
import { enforceLimit } from "../middleware/rate-limit";
import { deleteProfileForActor } from "../services/profile-deletion-service";
```

Append route; SQL в route не добавлять:

```ts
me.delete("/", requireSession, requireAllowedMutationOrigin, async (context) => {
  context.header("cache-control", "no-store");
  const actor = context.get("session");
  if (!actor) {
    throw new ApiError(401, "INVALID_SESSION", "The session is invalid or expired.");
  }
  await enforceLimit(
    context.env.AUTH_RATE_LIMITER,
    `profile-delete:${actor.sessionId}`,
  );
  return context.json(
    GuestMeResponseSchema.parse(
      await deleteProfileForActor(
        context.env,
        actor,
        Math.floor(Date.now() / 1_000),
      ),
    ),
  );
});
```

- [ ] **Step 6: Разрешить DELETE только на already-allowed exact origins**

В `apps/api/src/middleware/cors.ts` заменить header value:

```ts
context.header(
  "access-control-allow-methods",
  "GET,POST,DELETE,OPTIONS",
);
```

Не добавлять wildcard origin и не переносить auth/origin logic в preflight path.

- [ ] **Step 7: Добавить response и structured-log privacy test**

Append в `profile-deletion.test.ts`:

```ts
it("returns a generic envelope when guarded deletion rolls back", async () => {
  const graph = await seedProfileDeletionGraph();
  await testEnv.DB.prepare(
    `CREATE TRIGGER test_ignore_profile_delete_player
       BEFORE DELETE ON players
       WHEN OLD.id = '${graph.playerId}'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
  ).run();

  const result = await authenticatedJson(
    "/v1/me",
    graph.current.token,
    { method: "DELETE" },
  );
  expect(result.response.status).toBe(500);
  expect(result.body).toEqual({
    error: {
      code: "INTERNAL_ERROR",
      message: "Unexpected server error.",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  });
  expect(JSON.stringify(result.body)).not.toMatch(
    /987654321|Deletion Marker Ada|delete_marker|player|attempt|row|SQL/i,
  );
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).not.toBeNull();
});

it("logs only the structured request boundary and never deletion data", async () => {
  const graph = await seedProfileDeletionGraph();
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

  const result = await authenticatedJson(
    "/v1/me?telegramUserId=attacker-controlled",
    graph.current.token,
    { method: "DELETE" },
  );
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ kind: "guest", profile: null });

  const entries = log.mock.calls
    .map(([value]) => String(value))
    .filter((value) => value.includes('"method":"DELETE"'));
  expect(entries).toHaveLength(1);
  expect(JSON.parse(entries[0] ?? "{}")).toMatchObject({
    method: "DELETE",
    path: "/v1/me",
    status: 200,
    sessionKind: "telegram",
  });
  const disclosure = [
    graph.current.token,
    graph.current.tokenHash,
    graph.playerId,
    "987654321",
    "Deletion Marker Ada",
    "delete_marker",
    "delete-marker.png",
    "attacker-controlled",
    "deletedRows",
  ];
  for (const secret of disclosure) expect(entries.join("\n")).not.toContain(secret);
});
```

- [ ] **Step 8: Подтвердить route GREEN и full API regression**

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.test.ts test/boundary.test.ts test/security.test.ts
npm test -w @a-move-ago/api
npm run typecheck -w @a-move-ago/api
```

Expected: focused suites PASS; full API suite содержит прежние 326 tests плюс новые deletion tests и полностью PASS.

- [ ] **Step 9: Закоммитить HTTP boundary**

```bash
git add apps/api/src/routes/me.ts apps/api/src/middleware/cors.ts apps/api/test/boundary.test.ts apps/api/test/profile-deletion.test.ts
git commit -m "feat(api): expose authenticated profile deletion"
```

### Task 4: Доказать concurrency, lost acknowledgement и auth interleavings

**Files:**

- Create: `apps/api/test/profile-deletion.integration.test.ts`
- Modify: `apps/api/test/helpers/profile-deletion.ts`

- [ ] **Step 1: Расширить fixture независимым guest progress**

Импортировать `type AcceptedSolution` из `@a-move-ago/api-contract` в fixture helper и добавить в `ProfileDeletionGraph`:

```ts
content: {
  caseId: string;
  puzzleId: string;
  retraction: AcceptedSolution["retraction"];
};
independentGuestAttemptId: string;
```

До возврата graph вставить под `independentGuest.sessionId` attempt `keep-independent-guest-attempt` с `player_id = NULL` и вернуть seeded case/puzzle values:

```ts
const independentGuestAttemptId = "keep-independent-guest-attempt";
await testEnv.DB.prepare(
  `INSERT INTO attempts
    (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
     normalized_answer_json, correct, response_json, hints_used, submitted_at)
   VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
)
  .bind(
    independentGuestAttemptId,
    crypto.randomUUID(),
    independentGuest.sessionId,
    content.caseId,
    content.puzzle.rowId,
    JSON.stringify({ source: "independent-guest" }),
    JSON.stringify({ correct: false }),
    deletionNow,
  )
  .run();
```

Основной cascade test Task 2 должен дополнительно подтвердить:

```ts
expect(
  await testEnv.DB.prepare(
    "SELECT player_id FROM attempts WHERE id = ?",
  )
    .bind(graph.independentGuestAttemptId)
    .first(),
).toEqual({ player_id: null });
```

- [ ] **Step 2: Создать integration test harness**

В `apps/api/test/profile-deletion.integration.test.ts` определить imports, fixed clock и bodyless request helper:

```ts
import {
  ApiTransportError,
  OidcStartResponseSchema,
  TelegramSessionIssuedSchema,
  createApiClient,
} from "@a-move-ago/api-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { TelegramOidcProvider } from "../src/auth/telegram-oidc";
import { hashSessionToken } from "../src/crypto/opaque-token";
import type { Env } from "../src/env";
import { linkGuestToPlayer } from "../src/services/account-link-service";
import { deleteProfileForActor } from "../src/services/profile-deletion-service";
import { verifiedOidcIdentity } from "./fixtures/telegram";
import {
  deletionNow,
  seedProfileDeletionGraph,
  telegramDeletionActor,
} from "./helpers/profile-deletion";
import { issueGuest, resetDatabase, testEnv } from "./helpers/http";

const app = createApp({ now: () => new Date(deletionNow * 1_000) });

async function remove(token: string): Promise<Response> {
  return app.fetch(
    new Request("https://api.test/v1/me", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    testEnv,
  );
}

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(Date, "now").mockReturnValue(deletionNow * 1_000);
});

afterEach(() => vi.restoreAllMocks());
```

- [ ] **Step 3: Написать concurrent DELETE proof tests**

Append:

```ts
it("converges two same-token DELETE requests on one surviving guest", async () => {
  const graph = await seedProfileDeletionGraph();
  const responses = await Promise.all([
    remove(graph.current.token),
    remove(graph.current.token),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);
  await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
    { kind: "guest", profile: null },
    { kind: "guest", profile: null },
  ]);
  expect(
    await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE id = ?")
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({ kind: "guest", player_id: null });
  expect(
    await testEnv.DB.prepare("SELECT count(*) AS count FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).toEqual({ count: 0 });
});

it("lets one of two linked sessions survive and invalidates the other", async () => {
  const graph = await seedProfileDeletionGraph();
  const responses = await Promise.all([
    remove(graph.current.token),
    remove(graph.other.token),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
  const competingRows = await testEnv.DB.prepare(
    `SELECT id, kind, player_id FROM sessions
      WHERE id IN (?, ?)
      ORDER BY id`,
  )
    .bind(graph.current.sessionId, graph.other.sessionId)
    .all<{ id: string; kind: string; player_id: string | null }>();
  expect(competingRows.results).toHaveLength(1);
  expect(competingRows.results[0]).toMatchObject({ kind: "guest", player_id: null });
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).toBeNull();
});
```

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.integration.test.ts
```

Expected after Tasks 1–3: both tests PASS; a `500`, two survivors, or surviving player is a blocker.

- [ ] **Step 4: Написать lost HTTP response test**

Append:

```ts
it("retries the same token after the first committed HTTP response is lost", async () => {
  const graph = await seedProfileDeletionGraph();
  let loseResponse = true;
  const api = createApiClient({
    baseUrl: "https://api.test",
    getToken: () => graph.current.token,
    fetch: async (input, init) => {
      const response = await app.fetch(new Request(input, init), testEnv);
      if (loseResponse) {
        loseResponse = false;
        throw new TypeError("response lost after commit");
      }
      return response;
    },
  });

  await expect(api.deleteProfile()).rejects.toBeInstanceOf(ApiTransportError);
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(graph.playerId)
      .first(),
  ).toBeNull();
  await expect(api.deleteProfile()).resolves.toEqual({ kind: "guest", profile: null });
  expect(
    await testEnv.DB.prepare("SELECT kind, player_id FROM sessions WHERE id = ?")
      .bind(graph.current.sessionId)
      .first(),
  ).toEqual({ kind: "guest", player_id: null });
});
```

- [ ] **Step 5: Написать committed D1 batch acknowledgement test**

Через `Proxy` заменить только `batch`: первый вызов делегирует реальному D1 и затем бросает. Route не нужен; вызвать service с Telegram actor, который fixture возвращает через exported `telegramDeletionActor(graph)`:

```ts
const db = new Proxy(testEnv.DB, {
  get(target, property, receiver) {
    if (property === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        await target.batch(statements);
        throw new TypeError("D1 acknowledgement lost after commit");
      };
    }
    const value = Reflect.get(target, property, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const requestEnv = Object.assign(Object.create(testEnv) as Env, { DB: db });

await expect(
  deleteProfileForActor(
    requestEnv,
    telegramDeletionActor(graph),
    deletionNow,
  ),
).resolves.toEqual({ kind: "guest", profile: null });
```

После success проверить старый player/attempts отсутствующими. Это отдельный boundary от lost HTTP response: service сам классифицирует committed/unknown D1 outcome.

- [ ] **Step 6: Написать late Mini App linking tests**

Append два commit-order cases:

```ts
it("links only independent guest progress when a started Mini App login commits after deletion", async () => {
  const graph = await seedProfileDeletionGraph();
  await remove(graph.current.token);

  const issued = await linkGuestToPlayer(
    testEnv,
    {
      sessionId: graph.independentGuest.sessionId,
      playerId: null,
      kind: "guest",
      channel: "telegram",
    },
    verifiedOidcIdentity,
    deletionNow + 1,
  );
  const newPlayer = await testEnv.DB.prepare(
    "SELECT id FROM players WHERE telegram_user_id = ?",
  )
    .bind(verifiedOidcIdentity.telegramUserId)
    .first<{ id: string }>();
  expect(newPlayer?.id).not.toBe(graph.playerId);
  expect(
    await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toEqual({ player_id: newPlayer?.id });
  for (const oldAttemptId of graph.linkedAttemptIds) {
    expect(
      await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
        .bind(oldAttemptId)
        .first(),
    ).toBeNull();
  }
  expect(TelegramSessionIssuedSchema.parse(issued).kind).toBe("telegram");
});

it("deletes a Mini App link that commits before profile deletion", async () => {
  const graph = await seedProfileDeletionGraph();
  const linked = await linkGuestToPlayer(
    testEnv,
    {
      sessionId: graph.independentGuest.sessionId,
      playerId: null,
      kind: "guest",
      channel: "telegram",
    },
    verifiedOidcIdentity,
    deletionNow,
  );
  const linkedSession = await testEnv.DB.prepare(
    "SELECT id, player_id FROM sessions WHERE token_hash = ?",
  )
    .bind(await hashSessionToken(linked.token, testEnv.SESSION_PEPPER))
    .first<{ id: string; player_id: string }>();
  if (!linkedSession) throw new Error("Linked Mini App session is missing.");

  const response = await remove(linked.token);
  expect(response.status).toBe(200);
  expect(
    await testEnv.DB.prepare("SELECT id FROM players WHERE id = ?")
      .bind(linkedSession.player_id)
      .first(),
  ).toBeNull();
  expect(
    await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
      .bind(graph.independentGuestAttemptId)
      .first(),
  ).toBeNull();
});
```

Fixture Telegram ID должен быть `verifiedOidcIdentity.telegramUserId`, чтобы этот test моделировал ту же identity, а не другой account.

- [ ] **Step 7: Написать late OIDC flow test**

Создать provider:

```ts
const provider = {
  exchangeAndVerify: vi.fn(async () => verifiedOidcIdentity),
} satisfies TelegramOidcProvider;
const oidcApp = createApp({
  now: () => new Date(deletionNow * 1_000),
  oidcProvider: provider,
});
```

Test sequence обязан быть exact:

```ts
const graph = await seedProfileDeletionGraph();
const webGuest = await issueGuest("web");
await testEnv.DB.prepare(
  `INSERT INTO attempts
    (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
     normalized_answer_json, correct, response_json, hints_used, submitted_at)
   VALUES ('oidc-independent-attempt', ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
)
  .bind(
    crypto.randomUUID(),
    webGuest.sessionId,
    graph.content.caseId,
    graph.content.puzzleId,
    JSON.stringify({ source: "independent-oidc-guest" }),
    JSON.stringify({ correct: false }),
    deletionNow,
  )
  .run();

const start = await oidcApp.fetch(
  new Request("https://api.test/v1/auth/telegram/oidc/start", {
    method: "POST",
    headers: {
      authorization: `Bearer ${webGuest.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel: "web" }),
  }),
  testEnv,
);
const state = new URL(
  OidcStartResponseSchema.parse(await start.json()).authorizationUrl,
).searchParams.get("state");
if (!state) throw new Error("OIDC state is missing.");

await remove(graph.current.token);
const callback = await oidcApp.fetch(
  new Request(
    `https://api.test/v1/auth/telegram/oidc/callback?state=${encodeURIComponent(state)}&code=provider-code`,
  ),
  testEnv,
);
expect(callback.status).toBe(302);
expect(provider.exchangeAndVerify).toHaveBeenCalledOnce();
const location = callback.headers.get("location");
if (!location) throw new Error("OIDC handoff redirect is missing.");
const handoffCode = new URL(location).searchParams.get("handoff");
if (!handoffCode) throw new Error("OIDC handoff code is missing.");

const exchange = await oidcApp.fetch(
  new Request("https://api.test/v1/auth/session/exchange", {
    method: "POST",
    headers: {
      authorization: `Bearer ${webGuest.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ handoffCode }),
  }),
  testEnv,
);
expect(exchange.status).toBe(200);
TelegramSessionIssuedSchema.parse(await exchange.json());

const newPlayer = await testEnv.DB.prepare(
  "SELECT id FROM players WHERE telegram_user_id = ?",
)
  .bind(verifiedOidcIdentity.telegramUserId)
  .first<{ id: string }>();
expect(newPlayer?.id).not.toBe(graph.playerId);
expect(
  await testEnv.DB.prepare("SELECT player_id FROM attempts WHERE id = 'oidc-independent-attempt'")
    .first(),
).toEqual({ player_id: newPlayer?.id });
for (const oldAttemptId of graph.linkedAttemptIds) {
  expect(
    await testEnv.DB.prepare("SELECT id FROM attempts WHERE id = ?")
      .bind(oldAttemptId)
      .first(),
  ).toBeNull();
}
```

- [ ] **Step 8: Запустить integration suite и full auth regression**

Run:

```bash
npm test -w @a-move-ago/api -- test/profile-deletion.integration.test.ts test/telegram-auth.integration.test.ts test/mini-app-auth.test.ts test/oidc-callback.test.ts test/sessions.test.ts
npm run typecheck -w @a-move-ago/api
```

Expected: все focused suites PASS; late login создаёт новый player UUID и переносит только independently accumulated guest attempts.

- [ ] **Step 9: Закоммитить race evidence**

```bash
git add apps/api/test/helpers/profile-deletion.ts apps/api/test/profile-deletion.integration.test.ts
git commit -m "test(api): cover profile deletion races and retries"
```

### Task 5: Добавить client service и provider-owned deletion action

**Files:**

- Modify: `apps/client/src/features/session/session-service.ts:1-20`
- Modify: `apps/client/src/features/session/session-service.test.ts:1-18`
- Modify: `apps/client/src/features/session/SessionProvider.tsx:1-250`
- Modify: `apps/client/src/features/session/SessionProvider.test.tsx:1-620`
- Modify: `apps/client/src/test/runtime-fixture.ts:19-75`

- [ ] **Step 1: Написать failing session-service tests**

Импортировать `deleteProfile` из `./session-service` и append:

```ts
it("deletes a Telegram profile without rotating or clearing the current token", async () => {
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  const beforeRuntimeToken = runtime.token.get();
  const beforeStoredToken = await runtime.platform.tokenStore.read();
  const signal = new AbortController().signal;

  await expect(deleteProfile(runtime, signal)).resolves.toEqual({
    kind: "guest",
    profile: null,
  });
  expect(runtime.api.deleteProfile).toHaveBeenCalledWith(signal);
  expect(runtime.token.get()).toBe(beforeRuntimeToken);
  expect(await runtime.platform.tokenStore.read()).toBe(beforeStoredToken);
  expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
});

it("propagates an unconfirmed deletion failure without touching token storage", async () => {
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  const failure = new ApiTransportError(new TypeError("response lost"));
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(failure);

  await expect(deleteProfile(runtime)).rejects.toBe(failure);
  expect(runtime.token.get()).toBe("t".repeat(43));
  expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Написать failing provider tests**

Добавить test probes в `SessionProvider.test.tsx`:

```tsx
function DeleteProbe({ twice = false }: { twice?: boolean }) {
  const { state, deleteProfile } = useSession();
  return (
    <>
      <output data-testid="session-state">
        {state.tag}:{"me" in state ? state.me.kind : "none"}
      </output>
      <button
        type="button"
        onClick={() => {
          void deleteProfile();
          if (twice) void deleteProfile();
        }}
      >
        Delete through provider
      </button>
    </>
  );
}
```

Append four exact cases:

```ts
it("keeps profile deletion single-flight and applies only the confirmed guest result", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const pending = deferred<{ kind: "guest"; profile: null }>();
  runtime.api.deleteProfile = vi.fn(() => pending.promise);
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe twice />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"));
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  expect(runtime.api.deleteProfile).toHaveBeenCalledOnce();
  expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram");
  await act(async () => pending.resolve({ kind: "guest", profile: null }));
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));
});

it("keeps Telegram ready and rejects an unconfirmed profile deletion", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const failure = new ApiError(503, "UNAVAILABLE", "Try again.", "req-delete", null);
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(failure);
  const observed: unknown[] = [];

  function CatchingDeleteProbe() {
    const { state, deleteProfile } = useSession();
    return (
      <button
        type="button"
        onClick={() => void deleteProfile().catch((error: unknown) => observed.push(error))}
      >
        Delete and catch
        <span>{state.tag === "ready" ? ` ${state.me.kind}` : ""}</span>
      </button>
    );
  }

  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <CatchingDeleteProbe />
      </SessionProvider>
    </RuntimeProvider>,
  );
  const button = await screen.findByRole("button", { name: /Delete and catch telegram/ });
  await user.click(button);
  await waitFor(() => expect(observed).toEqual([failure]));
  expect(button).toHaveTextContent("telegram");
});

it("aborts an in-flight profile deletion when the provider unmounts", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const pending = deferred<{ kind: "guest"; profile: null }>();
  let deletionSignal: AbortSignal | undefined;
  runtime.api.deleteProfile = vi.fn((signal) => {
    deletionSignal = signal;
    return pending.promise;
  });
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe />
      </SessionProvider>
    </RuntimeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"));
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  await waitFor(() => expect(runtime.api.deleteProfile).toHaveBeenCalledOnce());
  view.unmount();
  expect(deletionSignal?.aborted).toBe(true);
  await act(async () => pending.resolve({ kind: "guest", profile: null }));
});

it("accepts a fresh OIDC handoff after deletion returns the session to guest", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi
    .fn()
    .mockResolvedValueOnce({ kind: "telegram" as const, profile })
    .mockResolvedValueOnce({ kind: "guest" as const, profile: null });
  let authReturn: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (listener) => {
    authReturn = listener;
    return () => undefined;
  });

  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe />
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"));
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));
  await user.click(screen.getByRole("button", { name: "Save progress with Telegram" }));
  await waitFor(() => expect(runtime.platform.openAuthorization).toHaveBeenCalledOnce());

  act(() => authReturn?.(`/?handoff=${"B".repeat(43)}`));
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(
    "B".repeat(43),
    expect.any(AbortSignal),
  ));
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"));
});
```

- [ ] **Step 3: Запустить client unit tests и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/client -- src/features/session/session-service.test.ts src/features/session/SessionProvider.test.tsx
```

Expected: FAIL на отсутствующих `runtime.api.deleteProfile`, service export и context action.

- [ ] **Step 4: Добавить runtime fixture и service wrapper**

В mock API `apps/client/src/test/runtime-fixture.ts` добавить:

```ts
deleteProfile: vi.fn(async () => ({
  kind: "guest" as const,
  profile: null,
})),
```

В import `session-service.ts` добавить `type GuestMeResponse`, затем export рядом с `readMe`:

```ts
export async function deleteProfile(
  runtime: AppRuntime,
  signal = new AbortController().signal,
): Promise<GuestMeResponse> {
  return runtime.api.deleteProfile(signal);
}
```

Не вызывать `retryGet`, `installServerToken`, `runtime.token.set`, `tokenStore.write` или `tokenStore.clear`.

- [ ] **Step 5: Расширить provider context и auth lifecycle ref**

В `SessionProvider.tsx` импортировать service под alias и расширить context:

```ts
import {
  bootstrapSession,
  deleteProfile as deleteTelegramProfile,
  retryHandoff as exchangePendingHandoff,
  RetryableHandoffError,
  saveProgress,
  TelegramAuthDeniedError,
} from "./session-service";

interface SessionContextValue {
  state: SessionState;
  save(): Promise<void>;
  retryHandoff(): Promise<void>;
  deleteProfile(): Promise<boolean>;
}
```

Рядом с lifecycle refs добавить:

```ts
const hasTelegramIdentityRef = useRef(false);
```

При runtime replacement очистить его вместе с handled keys:

```ts
if (handledRuntimeRef.current !== runtime) {
  handledRuntimeRef.current = runtime;
  handledReturnKeysRef.current.clear();
  hasTelegramIdentityRef.current = false;
  setState({ tag: "booting" });
}
```

Удалить effect-local `let authenticated = false`. В `schedule` и queued callback заменить обе проверки на:

```ts
if (hasTelegramIdentityRef.current) return;
```

После успешного bootstrap, строго после `active()` check:

```ts
hasTelegramIdentityRef.current = me.kind === "telegram";
handledReturnKeysRef.current.add(key);
setState({ tag: "ready", me });
```

- [ ] **Step 6: Синхронизировать ref на всех provider-owned identity transitions**

В successful `save()` заменить однострочный state update:

```ts
if (actionIsCurrent(action)) {
  const next = me ?? previous;
  hasTelegramIdentityRef.current = next.kind === "telegram";
  setState({ tag: "ready", me: next });
}
```

В successful `retryHandoff()`:

```ts
if (actionIsCurrent(action)) {
  hasTelegramIdentityRef.current = true;
  setState({ tag: "ready", me });
}
```

Ошибочные/устаревшие actions ref не меняют.

- [ ] **Step 7: Реализовать provider deletion action на общем ActionSlot**

Добавить в returned context object после `retryHandoff`:

```ts
async deleteProfile() {
  if (state.tag !== "ready" || state.me.kind !== "telegram") return false;
  const action = beginAction();
  if (!action) return false;
  try {
    const me = await deleteTelegramProfile(runtime, action.controller.signal);
    if (!actionIsCurrent(action)) return false;
    hasTelegramIdentityRef.current = false;
    setState({ tag: "ready", me });
    return true;
  } catch (error) {
    if (!actionIsCurrent(action)) return false;
    throw error;
  } finally {
    finishAction(action);
  }
},
```

`true` означает только «guest-only response применён текущим lifecycle»; busy, abort и stale lifecycle возвращают `false`, чтобы UI не показывал ложный success.

- [ ] **Step 8: Подтвердить GREEN, existing auth dedupe и types**

Run:

```bash
npm test -w @a-move-ago/client -- src/features/session/session-service.test.ts src/features/session/SessionProvider.test.tsx
npm run typecheck -w @a-move-ago/client
```

Expected: новые tests и все существующие handoff dedupe/runtime replacement tests PASS; typecheck exit `0`.

- [ ] **Step 9: Закоммитить client session boundary**

```bash
git add apps/client/src/features/session/session-service.ts apps/client/src/features/session/session-service.test.ts apps/client/src/features/session/SessionProvider.tsx apps/client/src/features/session/SessionProvider.test.tsx apps/client/src/test/runtime-fixture.ts
git commit -m "feat(client): add profile deletion session action"
```

### Task 6: Добавить accessible two-step UI и identity refresh composition

**Files:**

- Create: `apps/client/src/features/session/ProfileDeletion.tsx`
- Create: `apps/client/src/features/session/ProfileDeletion.test.tsx`
- Create: `apps/client/src/styles/profile-deletion.css`
- Modify: `apps/client/src/styles/base.css:1-3`
- Modify: `apps/client/src/App.tsx:1-105`
- Modify: `apps/client/src/App.test.tsx`

- [ ] **Step 1: Написать failing visibility и disclosure tests**

В `ProfileDeletion.test.tsx` создать renderer с реальным provider:

```tsx
import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { ProfileDeletion } from "./ProfileDeletion";
import { SessionProvider, useSession } from "./SessionProvider";

const telegramMe = {
  kind: "telegram" as const,
  profile: {
    telegramUserId: "42",
    displayName: "Ada",
    username: null,
    avatarUrl: null,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderDeletion(identity: "guest" | "telegram") {
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () =>
    identity === "telegram" ? telegramMe : { kind: "guest" as const, profile: null },
  );
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <ProfileDeletion />
      </SessionProvider>
    </RuntimeProvider>,
  );
  return { runtime, view };
}

afterEach(cleanup);
```

Append:

```ts
it("renders the destructive disclosure only for a ready Telegram session", async () => {
  const guest = renderDeletion("guest");
  await waitFor(() => expect(guest.runtime.api.getMe).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();
  guest.view.unmount();

  renderDeletion("telegram");
  expect(
    await screen.findByRole("button", { name: "Delete Telegram profile" }),
  ).toHaveAttribute("aria-expanded", "false");
});

it("opens a named inline confirmation and Cancel returns focus without a request", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  const opener = await screen.findByRole("button", { name: "Delete Telegram profile" });
  await user.click(opener);

  expect(opener).toHaveAttribute("aria-expanded", "true");
  expect(opener).toHaveAttribute("aria-controls", "profile-deletion-confirmation");
  const region = screen.getByRole("region", { name: "Delete Telegram profile?" });
  expect(region).toHaveAccessibleDescription(
    "This permanently deletes your A MOVE AGO Telegram profile and all saved attempts, hints, and statistics on every device. It does not delete your Telegram account. This cannot be undone.",
  );
  const heading = screen.getByRole("heading", { name: "Delete Telegram profile?" });
  expect(heading).toHaveAttribute("tabindex", "-1");
  expect(heading).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Delete permanently" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(runtime.api.deleteProfile).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Delete Telegram profile?" })).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
```

- [ ] **Step 2: Написать failing pending, failure, retry и success tests**

Append:

```ts
it("disables both actions, blocks a same-tick double click, and announces pending", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  const pending = deferred<{ kind: "guest"; profile: null }>();
  runtime.api.deleteProfile = vi.fn(() => pending.promise);
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  const destroy = screen.getByRole("button", { name: "Delete permanently" });
  await user.dblClick(destroy);

  expect(runtime.api.deleteProfile).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Deleting Telegram profile…");
  await act(async () => pending.resolve({ kind: "guest", profile: null }));
});

it("shows an API request ID without losing the Telegram profile and retries", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(503, "UNAVAILABLE", "Deletion is unavailable.", "req-delete-9", null),
    )
    .mockResolvedValueOnce({ kind: "guest" as const, profile: null });

  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Deletion is unavailable.");
  expect(alert).toHaveTextContent("Request ID: req-delete-9");
  expect(screen.getByRole("button", { name: "Delete Telegram profile" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  const success = await screen.findByRole("status");
  expect(success).toHaveTextContent(
    "Telegram profile deleted. You are now playing as a guest.",
  );
  expect(success).toHaveFocus();
  expect(runtime.api.deleteProfile).toHaveBeenCalledTimes(2);
});

it("keeps a 401 unconfirmed and offers a reload before Telegram re-login", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(
    new ApiError(
      401,
      "INVALID_SESSION",
      "The session is no longer active.",
      "req-invalid-delete",
      null,
    ),
  );
  const tokenBefore = runtime.token.get();

  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Profile deletion could not be confirmed because this app session is no longer active. Reload, then choose Save progress with Telegram to verify the profile. Request ID: req-invalid-delete",
  );
  expect(screen.getByRole("button", { name: "Reload to sign in again" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Delete Telegram profile" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.queryByText(/now playing as a guest/i)).not.toBeInTheDocument();
  expect(runtime.token.get()).toBe(tokenBefore);
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
});

it.each([
  new ApiContractError(new Error("Telegram-shaped 200")),
  new ApiTransportError(new TypeError("response lost")),
])("treats %s as unconfirmed and keeps retry available", async (failure) => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(failure);
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Telegram profile deletion could not be confirmed. Retry to check the current profile state.",
  );
  expect(screen.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
  expect(screen.queryByText(/now playing as a guest/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Написать failing child-unmount test**

Append helper и test:

```tsx
function ProviderProbe() {
  const { state } = useSession();
  return <output data-testid="provider-kind">{"me" in state ? state.me.kind : state.tag}</output>;
}

function ToggleDeletion() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>Hide deletion UI</button>
      {visible ? <ProfileDeletion /> : null}
      <ProviderProbe />
    </>
  );
}
```

```ts
it("keeps provider-owned deletion alive while suppressing stale local UI after child unmount", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => telegramMe);
  const pending = deferred<{ kind: "guest"; profile: null }>();
  let signal: AbortSignal | undefined;
  runtime.api.deleteProfile = vi.fn((nextSignal) => {
    signal = nextSignal;
    return pending.promise;
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <ToggleDeletion />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  await user.click(screen.getByRole("button", { name: "Hide deletion UI" }));
  expect(signal?.aborted).toBe(false);
  await act(async () => pending.resolve({ kind: "guest", profile: null }));
  await waitFor(() => expect(screen.getByTestId("provider-kind")).toHaveTextContent("guest"));
  expect(screen.queryByText(/Telegram profile deleted/)).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Запустить component tests и подтвердить RED**

Run:

```bash
npm test -w @a-move-ago/client -- src/features/session/ProfileDeletion.test.tsx
```

Expected: FAIL, потому что `ProfileDeletion.tsx` отсутствует.

- [ ] **Step 5: Реализовать полный ProfileDeletion component**

Создать `apps/client/src/features/session/ProfileDeletion.tsx`:

```tsx
import { ApiError } from "@a-move-ago/api-contract";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./SessionProvider";

type DeletionView =
  | { tag: "closed" }
  | { tag: "confirming" }
  | { tag: "pending" }
  | {
      tag: "error";
      message: string;
      requestId?: string;
      reloadToReauthenticate?: true;
    }
  | { tag: "success" };

const confirmationId = "profile-deletion-confirmation";
const headingId = "profile-deletion-heading";
const warningId = "profile-deletion-warning";

function deletionFailure(error: unknown): Extract<DeletionView, { tag: "error" }> {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        tag: "error",
        message:
          "Profile deletion could not be confirmed because this app session is no longer active. Reload, then choose Save progress with Telegram to verify the profile.",
        requestId: error.requestId,
        reloadToReauthenticate: true,
      };
    }
    return {
      tag: "error",
      message: error.message,
      requestId: error.requestId,
    };
  }
  return {
    tag: "error",
    message:
      "Telegram profile deletion could not be confirmed. Retry to check the current profile state.",
  };
}

export function ProfileDeletion() {
  const { state, deleteProfile } = useSession();
  const [view, setView] = useState<DeletionView>({ tag: "closed" });
  const openerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const successRef = useRef<HTMLParagraphElement>(null);
  const mountedRef = useRef(false);
  const inFlightRef = useRef(false);
  const returnFocusRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const telegramReady = state.tag === "ready" && state.me.kind === "telegram";
  const guestReady = state.tag === "ready" && state.me.kind === "guest";

  useEffect(() => {
    if (view.tag === "confirming") headingRef.current?.focus();
    if (view.tag === "closed" && returnFocusRef.current) {
      returnFocusRef.current = false;
      openerRef.current?.focus();
    }
    if (view.tag === "success" && guestReady) successRef.current?.focus();
  }, [guestReady, view.tag]);

  async function confirmDeletion() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setView({ tag: "pending" });
    try {
      const confirmed = await deleteProfile();
      if (!mountedRef.current) return;
      setView(confirmed ? { tag: "success" } : { tag: "confirming" });
    } catch (error) {
      if (mountedRef.current) setView(deletionFailure(error));
    } finally {
      inFlightRef.current = false;
    }
  }

  if (view.tag === "success" && guestReady) {
    return (
      <div className="profile-deletion">
        <p
          ref={successRef}
          className="profile-deletion__status"
          role="status"
          aria-live="polite"
          tabIndex={-1}
        >
          Telegram profile deleted. You are now playing as a guest.
        </p>
      </div>
    );
  }
  if (!telegramReady) return null;

  const visibleView: DeletionView = view.tag === "success" ? { tag: "closed" } : view;
  const open = visibleView.tag !== "closed";
  const pending = visibleView.tag === "pending";

  return (
    <div className="profile-deletion">
      <button
        ref={openerRef}
        type="button"
        aria-expanded={open}
        aria-controls={confirmationId}
        disabled={pending}
        onClick={() => setView(open ? { tag: "closed" } : { tag: "confirming" })}
      >
        Delete Telegram profile
      </button>

      {open ? (
        <section
          id={confirmationId}
          className="profile-deletion__confirmation"
          aria-labelledby={headingId}
          aria-describedby={warningId}
        >
          <h2 ref={headingRef} id={headingId} tabIndex={-1}>
            Delete Telegram profile?
          </h2>
          <p id={warningId}>
            This permanently deletes your A MOVE AGO Telegram profile and all saved attempts,
            hints, and statistics on every device. It does not delete your Telegram account.
            This cannot be undone.
          </p>

          {pending ? (
            <p role="status" aria-live="polite">
              Deleting Telegram profile…
            </p>
          ) : null}
          {visibleView.tag === "error" ? (
            <>
              <p role="alert">
                {visibleView.message}
                {visibleView.requestId ? (
                  <>
                    {" "}Request ID: <code>{visibleView.requestId}</code>
                  </>
                ) : null}
              </p>
              {visibleView.reloadToReauthenticate ? (
                <button type="button" onClick={() => window.location.reload()}>
                  Reload to sign in again
                </button>
              ) : null}
            </>
          ) : null}

          <div className="profile-deletion__actions">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                returnFocusRef.current = true;
                setView({ tag: "closed" });
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="profile-deletion__danger"
              disabled={pending}
              onClick={() => void confirmDeletion()}
            >
              {pending ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 6: Добавить focused destructive styles**

Создать `apps/client/src/styles/profile-deletion.css`:

```css
.profile-deletion {
  border-block-start: 1px solid rgb(245 242 234 / 30%);
  margin-block-start: 2rem;
  padding-block-start: 1.25rem;
}

.profile-deletion__confirmation {
  border: 1px solid #ff8a80;
  border-radius: 0.5rem;
  margin-block-start: 0.75rem;
  max-inline-size: 42rem;
  padding: 1rem;
}

.profile-deletion__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.profile-deletion__actions button {
  min-block-size: 2.75rem;
  padding: 0.625rem 1rem;
}

.profile-deletion__danger {
  border: 1px solid #ffb4ab;
  background: #b42318;
  color: #fff;
  font-weight: 700;
}

.profile-deletion button:focus-visible,
.profile-deletion [tabindex="-1"]:focus {
  outline: 0.2rem solid #8ecaff;
  outline-offset: 0.2rem;
}
```

В `apps/client/src/styles/base.css` добавить:

```css
@import "./profile-deletion.css";
```

- [ ] **Step 7: Подтвердить component GREEN**

Run:

```bash
npm test -w @a-move-ago/client -- src/features/session/ProfileDeletion.test.tsx
npm run typecheck -w @a-move-ago/client
```

Expected: все deletion component tests PASS; typecheck exit `0`.

- [ ] **Step 8: Написать failing App composition test**

Append в `apps/client/src/App.test.tsx`:

```ts
it("keeps deletion mounted through Telegram-to-guest success and refreshes identity data", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  const telegramProfile = {
    telegramUserId: "42",
    displayName: "Deletion Marker Ada",
    username: null,
    avatarUrl: null,
  };
  const emptyStats = {
    attempts: 0,
    hintsUsed: 0,
    solvedPuzzles: 0,
    completedCases: 0,
    currentStreak: 0,
    bestStreak: 0,
    lastCompletedDate: null,
  };
  const guestDaily = { ...daily, title: "Guest case after deletion" };
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile: telegramProfile }));
  runtime.api.getDaily = vi.fn().mockResolvedValueOnce(daily).mockResolvedValueOnce(guestDaily);
  runtime.api.getStats = vi.fn().mockResolvedValueOnce(stats).mockResolvedValueOnce(emptyStats);
  const tokenBefore = runtime.token.get();
  const storedBefore = await runtime.platform.tokenStore.read();

  renderApp(runtime);
  expect(await screen.findByRole("heading", { name: puzzle.title })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Progress" }));
  expect(await screen.findByText("Connected as Deletion Marker Ada")).toBeInTheDocument();
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledOnce());

  await user.click(screen.getByRole("button", { name: "Delete Telegram profile" }));
  expect(runtime.api.deleteProfile).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  const success = await screen.findByText(
    "Telegram profile deleted. You are now playing as a guest.",
  );
  expect(success).toHaveAttribute("role", "status");
  expect(success).toHaveFocus();
  expect(screen.getByText("Playing as a guest")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();
  expect(screen.queryByText("Deletion Marker Ada")).not.toBeInTheDocument();
  await waitFor(() => expect(runtime.api.getStats).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Current streak").nextElementSibling).toHaveTextContent("0");
  expect(screen.getByText("Best streak").nextElementSibling).toHaveTextContent("0");
  expect(runtime.token.get()).toBe(tokenBefore);
  expect(await runtime.platform.tokenStore.read()).toBe(storedBefore);
  expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Back to case" }));
  expect(await screen.findByRole("heading", { name: "Guest case after deletion" })).toBeInTheDocument();
  expect(runtime.api.getDaily).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 9: Compose ProfileDeletion unconditionally on Progress**

В `apps/client/src/App.tsx` импортировать component и поставить после stats без Telegram condition:

```tsx
import { ProfileDeletion } from "./features/session/ProfileDeletion";
```

```tsx
<SaveProgressButton />
{sessionReady ? <StatsPanel refreshKey={identity} title="Statistics" /> : null}
<ProfileDeletion />
```

Существующие `sessionIdentity()` и `DailyCaseGate key={identity}` не менять: переход `telegram:42` → `guest` уже обновляет stats и daily identity. Условие `{me?.kind === "telegram" && <ProfileDeletion />}` запрещено, потому что оно размонтирует local success одновременно с provider transition.

- [ ] **Step 10: Подтвердить App GREEN и full client unit regression**

Run:

```bash
npm test -w @a-move-ago/client -- src/App.test.tsx src/features/session/ProfileDeletion.test.tsx
npm test -w @a-move-ago/client
npm run typecheck -w @a-move-ago/client
```

Expected: focused и full client suites PASS; прежние 146 tests плюс новые cases полностью зелёные.

- [ ] **Step 11: Закоммитить accessible UI**

```bash
git add apps/client/src/features/session/ProfileDeletion.tsx apps/client/src/features/session/ProfileDeletion.test.tsx apps/client/src/styles/profile-deletion.css apps/client/src/styles/base.css apps/client/src/App.tsx apps/client/src/App.test.tsx
git commit -m "feat(client): add accessible profile deletion controls"
```

### Task 7: Покрыть production-like recovery journey и public-artifact privacy

**Files:**

- Modify: `apps/client/e2e/api-mock.ts:1-175`
- Create: `apps/client/e2e/profile-deletion.spec.ts`
- Modify: `apps/client/test/artifact-profile-verifier.ts:1-23`
- Modify: `apps/client/test/artifact-profile-verifier.test.ts:1-83`
- Modify: `apps/client/test/verify-builds.mjs:1-74`

- [ ] **Step 1: Написать stateful API mock contract**

В `apps/client/e2e/api-mock.ts` заменить profile display name на unique synthetic marker и расширить observations/options:

```ts
const profile = {
  telegramUserId: "42",
  displayName: "profile-deletion-e2e-marker",
  username: "ada",
  avatarUrl: null,
};

export interface ApiObservations {
  attemptBodies: Array<Record<string, unknown>>;
  guestChannels: string[];
  hintRequests: Array<{ attemptId: string; level: number }>;
  miniAppProofs: string[];
  statsRequests: number;
  dailyIdentities: Array<"guest" | "telegram">;
  statsIdentities: Array<"guest" | "telegram">;
  profileDeleteRequests: Array<{ authorization: string | null; body: string | null }>;
}

export interface ApiMockOptions {
  loseFirstAttempt?: boolean;
  loseFirstHint?: boolean;
  initialIdentity?: "guest" | "telegram";
  loseFirstProfileDeletionResponse?: boolean;
}
```

Изменить signature на `options: ApiMockOptions = {}`, initialize три новых arrays и state:

```ts
let identity: "guest" | "telegram" = options.initialIdentity ?? "guest";
let profileDeletionResponseLost = false;
```

Preflight exact methods:

```ts
"access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
```

Перед GET `/v1/me` добавить stateful DELETE handler; mock сначала commit'ит identity, затем теряет acknowledgement:

```ts
if (url.pathname === "/v1/me" && request.method() === "DELETE") {
  observed.profileDeleteRequests.push({
    authorization: request.headers()["authorization"] ?? null,
    body: request.postData(),
  });
  identity = "guest";
  if (options.loseFirstProfileDeletionResponse && !profileDeletionResponseLost) {
    profileDeletionResponseLost = true;
    await route.abort("internetdisconnected");
    return;
  }
  await json(route, 200, { kind: "guest", profile: null });
  return;
}
```

В daily handler перед response:

```ts
observed.dailyIdentities.push(identity);
```

Stats handler заменить state-aware payload:

```ts
observed.statsRequests += 1;
observed.statsIdentities.push(identity);
await json(
  route,
  200,
  identity === "telegram"
    ? {
        attempts: 2,
        hintsUsed: 1,
        solvedPuzzles: 7,
        completedCases: 5,
        currentStreak: 4,
        bestStreak: 9,
        lastCompletedDate: "2026-08-03",
      }
    : {
        attempts: 0,
        hintsUsed: 0,
        solvedPuzzles: 0,
        completedCases: 0,
        currentStreak: 0,
        bestStreak: 0,
        lastCompletedDate: null,
      },
);
```

- [ ] **Step 2: Написать happy-path Playwright test**

Создать `apps/client/e2e/profile-deletion.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

const storageKey = "amoveago.session.v1";
const telegramToken = "t".repeat(43);

async function installTelegramToken(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ key, token }) => localStorage.setItem(key, token),
    { key: storageKey, token: telegramToken },
  );
}

test("deletes a restored Telegram profile, preserves its token, and continues as a guest", async ({
  page,
}) => {
  await installTelegramToken(page);
  const observed = await installApiMock(page, { initialIdentity: "telegram" });
  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  expect(observed.guestChannels).toEqual([]);
  expect(observed.dailyIdentities).toEqual(["telegram"]);

  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toBeVisible();
  await expect(
    page.getByText("Current streak").locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("4");
  await page.getByRole("button", { name: "Delete Telegram profile" }).click();
  expect(observed.profileDeleteRequests).toEqual([]);
  await expect(
    page.getByText(/This permanently deletes your A MOVE AGO Telegram profile/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  const success = page.getByRole("status").filter({ hasText: "Telegram profile deleted" });
  await expect(success).toBeVisible();
  await expect(success).toBeFocused();
  await expect(page.getByText("Playing as a guest")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save progress with Telegram" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete Telegram profile" })).toHaveCount(0);
  await expect(page.getByText("profile-deletion-e2e-marker")).toHaveCount(0);
  await expect(
    page.getByText("Current streak").locator("xpath=following-sibling::dd[1]"),
  ).toHaveText("0");
  expect(observed.statsIdentities).toEqual(["telegram", "guest"]);
  expect(observed.profileDeleteRequests).toEqual([
    { authorization: `Bearer ${telegramToken}`, body: null },
  ]);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(telegramToken);

  await page.getByRole("button", { name: "Back to case" }).click();
  await expect(page.getByRole("heading", { name: "A pawn vanished" })).toBeVisible();
  expect(observed.dailyIdentities).toEqual(["telegram", "guest"]);
  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "e4, empty" }).click();
  await page.getByLabel("Captured piece").selectOption("p");
  await page.getByRole("button", { name: "Submit retraction" }).click();
  await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
});
```

- [ ] **Step 3: Написать lost-response Playwright test**

Append:

```ts
test("retries safely after the first committed deletion response is lost", async ({ page }) => {
  await installTelegramToken(page);
  const observed = await installApiMock(page, {
    initialIdentity: "telegram",
    loseFirstProfileDeletionResponse: true,
  });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("button", { name: "Progress" }).click();
  await page.getByRole("button", { name: "Delete Telegram profile" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    /could not be confirmed.*Retry to check the current profile state/i,
  );
  await expect(page.getByText("Connected as profile-deletion-e2e-marker")).toBeVisible();
  await expect(page.getByText(/now playing as a guest/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete permanently" })).toBeEnabled();

  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Telegram profile deleted" }),
  ).toBeVisible();
  expect(observed.profileDeleteRequests).toEqual([
    { authorization: `Bearer ${telegramToken}`, body: null },
    { authorization: `Bearer ${telegramToken}`, body: null },
  ]);
  expect(observed.statsIdentities).toEqual(["telegram", "guest"]);
  expect(await page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(telegramToken);
});
```

- [ ] **Step 4: Собрать Pages, запустить E2E и подтвердить GREEN**

Run:

```bash
VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client
npm run e2e -w @a-move-ago/client -- e2e/profile-deletion.spec.ts
```

Expected: `2 passed`; весь test обслуживается из реального `dist/pages`, а mock получает один DELETE в happy path и два одинаково авторизованных DELETE в lost-response path.

- [ ] **Step 5: Закоммитить E2E journey**

```bash
git add apps/client/e2e/api-mock.ts apps/client/e2e/profile-deletion.spec.ts
git commit -m "test(client): cover profile deletion recovery journeys"
```

- [ ] **Step 6: Написать failing public-artifact marker tests**

В `artifact-profile-verifier.test.ts` импортировать `verifyNoSensitiveArtifactMarkers` и append:

```ts
it("accepts runtime field names without embedded credential values", () => {
  expect(() =>
    verifyNoSensitiveArtifactMarkers(
      "authorization telegramUserId displayName Bearer runtimeValue",
    ),
  ).not.toThrow();
});

it.each([
  `Bearer ${"s".repeat(43)}`,
  `Bearer ${"s".repeat(42)}-`,
  `Bearer ${"s".repeat(42)}_`,
  "SESSION_PEPPER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OIDC_CLIENT_SECRET",
  "CLOUDFLARE_API_TOKEN",
  "test-session-pepper-at-least-32-bytes",
  "123456:test-bot-secret",
  "test-oidc-client-secret",
  "profile-deletion-e2e-marker",
  "query_id=raw%2Bproof&hash=unchanged",
])("rejects sensitive static artifact marker %j", (marker) => {
  expect(() => verifyNoSensitiveArtifactMarkers(`bundle ${marker} bundle`)).toThrow(
    "Production artifact contains a sensitive static marker",
  );
});
```

Run:

```bash
npm test -w @a-move-ago/client -- test/artifact-profile-verifier.test.ts
```

Expected: FAIL на отсутствующем `verifyNoSensitiveArtifactMarkers` export.

- [ ] **Step 7: Реализовать narrow sensitive-marker gate**

Append в `artifact-profile-verifier.ts`:

```ts
const sensitiveArtifactMarkers = [
  /\bBearer [A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /SESSION_PEPPER|TELEGRAM_BOT_TOKEN|TELEGRAM_OIDC_CLIENT_SECRET|CLOUDFLARE_API_TOKEN/,
  /test-session-pepper-at-least-32-bytes|123456:test-bot-secret|test-oidc-client-secret/,
  /profile-deletion-e2e-marker|query_id=raw%2Bproof&hash=unchanged/,
];

export function verifyNoSensitiveArtifactMarkers(contents: string): void {
  if (sensitiveArtifactMarkers.some((pattern) => pattern.test(contents))) {
    throw new Error("Production artifact contains a sensitive static marker.");
  }
}
```

Не запрещать field names `telegramUserId`, `displayName`, `authorization` или слово `Bearer` без static credential: production runtime закономерно содержит эти строки.

- [ ] **Step 8: Подключить gate к обоим production profiles**

В `verify-builds.mjs` расширить import:

```js
import {
  verifyNoSensitiveArtifactMarkers,
  verifyPlatformArtifactMarkers,
} from "./artifact-profile-verifier.ts";
```

После сборки `bundles`, до final `console.log`, рекурсивно прочитать все deployable text assets обоих profiles, а не только entry HTML/JavaScript:

```js
const profileDirectories = [
  new URL("../dist/pages/", import.meta.url),
  new URL("../dist/android/", import.meta.url),
];
const profileEntries = await Promise.all(
  profileDirectories.map((directory) => readdir(directory, { recursive: true })),
);
const deployableTextPattern = /\.(?:html|js|css|json|txt|webmanifest|svg)$/i;
const deployableText = await Promise.all(
  profileDirectories.flatMap((directory, index) =>
    (profileEntries[index] ?? [])
      .filter((name) => deployableTextPattern.test(name))
      .map((name) => readFile(new URL(name, directory), "utf8")),
  ),
);
verifyNoSensitiveArtifactMarkers(deployableText.join("\n"));
```

- [ ] **Step 9: Пересобрать оба artifacts и подтвердить privacy gate**

Run:

```bash
npm test -w @a-move-ago/client -- test/artifact-profile-verifier.test.ts
VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client
VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client
npm run verify:artifacts -w @a-move-ago/client
```

Expected: unit suite PASS; verifier prints `Pages and Android web artifacts verified.`; neither `dist` directory becomes tracked.

- [ ] **Step 10: Закоммитить artifact gate**

```bash
git add apps/client/test/artifact-profile-verifier.ts apps/client/test/artifact-profile-verifier.test.ts apps/client/test/verify-builds.mjs
git commit -m "test(client): reject sensitive markers in production artifacts"
```

### Task 8: Обновить public documentation и выполнить полный release-quality gate

**Files:**

- Modify: `README.md:118-139,194`
- Modify: `PRIVACY.md:3-101`

- [ ] **Step 1: Документировать пользовательский deletion flow**

В `README.md` после `Guest-first Telegram authentication` section и перед `Configuration` вставить:

```markdown
## Delete a Telegram profile

A player with a linked Telegram profile can open **Progress**, choose **Delete
Telegram profile**, review the permanent-deletion warning, and choose **Delete
permanently**. A confirmed deletion removes the A MOVE AGO Telegram profile,
saved attempts, hint history, and derived statistics on every device. It does
not delete the player's Telegram account and cannot be undone.

The authenticated API operation is `DELETE /v1/me`. It has no request body and
returns `{"kind":"guest","profile":null}` with `Cache-Control: no-store`.
After the Worker confirms deletion, the current app continues as an empty guest
with the same opaque session token; other sessions linked to the deleted
profile stop working. An unconfirmed response is never shown as success. An
interrupted transport response or invalid success payload can be
retried with the same token while that session remains active. A `401
INVALID_SESSION` is not deletion proof: reload the app to bootstrap an
available guest session, then explicitly choose **Save progress with Telegram**
to verify the profile.

A later explicit **Save progress with Telegram** creates a new profile. Deleted
profile progress is not restored, although progress accumulated independently
after deletion can be linked normally.
```

- [ ] **Step 2: Добавить production deletion smoke gate**

Перед `## Implementation references` вставить:

```markdown
## Production release gate

Before opening the public Pages version, the operator must verify all of these
against the deployed Worker and production D1:

- Cloudflare bindings, Telegram configuration, exact origins, callbacks, and
  current daily content are production-ready.
- A synthetic Telegram account has attempt and hint history from at least two
  linked sessions.
- The deployed UI completes both deletion steps and returns the current client
  to guest without changing its opaque token.
- Reloaded guest statistics contain none of the deleted profile history, daily
  gameplay still works, and the other linked session no longer reaches the old
  profile.
- Response and application logs for the deletion request ID contain no bearer
  token, Telegram fields, request body, SQL details, or deleted-row counts.
- Actual platform-log and backup retention is configured and disclosed, and a
  restore drill does not reintroduce deleted profile rows into active D1.
- GitHub Private Vulnerability Reporting and the private process documented in
  `SECURITY.md` are available.
```

- [ ] **Step 3: Replace stale privacy status and enumerate retained session fields**

В `PRIVACY.md`, заменить последний sentence `Status and scope` на:

```markdown
Deployment operators must replace placeholder configuration, configure and
disclose actual platform-log and backup retention, and pass the production
release gate before representing the service as publicly launched.
```

После guest-token storage paragraph добавить:

```markdown
After a linked Telegram profile is deleted, the current opaque token is not
replaced. Its online D1 session becomes an active unlinked guest session and
retains the session ID, token hash, `kind = guest`, channel, creation time,
expiry time, revocation field, and last-seen time. Its `player_id` and
`rotated_from_session_id` are null.

Previously revoked pseudonymous guest predecessor sessions can remain until
scheduled cleanup. They retain their own session ID, token hash, `kind =
guest`, channel, creation time, expiry time, revocation time, and last-seen
time. A predecessor can retain `rotated_from_session_id` pointing only to an
earlier pseudonymous guest session. These rows have no `player_id`, Telegram
identity, or attempts belonging to the deleted profile.
```

- [ ] **Step 4: Make progress retention and platform limits exact**

После existing Telegram progress-link paragraph добавить:

```markdown
Profile deletion removes every attempt linked to the deleted player, including
attempts first created as guest progress and later attached to that profile.
Related hint events and derived statistics disappear with those attempts.
Attempts accumulated independently by an unlinked guest after deletion remain
guest data and can be attached only by a later explicit Telegram sign-in.
```

Заменить final platform-retention paragraph в `Retention` на:

```markdown
Profile deletion removes the active online D1 records immediately. It does not
promise immediate physical erasure from Cloudflare platform logs, GitHub
delivery logs, or operator backups, which can have separate retention set by
the deployment operator. A public operator must configure and disclose those
periods and must ensure that restoring a backup does not reintroduce deleted
profile rows into the active service.
```

- [ ] **Step 5: Replace release blocker with implemented player controls**

Заменить весь `## Player controls and deletion requirement` section, сохранив final private-security-report sentence после нового текста:

```markdown
## Player controls and profile deletion

Logging out revokes the current app session and returns the client to a new
guest session. Clearing local storage removes the local guest token, but
neither action by itself deletes a linked Telegram profile.

A linked player can open **Progress**, choose **Delete Telegram profile**,
review the permanent warning, and choose **Delete permanently**. The
authenticated `DELETE /v1/me` immediately and irreversibly removes from active
online D1 the Telegram profile fields, every other Telegram session linked to
that player, player-linked attempts, their hint events, linked auth flows, and
derived statistics. The current token survives only as an empty unlinked guest
session. The operation does not delete the Telegram account, Telegram-hosted
content, chess content, or content-import history.

The client reports success only after a guest-only Worker response. A network
or contract failure remains unconfirmed and can be retried with the same token
while that session remains active; it is never presented as successful
deletion. An `INVALID_SESSION` response instead requires an app
reload/bootstrap before the player explicitly signs in with Telegram to verify
the profile. A later explicit **Save progress with Telegram** creates a new
profile and never restores deleted profile data.

An OIDC flow started before deletion but not yet linked to the profile, or a
Mini App login already running from another guest session, can still finish
after deletion and create a new profile. This is a new account-creation event:
deleted profile data is not restored, although independently accumulated
progress from that separate guest session can be linked.

Security vulnerabilities involving personal data should be reported privately
as described in [SECURITY.md](SECURITY.md).
```

- [ ] **Step 6: Verify documentation wording and whitespace**

Run:

```bash
rg -n "DELETE /v1/me|same opaque session token|Production release gate" README.md
rg -n "rotated_from_session_id|active online D1|new account-creation event|does not delete the Telegram account" PRIVACY.md
rg -n "current repository does not yet expose|profile-deletion path described below" PRIVACY.md
git diff --check
```

Expected: первые два commands находят новые disclosures; третий command возвращает exit `1` без matches; `git diff --check` возвращает exit `0`.

- [ ] **Step 7: Закоммитить public documentation**

```bash
git add README.md PRIVACY.md
git commit -m "docs: document Telegram profile deletion"
```

- [ ] **Step 8: Запустить repository static, type и unit gates**

Run с Node 24/npm 11:

```bash
npm run check
npm run typecheck
npm test
npm run content:validate
```

Expected: каждый command exit `0`; API contract, API, client, game-core, platform и tools suites полностью PASS. Не принимать partial workspace run вместо root `npm test`.

- [ ] **Step 9: Собрать Worker и оба client profiles**

Run:

```bash
npm run build -w @a-move-ago/api
VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client
VITE_API_BASE_URL=https://api.test VITE_ANDROID_ALLOW_DEBUG_SCHEME=true npm run build:android:web -w @a-move-ago/client
npm run verify:artifacts -w @a-move-ago/client
```

Expected: Worker dry-run build exit `0`; Pages и Android web builds exit `0`; artifact verifier печатает `Pages and Android web artifacts verified.`. В artifacts нет source maps, known previous-position answer, credentials или deletion profile marker.

- [ ] **Step 10: Запустить весь production-like Playwright gate**

Run:

```bash
npm run e2e -w @a-move-ago/client
```

Expected: `5 passed` — три прежних cases и два profile-deletion cases; retries CI не нужны для локального GREEN.

- [ ] **Step 11: Проверить tracked tree и commit sequence**

Run:

```bash
git diff --check
git status --short
git log --oneline -10
```

Expected: `git diff --check` exit `0`; `git status --short` пуст; последние commits разделяют contract, atomic service, HTTP boundary, race evidence, client session, accessible UI, E2E, artifact privacy и documentation по шагам плана. `dist`, Playwright reports/traces, `.dev.vars`, tokens, APK/AAB и keystore не tracked.

## Acceptance traceability

| Spec boundary | Реализующая задача | Обязательное доказательство |
| --- | --- | --- |
| Guest-only `DELETE /v1/me` | 1, 3 | contract rejects Telegram-shaped `200`; exact bodyless request |
| Atomic current-session detach + cascade | 2 | real D1 graph assertions; `IGNORE`/`ABORT` rollback guards |
| Repeat/concurrency/lost acknowledgement | 2, 4, 7 | same-token `200/200`; linked-token `200/401`; D1 and HTTP lost-response tests |
| Exact origin + limiter precedence | 3 | `401` → `403` → `429`/service order and exact preflight |
| Retained pseudonymous session inventory | 2, 8 | current/predecessor row assertions and explicit privacy fields |
| Late OIDC/Mini App trade-off | 4, 8 | both commit orders; only independent guest progress transfers |
| Telegram → guest client lifecycle | 5, 6 | provider single-flight, unchanged token, refreshed stats/daily |
| Fresh sign-in after deletion | 5 | new distinct handoff accepted after ref reset |
| Accessible two-step destructive UI | 6 | disclosure semantics, keyboard order, focus, live status/alert |
| Public artifact/log/response privacy | 3, 7 | structured-log test, guest-only payload, static marker gate |
| Public operational disclosure | 8 | README smoke gate and PRIVACY retention/backup wording |

Implementation считается завершённой только после всех checkbox steps, clean final tree и независимого spec-compliance/code-quality review каждого task commit.
