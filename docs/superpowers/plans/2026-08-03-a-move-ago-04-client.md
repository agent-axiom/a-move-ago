# A MOVE AGO Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собрать один React 19 UI для GitHub Pages и будущей Android-оболочки, адаптировать Pages artifact к обычному web и Telegram Mini App и реализовать гостевой игровой цикл от загрузки daily case до подсказок, reveal и статистики.

**Architecture:** `apps/client` импортирует только типизированный `@a-move-ago/api-contract`, чистый `@a-move-ago/game-core` и host-neutral `@a-move-ago/platform`. Навигация и игровые переходы представлены небольшими pure reducers; сетевые effects живут в controller hooks, а правильный ответ появляется в клиенте только после successful attempt response. Один source собирается в `dist/pages` с `base: /a-move-ago/` и в `dist/android` с `base: /`; Capacitor adapter и native project добавляет план 5.

**Tech Stack:** React 19.2.8, React DOM 19.2.8, Vite 8.1.5, `@vitejs/plugin-react` 6.0.5, TypeScript 7, Zod 4, Vitest 4, React Testing Library 16.3.2, Playwright 1.62.1.

---

**Порядок:** план 4 из 5. Требует завершённые планы 1–3; после него выполнять `05-android-delivery`. План 5 добавляет Capacitor packages, Android adapter, Preferences, Browser, App Links и native build; этот план создаёт только Android web artifact.

## Карта файлов

- `packages/api-contract/src/client.ts` — единственный validated fetch client и typed transport errors.
- `packages/platform/src/types.ts` — UI-neutral host contract, token storage, back/layout/auth return.
- `packages/platform/src/web/*` — обычный browser adapter и local token storage.
- `packages/platform/src/telegram/*` — Telegram ready/back/safe-area/haptics/raw proof integration.
- `packages/platform/src/factory.ts` — выбор Telegram или web; Android branch добавляется в плане 5.
- `apps/client/vite.config.ts` — разные Pages/Android base и output directories.
- `apps/client/build/telegram-script-plugin.ts` — строгий CSP для обоих artifact и официальный Telegram script только в Pages build, раньше application bundle.
- `apps/client/src/app/runtime.tsx` — dependency injection для API/platform/clock/UUID/sleep.
- `apps/client/src/app/entry-query.ts` — allowlisted `case`/`handoff`, очистка handoff без изменения fragment.
- `apps/client/src/app/navigation.ts` — memory stack; history/hash routing отсутствуют.
- `apps/client/src/features/session/*` — guest bootstrap, Mini App consent, OIDC start и handoff exchange.
- `apps/client/src/features/daily/*` — GET retry, ordered case acts и recoverable content state.
- `apps/client/src/features/game/model/draft.ts` — выбор текущего/предыдущего поля, capture и special retractions.
- `apps/client/src/features/game/model/attempt.ts` — frozen attempt UUID, retry/hint/reveal transitions.
- `apps/client/src/features/game/ui/*` — доступная доска, controls, hints, reveal и live announcements.
- `apps/client/e2e/*` — production-like Pages, Telegram host и sample solve tests.

### Task 1: Создать React/Vite package и два web artifact

**Files:**
- Create: `apps/client/package.json`
- Create: `apps/client/tsconfig.json`
- Create: `apps/client/vitest.config.ts`
- Create: `apps/client/vite.config.ts`
- Create: `apps/client/index.html`
- Create: `apps/client/src/main.tsx`
- Create: `apps/client/src/App.tsx`
- Create: `apps/client/src/styles/base.css`
- Create: `apps/client/test/setup.ts`
- Test: `apps/client/test/build-profile.test.ts`
- Modify: `package-lock.json` through `npm install`

- [ ] **Step 1: Создать package и test harness**

`apps/client/package.json`:

```json
{
  "name": "@a-move-ago/client",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "npm run build:pages",
    "build:android:web": "vite build --mode android",
    "build:pages": "vite build --mode pages",
    "dev": "vite --mode pages",
    "preview:pages": "vite preview --mode pages --host 127.0.0.1",
    "test": "vitest run --config vitest.config.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@a-move-ago/api-contract": "0.0.0",
    "@a-move-ago/game-core": "0.0.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@testing-library/dom": "10.4.1",
    "@testing-library/jest-dom": "7.0.0",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "6.0.5",
    "jsdom": "29.1.1",
    "typescript": "7.0.2",
    "vite": "8.1.5",
    "vitest": "4.1.10"
  }
}
```

`apps/client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["build", "src", "test", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/client/vitest.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    restoreMocks: true,
  },
});
```

`apps/client/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Run: `npm install`

Expected: exit `0`; React/Vite/testing packages appear once in `package-lock.json` without `missing` or `invalid`.

- [ ] **Step 2: Write the failing build-profile test**

`apps/client/test/build-profile.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clientBuildProfile } from "../vite.config";

describe("client build profiles", () => {
  it("uses the repository base for Pages", () => {
    expect(clientBuildProfile("pages")).toEqual({
      base: "/a-move-ago/",
      outDir: "dist/pages",
    });
  });

  it("uses the root base for the Android web artifact", () => {
    expect(clientBuildProfile("android")).toEqual({
      base: "/",
      outDir: "dist/android",
    });
  });
});
```

- [ ] **Step 3: Run RED**

Run: `npm test -w @a-move-ago/client -- test/build-profile.test.ts`

Expected: FAIL because `apps/client/vite.config.ts` does not exist.

- [ ] **Step 4: Implement the two profiles and minimal shell**

`apps/client/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export type ClientBuildMode = "pages" | "android";

export function clientBuildProfile(mode: ClientBuildMode) {
  return mode === "android"
    ? { base: "/", outDir: "dist/android" }
    : { base: "/a-move-ago/", outDir: "dist/pages" };
}

export default defineConfig(({ mode }) => {
  const profile = clientBuildProfile(mode === "android" ? "android" : "pages");
  return {
    base: profile.base,
    plugins: [react()],
    build: {
      outDir: profile.outDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
```

`apps/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#151718" />
    <title>A MOVE AGO</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/client/src/App.tsx`:

```tsx
export function App() {
  return (
    <main className="app-shell">
      <h1>A MOVE AGO</h1>
      <p>Loading today’s case…</p>
    </main>
  );
}
```

`apps/client/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`apps/client/src/styles/base.css`:

```css
:root {
  color-scheme: light dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #151718;
  color: #f5f2ea;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  min-height: 100%;
  margin: 0;
}

button {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  padding: 1rem;
}
```

- [ ] **Step 5: Run GREEN and build both artifacts**

Run: `npm test -w @a-move-ago/client -- test/build-profile.test.ts`

Expected: PASS, 2 tests.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

Run: `npm run build:pages -w @a-move-ago/client`

Expected: exit `0`; `apps/client/dist/pages/index.html` exists.

Run: `npm run build:android:web -w @a-move-ago/client`

Expected: exit `0`; both `apps/client/dist/pages/index.html` and `apps/client/dist/android/index.html` exist.

- [ ] **Step 6: Commit**

```bash
git add apps/client package.json package-lock.json
git commit -m "feat: scaffold shared React client"
```

### Task 2: Добавить validated typed API client

**Files:**
- Create: `packages/api-contract/src/client.ts`
- Modify: `packages/api-contract/src/index.ts`
- Test: `packages/api-contract/src/client.test.ts`

- [ ] **Step 1: Write failing transport tests**

`packages/api-contract/src/client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiContractError, ApiError, ApiTransportError, createApiClient } from "./client";

const session = {
  token: "x".repeat(43),
  expiresAt: "2026-11-01T00:00:00.000Z",
  kind: "guest" as const,
};

describe("ApiClient", () => {
  it("issues an anonymous guest session with the selected channel", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(session, { status: 201 }));
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => null,
    });

    await expect(api.createGuest("web")).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v1/sessions/guest",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ channel: "web" }) }),
    );
  });

  it("reuses the exact attempt UUID in the serialized request", async () => {
    const result = {
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false as const,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another retraction." },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(result, { status: 201 }));
    const api = createApiClient({
      baseUrl: "https://api.test",
      fetch,
      getToken: () => "guest-token",
    });
    const request = {
      attemptUuid: result.attemptUuid,
      caseId: "case-2026-08-03",
      puzzleId: "opening-exd5",
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: { color: "b", type: "p", square: "d5" },
        special: "normal",
      },
    } as const;

    await api.submitAttempt(request);
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ authorization: "Bearer guest-token" });
    expect(JSON.parse(String(init.body))).toEqual(request);
  });

  it("maps error envelopes and transport failures separately", async () => {
    const denied = vi.fn().mockResolvedValue(
      Response.json(
        { error: { code: "INVALID_SESSION", message: "Expired.", requestId: "req-1" } },
        { status: 401 },
      ),
    );
    const api = createApiClient({ baseUrl: "https://api.test", fetch: denied, getToken: () => "x" });
    await expect(api.getMe()).rejects.toEqual(
      new ApiError(401, "INVALID_SESSION", "Expired.", "req-1", null),
    );

    const offline = createApiClient({
      baseUrl: "https://api.test",
      fetch: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      getToken: () => "x",
    });
    await expect(offline.getMe()).rejects.toBeInstanceOf(ApiTransportError);
  });

  it("rejects a validly shaped response for a different attempt UUID", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "33333333-3333-4333-8333-333333333333",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try again." },
    }, { status: 201 }));
    const api = createApiClient({ baseUrl: "https://api.test", fetch, getToken: () => "guest" });
    await expect(api.submitAttempt({
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      caseId: "case-2026-08-03",
      puzzleId: "opening-exd5",
      retraction: {
        currentSquare: "d5",
        previousSquare: "e4",
        movedPiece: { color: "w", type: "p" },
        restoredPiece: null,
        special: "normal",
      },
    })).rejects.toBeInstanceOf(ApiContractError);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/api-contract -- src/client.test.ts`

Expected: FAIL because `./client` does not exist.

- [ ] **Step 3: Implement the gameplay/session client**

`packages/api-contract/src/client.ts`:

```ts
import type { z } from "zod";
import {
  AttemptRequestSchema,
  AttemptResultSchema,
  DailyCaseResponseSchema,
  ErrorEnvelopeSchema,
  GuestSessionRequestSchema,
  HintRequestSchema,
  HintResponseSchema,
  MeResponseSchema,
  SessionIssuedSchema,
  StatsResponseSchema,
} from "./api";

type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
type ClientChannel = z.infer<typeof GuestSessionRequestSchema>["channel"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiTransportError extends Error {
  constructor(override readonly cause: unknown) {
    super("The API could not be reached.");
    this.name = "ApiTransportError";
  }
}

export class ApiContractError extends Error {
  constructor(override readonly cause: unknown) {
    super("The API returned an invalid response.");
    this.name = "ApiContractError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken: () => string | null;
}

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function request<TSchema extends z.ZodType>(input: {
    method: "GET" | "POST";
    path: string;
    responseSchema: TSchema;
    body?: unknown;
    authenticated?: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<z.infer<TSchema>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (input.body !== undefined) headers["content-type"] = "application/json";
    if (input.authenticated !== false) {
      const token = options.getToken();
      if (!token) throw new ApiError(401, "MISSING_SESSION", "No app session is available.", "client", null);
      headers.authorization = `Bearer ${token}`;
    }

    const init: RequestInit = {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${input.path}`, init);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new ApiTransportError(error);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const envelope = ErrorEnvelopeSchema.safeParse(payload);
      if (!envelope.success) throw new ApiContractError(envelope.error);
      const retryAfter = response.headers.get("retry-after");
      throw new ApiError(
        response.status,
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.requestId,
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null,
      );
    }

    const parsed = input.responseSchema.safeParse(payload);
    if (!parsed.success) throw new ApiContractError(parsed.error);
    return parsed.data;
  }

  return {
    createGuest(channel: ClientChannel, signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/sessions/guest",
        body: GuestSessionRequestSchema.parse({ channel }),
        responseSchema: SessionIssuedSchema,
        authenticated: false,
        signal,
      });
    },
    getMe(signal?: AbortSignal) {
      return request({ method: "GET", path: "/v1/me", responseSchema: MeResponseSchema, signal });
    },
    getDaily(date?: string, signal?: AbortSignal) {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      return request({ method: "GET", path: `/v1/daily${query}`, responseSchema: DailyCaseResponseSchema, signal });
    },
    submitAttempt(body: AttemptRequest, signal?: AbortSignal) {
      const parsed = AttemptRequestSchema.parse(body);
      return request({
        method: "POST",
        path: "/v1/attempts",
        body: parsed,
        responseSchema: AttemptResultSchema,
        signal,
      }).then((result) => {
        if (result.attemptUuid !== parsed.attemptUuid) {
          throw new ApiContractError("Attempt response UUID did not match the request.");
        }
        return result;
      });
    },
    requestHint(attemptId: string, level: number, signal?: AbortSignal) {
      const parsed = HintRequestSchema.parse({ level });
      return request({
        method: "POST",
        path: `/v1/attempts/${encodeURIComponent(attemptId)}/hints`,
        body: parsed,
        responseSchema: HintResponseSchema,
        signal,
      }).then((result) => {
        if (result.level !== parsed.level) {
          throw new ApiContractError("Hint response level did not match the request.");
        }
        return result;
      });
    },
    getStats(signal?: AbortSignal) {
      return request({ method: "GET", path: "/v1/me/stats", responseSchema: StatsResponseSchema, signal });
    },
    logout(signal?: AbortSignal) {
      return request({ method: "POST", path: "/v1/auth/logout", responseSchema: SessionIssuedSchema, signal });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
```

Append to `packages/api-contract/src/index.ts`:

```ts
export * from "./client";
```

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/api-contract -- src/client.test.ts`

Expected: PASS, 4 tests.

Run: `npm run typecheck -w @a-move-ago/api-contract`

Expected: exit `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/api-contract/src/client.ts packages/api-contract/src/client.test.ts packages/api-contract/src/index.ts
git commit -m "feat: add validated API client"
```

### Task 3: Создать web и Telegram platform adapters

**Files:**
- Create: `packages/platform/package.json`
- Create: `packages/platform/tsconfig.json`
- Create: `packages/platform/src/types.ts`
- Create: `packages/platform/src/web/token-store.ts`
- Create: `packages/platform/src/web/web-adapter.ts`
- Create: `packages/platform/src/telegram/telegram-types.ts`
- Create: `packages/platform/src/telegram/telegram-adapter.ts`
- Create: `packages/platform/src/factory.ts`
- Create: `packages/platform/src/index.ts`
- Create: `packages/platform/src/platform.test.ts`
- Create: `apps/client/build/telegram-script-plugin.ts`
- Test: `apps/client/build/telegram-script-plugin.test.ts`
- Modify: `apps/client/package.json`
- Modify: `apps/client/vite.config.ts`
- Modify: `package-lock.json` through `npm install`

- [ ] **Step 1: Create the platform package and contract**

`packages/platform/package.json`:

```json
{
  "name": "@a-move-ago/platform",
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
  "devDependencies": {
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

`packages/platform/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

`packages/platform/src/types.ts`:

```ts
export type PlatformKind = "web" | "telegram" | "android";
export type ClientChannel = "web" | "telegram" | "android";
export type AuthMode = "oidc-web" | "mini-app" | "oidc-android";
export type HapticKind = "selection" | "success" | "error";

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TelegramProof {
  kind: "telegram-mini-app";
  initData: string;
}

export interface AuthReturnPort {
  initialUrl(): Promise<string | null>;
  subscribe(listener: (url: string) => void): Promise<() => void>;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly channel: ClientChannel;
  readonly authMode: AuthMode;
  readonly tokenStore: TokenStore;
  readonly authReturn: AuthReturnPort;
  ready(): Promise<void>;
  installLayoutVars(target: HTMLElement): () => void;
  setBackHandler(handler: (() => void) | null): Promise<void>;
  haptic(kind: HapticKind): Promise<void>;
  openExternal(url: string): Promise<void>;
  openAuthorization(url: string): Promise<void>;
  requestTelegramProof(input: {
    reason: "save-progress";
    userInitiatedAt: number;
  }): Promise<TelegramProof | null>;
}
```

- [ ] **Step 2: Write failing adapter tests**

`packages/platform/src/platform.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPlatformAdapter } from "./factory";
import type { TelegramWebAppLike } from "./telegram/telegram-types";
import type { PlatformAdapter } from "./types";

function browserPort() {
  const values = new Map<string, string>();
  return {
    href: () => "https://agent-axiom.github.io/a-move-ago/#tgWebAppData=kept",
    height: () => 700,
    addResizeListener: vi.fn(),
    removeResizeListener: vi.fn(),
    open: vi.fn(),
    navigate: vi.fn(),
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

function telegramFake() {
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const fake = {
    platform: "android",
    initData: "query_id=raw%2Bproof&hash=unchanged",
    viewportStableHeight: 640,
    safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 },
    contentSafeAreaInset: { top: 48, right: 0, bottom: 20, left: 0 },
    ready: vi.fn(),
    openLink: vi.fn(),
    BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
    HapticFeedback: { selectionChanged: vi.fn(), notificationOccurred: vi.fn() },
    onEvent: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      const handlers = events.get(name) ?? new Set();
      handlers.add(handler);
      events.set(name, handlers);
    }),
    offEvent: vi.fn((name: string, handler: (...args: unknown[]) => void) => {
      events.get(name)?.delete(handler);
    }),
    emit(name: string, value?: unknown) {
      for (const handler of events.get(name) ?? []) handler(value);
    },
  };
  return fake as unknown as TelegramWebAppLike & { emit(name: string, value?: unknown): void };
}

describe("platform adapters", () => {
  it("uses web storage and browser navigation outside Telegram", async () => {
    const browser = browserPort();
    const adapter = await createPlatformAdapter({ browser });
    expect(adapter.kind).toBe("web");
    await adapter.tokenStore.write("guest-token");
    expect(await adapter.tokenStore.read()).toBe("guest-token");
    await adapter.openAuthorization("https://oauth.telegram.org/auth?state=server-state");
    expect(browser.navigate).toHaveBeenCalledWith("https://oauth.telegram.org/auth?state=server-state");
  });

  it("wires Telegram ready, back, stable layout and raw proof", async () => {
    const browser = browserPort();
    const telegram = telegramFake();
    const adapter = await createPlatformAdapter({ browser, telegram });
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement;
    const back = vi.fn();

    await adapter.ready();
    await adapter.ready();
    await adapter.setBackHandler(back);
    const dispose = adapter.installLayoutVars(root);

    expect(telegram.ready).toHaveBeenCalledOnce();
    expect(telegram.BackButton.show).toHaveBeenCalledOnce();
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("640px");
    expect(root.style.getPropertyValue("--host-content-safe-top")).toBe("48px");
    expect(await adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 })).toEqual({
      kind: "telegram-mini-app",
      initData: "query_id=raw%2Bproof&hash=unchanged",
    });

    telegram.viewportStableHeight = 720;
    telegram.emit("viewportChanged", { isStateStable: true });
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("720px");
    dispose();
    expect(telegram.offEvent).toHaveBeenCalled();
  });

  it("awaits an optional Android loader before inspecting browser host hints", async () => {
    const android = { kind: "android" } as PlatformAdapter;
    const loadAndroid = vi.fn().mockResolvedValue(android);
    await expect(createPlatformAdapter({
      browser: browserPort(),
      telegram: telegramFake(),
      loadAndroid,
    })).resolves.toBe(android);
    expect(loadAndroid).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run adapter tests RED**

Run: `npm test -w @a-move-ago/platform`

Expected: FAIL because platform implementations do not exist; the Android-loader test also fixes the lazy seam that plan 5 will populate without a static Capacitor import.

- [ ] **Step 4: Implement browser ports, token store and web adapter**

`packages/platform/src/web/token-store.ts`:

```ts
import type { TokenStore } from "../types";

export const SESSION_TOKEN_KEY = "amoveago.session.v1";

export function createWebTokenStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): TokenStore {
  return {
    async read() {
      return storage.getItem(SESSION_TOKEN_KEY);
    },
    async write(token) {
      storage.setItem(SESSION_TOKEN_KEY, token);
    },
    async clear() {
      storage.removeItem(SESSION_TOKEN_KEY);
    },
  };
}
```

`packages/platform/src/web/web-adapter.ts`:

```ts
import type { PlatformAdapter } from "../types";
import { createWebTokenStore } from "./token-store";

export interface BrowserPort {
  href(): string;
  height(): number;
  addResizeListener(listener: () => void): void;
  removeResizeListener(listener: () => void): void;
  open(url: string): void;
  navigate(url: string): void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export function createWebAdapter(browser: BrowserPort): PlatformAdapter {
  return {
    kind: "web",
    channel: "web",
    authMode: "oidc-web",
    tokenStore: createWebTokenStore(browser.storage),
    authReturn: {
      async initialUrl() {
        return browser.href();
      },
      async subscribe() {
        return () => undefined;
      },
    },
    async ready() {},
    installLayoutVars(target) {
      const update = () => {
        target.style.setProperty("--host-stable-height", `${browser.height()}px`);
        for (const edge of ["top", "right", "bottom", "left"]) {
          target.style.setProperty(`--host-safe-${edge}`, `env(safe-area-inset-${edge}, 0px)`);
          target.style.setProperty(`--host-content-safe-${edge}`, "0px");
        }
      };
      update();
      browser.addResizeListener(update);
      return () => browser.removeResizeListener(update);
    },
    async setBackHandler() {},
    async haptic() {},
    async openExternal(url) {
      browser.open(url);
    },
    async openAuthorization(url) {
      browser.navigate(url);
    },
    async requestTelegramProof() {
      return null;
    },
  };
}
```

- [ ] **Step 5: Implement the minimal Telegram JS surface and adapter**

`packages/platform/src/telegram/telegram-types.ts`:

```ts
export interface TelegramInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TelegramWebAppLike {
  platform: string;
  initData: string;
  viewportStableHeight: number;
  safeAreaInset: TelegramInsets;
  contentSafeAreaInset: TelegramInsets;
  ready(): void;
  openLink(url: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  HapticFeedback: {
    selectionChanged(): void;
    notificationOccurred(type: "success" | "error"): void;
  };
  onEvent(name: string, handler: (...args: unknown[]) => void): void;
  offEvent(name: string, handler: (...args: unknown[]) => void): void;
}
```

`packages/platform/src/telegram/telegram-adapter.ts`:

```ts
import type { PlatformAdapter } from "../types";
import type { BrowserPort } from "../web/web-adapter";
import { createWebTokenStore } from "../web/token-store";
import type { TelegramInsets, TelegramWebAppLike } from "./telegram-types";

function setInsets(target: HTMLElement, prefix: string, insets: TelegramInsets) {
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    target.style.setProperty(`--host-${prefix}-${edge}`, `${insets[edge]}px`);
  }
}

export function createTelegramAdapter(
  browser: BrowserPort,
  telegram: TelegramWebAppLike,
): PlatformAdapter {
  let didReady = false;
  let currentBack: (() => void) | null = null;
  return {
    kind: "telegram",
    channel: "telegram",
    authMode: "mini-app",
    tokenStore: createWebTokenStore(browser.storage),
    authReturn: {
      async initialUrl() {
        return browser.href();
      },
      async subscribe() {
        return () => undefined;
      },
    },
    async ready() {
      if (didReady) return;
      didReady = true;
      telegram.ready();
    },
    installLayoutVars(target) {
      const update = () => {
        target.style.setProperty("--host-stable-height", `${telegram.viewportStableHeight}px`);
        setInsets(target, "safe", telegram.safeAreaInset);
        setInsets(target, "content-safe", telegram.contentSafeAreaInset);
      };
      const stableViewport = (event: unknown) => {
        if ((event as { isStateStable?: boolean } | undefined)?.isStateStable) update();
      };
      update();
      telegram.onEvent("viewportChanged", stableViewport);
      telegram.onEvent("safeAreaChanged", update);
      telegram.onEvent("contentSafeAreaChanged", update);
      return () => {
        telegram.offEvent("viewportChanged", stableViewport);
        telegram.offEvent("safeAreaChanged", update);
        telegram.offEvent("contentSafeAreaChanged", update);
      };
    },
    async setBackHandler(handler) {
      if (currentBack) telegram.BackButton.offClick(currentBack);
      currentBack = handler;
      if (handler) {
        telegram.BackButton.onClick(handler);
        telegram.BackButton.show();
      } else {
        telegram.BackButton.hide();
      }
    },
    async haptic(kind) {
      if (kind === "selection") telegram.HapticFeedback.selectionChanged();
      else telegram.HapticFeedback.notificationOccurred(kind);
    },
    async openExternal(url) {
      telegram.openLink(url);
    },
    async openAuthorization() {
      throw new Error("Telegram Mini Apps authenticate with initData, not OIDC redirect.");
    },
    async requestTelegramProof() {
      return telegram.initData.length > 0
        ? { kind: "telegram-mini-app", initData: telegram.initData }
        : null;
    },
  };
}
```

- [ ] **Step 6: Implement the factory and public exports**

`packages/platform/src/factory.ts`:

```ts
import { createTelegramAdapter } from "./telegram/telegram-adapter";
import type { TelegramWebAppLike } from "./telegram/telegram-types";
import type { PlatformAdapter } from "./types";
import { createWebAdapter, type BrowserPort } from "./web/web-adapter";

export async function createPlatformAdapter(input: {
  browser: BrowserPort;
  telegram?: TelegramWebAppLike | undefined;
  loadAndroid?: (() => Promise<PlatformAdapter | null>) | undefined;
}): Promise<PlatformAdapter> {
  const android = await input.loadAndroid?.();
  if (android) return android;
  if (input.telegram && input.telegram.platform !== "unknown") {
    return createTelegramAdapter(input.browser, input.telegram);
  }
  return createWebAdapter(input.browser);
}

export function browserPortFromWindow(browserWindow: Window): BrowserPort {
  return {
    href: () => browserWindow.location.href,
    height: () => browserWindow.innerHeight,
    addResizeListener: (listener) => browserWindow.addEventListener("resize", listener),
    removeResizeListener: (listener) => browserWindow.removeEventListener("resize", listener),
    open: (url) => {
      browserWindow.open(url, "_blank", "noopener,noreferrer");
    },
    navigate: (url) => browserWindow.location.assign(url),
    storage: browserWindow.localStorage,
  };
}
```

`packages/platform/src/index.ts`:

```ts
export * from "./factory";
export * from "./telegram/telegram-types";
export * from "./types";
```

- [ ] **Step 7: Inject the official Telegram script only into Pages**

`apps/client/build/telegram-script-plugin.test.ts`:

```ts
import { expect, it } from "vitest";
import { hostHeadTags } from "./telegram-script-plugin";

it("adds a bounded CSP to both artifacts and Telegram only to Pages", () => {
  const pages = hostHeadTags("pages", "https://api.example.test");
  expect(pages[0]).toMatchObject({
    tag: "meta",
    attrs: { "http-equiv": "Content-Security-Policy" },
    injectTo: "head-prepend",
  });
  const content = String(pages[0]?.attrs?.content);
  expect(content).toContain("default-src 'none'");
  expect(content).toContain("script-src 'self' https://telegram.org");
  expect(content).toContain("style-src 'self' 'unsafe-inline'");
  expect(content).toContain("connect-src 'self' https://api.example.test");
  expect(content).not.toContain("unsafe-eval");
  expect(content).not.toMatch(/(?:^|\s)\*(?:;|\s|$)/);
  expect(pages[1]).toEqual({
    tag: "script",
    attrs: { src: "https://telegram.org/js/telegram-web-app.js?63" },
    injectTo: "head-prepend",
  });
  expect(hostHeadTags("android", "https://api.example.test")).toHaveLength(1);
});

it("rejects credentials or a path instead of weakening connect-src", () => {
  expect(() => hostHeadTags("pages", "https://user:password@api.test")).toThrow(
    "VITE_API_BASE_URL must be a bare HTTPS origin",
  );
  expect(() => hostHeadTags("pages", "https://api.test/v1")).toThrow(
    "VITE_API_BASE_URL must be a bare HTTPS origin",
  );
});
```

Run: `npm test -w @a-move-ago/client -- build/telegram-script-plugin.test.ts`

Expected: FAIL because the plugin does not exist.

`apps/client/build/telegram-script-plugin.ts`:

```ts
import type { HtmlTagDescriptor, Plugin } from "vite";

export type ClientBuildMode = "pages" | "android";

function apiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_API_BASE_URL must be a bare HTTPS origin without credentials.");
  }
  const localHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("VITE_API_BASE_URL must be a bare HTTPS origin without credentials.");
  }
  return url.origin;
}

export function hostHeadTags(mode: ClientBuildMode, apiBaseUrl: string): HtmlTagDescriptor[] {
  const content = [
    "default-src 'none'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src 'self' ${apiOrigin(apiBaseUrl)}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const tags: HtmlTagDescriptor[] = [{
    tag: "meta",
    attrs: { "http-equiv": "Content-Security-Policy", content },
    injectTo: "head-prepend",
  }];
  if (mode === "pages") tags.push({
    tag: "script",
    attrs: { src: "https://telegram.org/js/telegram-web-app.js?63" },
    injectTo: "head-prepend",
  });
  return tags;
}

export function hostHeadPlugin(mode: ClientBuildMode, apiBaseUrl: string): Plugin {
  return {
    name: "a-move-ago-host-head",
    transformIndexHtml: {
      order: "pre",
      handler: () => hostHeadTags(mode, apiBaseUrl),
    },
  };
}
```

Replace `apps/client/vite.config.ts` with:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { hostHeadPlugin, type ClientBuildMode } from "./build/telegram-script-plugin";

export function clientBuildProfile(mode: ClientBuildMode) {
  return mode === "android"
    ? { base: "/", outDir: "dist/android" }
    : { base: "/a-move-ago/", outDir: "dist/pages" };
}

export default defineConfig(({ mode }) => {
  const buildMode: ClientBuildMode = mode === "android" ? "android" : "pages";
  const profile = clientBuildProfile(buildMode);
  const environment = loadEnv(mode, ".", "");
  return {
    base: profile.base,
    plugins: [hostHeadPlugin(buildMode, environment.VITE_API_BASE_URL ?? ""), react()],
    build: { outDir: profile.outDir, emptyOutDir: true, sourcemap: false },
  };
});
```

Add to `apps/client/package.json` dependencies:

```json
"@a-move-ago/platform": "0.0.0"
```

- [ ] **Step 8: Run GREEN and verify built HTML**

Run: `npm install`

Expected: exit `0`; the client workspace resolves `@a-move-ago/platform`.

Run: `npm test -w @a-move-ago/platform`

Expected: platform tests PASS, 3 tests.

Run: `npm test -w @a-move-ago/client -- build/telegram-script-plugin.test.ts`

Expected: plugin tests PASS, 2 tests.

Run: `VITE_API_BASE_URL=https://api.example.test npm run build:pages -w @a-move-ago/client`

Expected: Pages `index.html` contains a CSP meta tag and `telegram-web-app.js?63` before the module asset.

Run: `VITE_API_BASE_URL=https://api.example.test npm run build:android:web -w @a-move-ago/client`

Expected: Android `index.html` contains the same strict CSP, contains no `telegram-web-app.js`, and uses root-relative assets.

- [ ] **Step 9: Commit**

```bash
git add packages/platform apps/client/build apps/client/package.json apps/client/vite.config.ts package-lock.json
git commit -m "feat: add web and Telegram platform adapters"
```

### Task 4: Реализовать query entry, runtime injection и memory navigation

**Files:**
- Create: `apps/client/src/vite-env.d.ts`
- Create: `apps/client/src/app/entry-query.ts`
- Create: `apps/client/src/app/entry-query.test.ts`
- Create: `apps/client/src/app/navigation.ts`
- Create: `apps/client/src/app/navigation.test.ts`
- Create: `apps/client/src/app/runtime.tsx`
- Create: `apps/client/src/app/use-host-back.ts`
- Create: `apps/client/src/styles/host-layout.css`
- Modify: `apps/client/src/main.tsx`
- Modify: `apps/client/src/styles/base.css`

- [ ] **Step 1: Write failing query and navigation tests**

`apps/client/src/app/entry-query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseEntryQuery, stripAuthReturn } from "./entry-query";

describe("entry query", () => {
  it("reads allowlisted values without reading the Telegram fragment", () => {
    const url = new URL(
      "https://agent-axiom.github.io/a-move-ago/?case=2026-08-03" +
        "&handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG#tgWebAppData=raw%2Bfragment",
    );
    expect(parseEntryQuery(url)).toEqual({
      caseDate: "2026-08-03",
      handoff: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      authError: null,
    });
  });

  it("removes only handoff and preserves path, case and fragment", () => {
    const url = new URL(
      "https://agent-axiom.github.io/a-move-ago/?case=2026-08-03" +
        "&handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG#tgWebAppData=raw%2Bfragment",
    );
    expect(stripAuthReturn(url)).toBe(
      "/a-move-ago/?case=2026-08-03#tgWebAppData=raw%2Bfragment",
    );
  });

  it("rejects duplicate or malformed sensitive values", () => {
    expect(parseEntryQuery(new URL("https://x.test/?handoff=one&handoff=two")).handoff).toBeNull();
    expect(parseEntryQuery(new URL("https://x.test/?case=2026-13-40")).caseDate).toBeNull();
  });

  it("allowlists and strips a fixed provider denial", () => {
    const url = new URL("https://x.test/a-move-ago/?case=2026-08-03&authError=access_denied");
    expect(parseEntryQuery(url).authError).toBe("access_denied");
    expect(stripAuthReturn(url)).toBe("/a-move-ago/?case=2026-08-03");
  });
});
```

`apps/client/src/app/navigation.test.ts`:

```ts
import { expect, it } from "vitest";
import { initialNavigation, navigationReducer } from "./navigation";

it("keeps screens in memory and returns to the case", () => {
  const profile = navigationReducer(initialNavigation("2026-08-03"), {
    type: "push",
    screen: { name: "profile" },
  });
  expect(profile.stack).toEqual([
    { name: "case", caseDate: "2026-08-03" },
    { name: "profile" },
  ]);
  expect(navigationReducer(profile, { type: "back" }).stack).toEqual([
    { name: "case", caseDate: "2026-08-03" },
  ]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/app/entry-query.test.ts src/app/navigation.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement strict query parsing and sanitization**

`apps/client/src/app/entry-query.ts`:

```ts
export interface EntryQuery {
  caseDate: string | null;
  handoff: string | null;
  authError: "access_denied" | null;
}

function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function oneValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

export function parseEntryQuery(url: URL): EntryQuery {
  const caseDate = oneValue(url, "case");
  const handoff = oneValue(url, "handoff");
  const authError = oneValue(url, "authError");
  return {
    caseDate: validDate(caseDate) ? caseDate : null,
    handoff:
      handoff && /^[A-Za-z0-9_-]{43}$/.test(handoff)
        ? handoff
        : null,
    authError: authError === "access_denied" ? authError : null,
  };
}

export function stripAuthReturn(source: URL): string {
  const url = new URL(source);
  url.searchParams.delete("handoff");
  url.searchParams.delete("authError");
  return `${url.pathname}${url.search}${url.hash}`;
}
```

- [ ] **Step 4: Implement the memory stack**

`apps/client/src/app/navigation.ts`:

```ts
export type Screen =
  | { name: "case"; caseDate?: string }
  | { name: "hint"; attemptId: string }
  | { name: "profile" }
  | { name: "result"; puzzleId: string };

export interface NavigationState {
  stack: readonly Screen[];
}

export type NavigationEvent =
  | { type: "push"; screen: Screen }
  | { type: "replace"; screen: Screen }
  | { type: "back" }
  | { type: "reset"; screen: Screen };

export function initialNavigation(caseDate: string | null): NavigationState {
  return { stack: [{ name: "case", ...(caseDate ? { caseDate } : {}) }] };
}

export function navigationReducer(
  state: NavigationState,
  event: NavigationEvent,
): NavigationState {
  switch (event.type) {
    case "push":
      return { stack: [...state.stack, event.screen] };
    case "replace":
      return { stack: [...state.stack.slice(0, -1), event.screen] };
    case "back":
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case "reset":
      return { stack: [event.screen] };
  }
}
```

- [ ] **Step 5: Implement runtime dependency injection**

`apps/client/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

import type { TelegramWebAppLike } from "@a-move-ago/platform";

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppLike };
  }
}
```

`apps/client/src/app/runtime.tsx`:

```tsx
import { createContext, useContext, type ReactNode } from "react";
import { createApiClient, type ApiClient } from "@a-move-ago/api-contract";
import {
  browserPortFromWindow,
  createPlatformAdapter,
  type PlatformAdapter,
} from "@a-move-ago/platform";

export interface TokenHolder {
  get(): string | null;
  set(value: string | null): void;
}

export function createTokenHolder(): TokenHolder {
  let token: string | null = null;
  return { get: () => token, set: (value) => { token = value; } };
}

export interface AppRuntime {
  api: ApiClient;
  platform: PlatformAdapter;
  token: TokenHolder;
  now(): number;
  attemptUuid(): string;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export async function createBrowserRuntime(
  browserWindow: Window,
  loadAndroid?: () => Promise<PlatformAdapter | null>,
): Promise<AppRuntime> {
  const token = createTokenHolder();
  const platform = await createPlatformAdapter({
    browser: browserPortFromWindow(browserWindow),
    telegram: browserWindow.Telegram?.WebApp,
    ...(loadAndroid ? { loadAndroid } : {}),
  });
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  if (!baseUrl) throw new Error("VITE_API_BASE_URL is required.");
  const api = createApiClient({ baseUrl, getToken: token.get });
  return {
    api,
    platform,
    token,
    now: Date.now,
    attemptUuid: crypto.randomUUID.bind(crypto),
    sleep(milliseconds, signal) {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timeout = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, milliseconds);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

const RuntimeContext = createContext<AppRuntime | null>(null);

export function RuntimeProvider(props: { runtime: AppRuntime; children: ReactNode }) {
  return <RuntimeContext value={props.runtime}>{props.children}</RuntimeContext>;
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("RuntimeProvider is missing.");
  return runtime;
}
```

Replace `apps/client/src/main.tsx` so React mounts only after the async platform choice resolves. Plan 5 passes a dynamic Android loader through this seam; it must not add a static Capacitor import to the Pages graph.

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createBrowserRuntime, RuntimeProvider } from "./app/runtime";
import "./styles/base.css";

async function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root element");
  const runtime = await createBrowserRuntime(window);
  createRoot(element).render(
    <StrictMode>
      <RuntimeProvider runtime={runtime}>
        <App />
      </RuntimeProvider>
    </StrictMode>,
  );
}

void main().catch((error: unknown) => {
  const element = document.getElementById("root");
  if (element) {
    element.textContent = error instanceof Error ? error.message : "App startup failed.";
  }
});
```

`apps/client/src/app/use-host-back.ts`:

```ts
import { useEffect } from "react";
import type { NavigationEvent, NavigationState } from "./navigation";
import { useRuntime } from "./runtime";

export function useHostBack(
  navigation: NavigationState,
  dispatch: (event: NavigationEvent) => void,
) {
  const { platform } = useRuntime();
  useEffect(() => {
    void platform.setBackHandler(
      navigation.stack.length > 1 ? () => dispatch({ type: "back" }) : null,
    );
    return () => { void platform.setBackHandler(null); };
  }, [dispatch, navigation.stack.length, platform]);
}
```

- [ ] **Step 6: Compose host-safe CSS variables**

`apps/client/src/styles/host-layout.css`:

```css
:root {
  --host-stable-height: 100vh;
  --host-safe-top: env(safe-area-inset-top, 0px);
  --host-safe-right: env(safe-area-inset-right, 0px);
  --host-safe-bottom: env(safe-area-inset-bottom, 0px);
  --host-safe-left: env(safe-area-inset-left, 0px);
  --host-content-safe-top: 0px;
  --host-content-safe-right: 0px;
  --host-content-safe-bottom: 0px;
  --host-content-safe-left: 0px;
}

.app-shell {
  min-height: var(--host-stable-height);
  padding-top: max(1rem, var(--host-safe-top), var(--host-content-safe-top));
  padding-right: max(1rem, var(--host-safe-right), var(--host-content-safe-right));
  padding-bottom: max(1rem, var(--host-safe-bottom), var(--host-content-safe-bottom));
  padding-left: max(1rem, var(--host-safe-left), var(--host-content-safe-left));
}
```

Prepend to `apps/client/src/styles/base.css` (CSS imports must precede every rule):

```css
@import "./host-layout.css";
```

Delete the Task 1 `.app-shell { min-height: 100vh; padding: 1rem; }` block from
`apps/client/src/styles/base.css`. The host-aware rule above is the single owner of shell sizing and
padding; leaving the later Task 1 rule in place would override Telegram's stable-height and safe-area
values because `base.css` is evaluated after its import.

- [ ] **Step 7: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/app/entry-query.test.ts src/app/navigation.test.ts`

Expected: PASS, 5 tests.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/app apps/client/src/main.tsx apps/client/src/vite-env.d.ts apps/client/src/styles
git commit -m "feat: add Pages-safe memory navigation"
```

### Task 5: Реализовать guest bootstrap, явный Telegram consent и auth return

**Files:**
- Modify: `packages/api-contract/src/client.ts`
- Modify: `packages/api-contract/src/client.test.ts`
- Create: `apps/client/src/features/session/session-state.ts`
- Create: `apps/client/src/features/session/session-service.ts`
- Create: `apps/client/src/features/session/session-service.test.ts`
- Create: `apps/client/src/features/session/SessionProvider.tsx`
- Create: `apps/client/src/features/session/SessionProvider.test.tsx`
- Create: `apps/client/src/features/session/SaveProgressButton.tsx`
- Create: `apps/client/src/test/runtime-fixture.ts`
- Modify: `apps/client/src/app/runtime.tsx`

- [ ] **Step 1: Extend the typed client with plan-3 auth schemas**

Add these imports from `./api` in `packages/api-contract/src/client.ts`:

```ts
HandoffExchangeRequestSchema,
OidcStartRequestSchema,
OidcStartResponseSchema,
TelegramMiniAppAuthRequestSchema,
TelegramSessionIssuedSchema,
```

Add these methods to the returned API client object immediately before `logout`:

```ts
loginMiniApp(initData: string, signal?: AbortSignal) {
  return request({
    method: "POST",
    path: "/v1/auth/telegram/mini-app",
    body: TelegramMiniAppAuthRequestSchema.parse({ initData }),
    responseSchema: TelegramSessionIssuedSchema,
    signal,
  });
},
startOidc(channel: "web" | "android", signal?: AbortSignal) {
  return request({
    method: "POST",
    path: "/v1/auth/telegram/oidc/start",
    body: OidcStartRequestSchema.parse({ channel }),
    responseSchema: OidcStartResponseSchema,
    signal,
  });
},
exchangeHandoff(handoffCode: string, signal?: AbortSignal) {
  return request({
    method: "POST",
    path: "/v1/auth/session/exchange",
    body: HandoffExchangeRequestSchema.parse({ handoffCode }),
    responseSchema: TelegramSessionIssuedSchema,
    signal,
  });
},
```

Add to `packages/api-contract/src/client.test.ts`:

```ts
it("sends raw Mini App initData unchanged only through the login method", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({ ...session, kind: "telegram", profile: profileFixture }, { status: 200 }),
  );
  const api = createApiClient({ baseUrl: "https://api.test", fetch, getToken: () => "guest" });
  const raw = "query_id=AAE%2Braw&user=%7B%22id%22%3A1%7D&hash=unchanged";
  await api.loginMiniApp(raw);
  expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ initData: raw });
});

const profileFixture = {
  telegramUserId: "42",
  displayName: "Ada",
  username: null,
  avatarUrl: null,
};
```

Run: `npm test -w @a-move-ago/api-contract -- src/client.test.ts`

Expected: FAIL before the methods/imports are added; after the exact additions, PASS, 5 tests.

- [ ] **Step 2: Write failing guest/consent/handoff tests**

`apps/client/src/features/session/session-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import {
  bootstrapSession,
  RetryableHandoffError,
  retryHandoff,
  saveProgress,
  TelegramAuthDeniedError,
} from "./session-service";
import { runtimeFixture } from "../../test/runtime-fixture";

describe("session service", () => {
  it("creates a guest without requesting Telegram identity", async () => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "telegram" });
    runtime.api.createGuest = vi.fn().mockResolvedValue({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest",
    });

    const result = await bootstrapSession(runtime, new URL("https://app.test/"), vi.fn());

    expect(result).toEqual({ kind: "guest", profile: null });
    expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
    expect(runtime.api.loginMiniApp).not.toHaveBeenCalled();
    expect(runtime.api.createGuest).toHaveBeenCalledWith("telegram", expect.any(AbortSignal));
  });

  it("requests raw proof only after the save-progress action", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "telegram" });
    runtime.platform.requestTelegramProof = vi.fn().mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "user=raw%2Bvalue&hash=unchanged",
    });
    runtime.api.loginMiniApp = vi.fn().mockResolvedValue({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram",
      profile: profileFixture,
    });
    runtime.api.getMe = vi.fn().mockResolvedValue({
      kind: "telegram",
      profile: {
        telegramUserId: "42",
        displayName: "Ada",
        username: null,
        avatarUrl: null,
      },
    });

    await saveProgress(runtime);

    expect(runtime.platform.requestTelegramProof).toHaveBeenCalledWith({
      reason: "save-progress",
      userInitiatedAt: 1_785_690_000_000,
    });
    expect(runtime.api.loginMiniApp).toHaveBeenCalledWith(
      "user=raw%2Bvalue&hash=unchanged",
      expect.any(AbortSignal),
    );
  });

  it("keeps the guest token after invalid Telegram proof", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "telegram" });
    runtime.platform.requestTelegramProof = vi.fn().mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "expired",
    });
    runtime.api.loginMiniApp = vi.fn().mockRejectedValue(
      new ApiError(401, "TELEGRAM_PROOF_INVALID", "Expired.", "req-1", null),
    );

    await expect(saveProgress(runtime)).rejects.toMatchObject({ code: "TELEGRAM_PROOF_INVALID" });
    expect(runtime.token.get()).toBe("guest-token");
    expect(await runtime.platform.tokenStore.read()).toBe("guest-token");
  });

  it("strips handoff before exchange and exchanges it once", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.api.exchangeHandoff = vi.fn().mockResolvedValue({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram",
      profile: profileFixture,
    });
    const replace = vi.fn();
    const code = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

    await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?case=2026-08-03&handoff=${code}#tgWebAppData=kept`),
      replace,
    );

    expect(replace).toHaveBeenCalledWith("/a-move-ago/?case=2026-08-03#tgWebAppData=kept");
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(code, expect.any(AbortSignal));
  });

  it("keeps a stripped handoff in memory and explicitly retries the same code", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const code = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    runtime.api.exchangeHandoff = vi.fn()
      .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
      .mockResolvedValueOnce({
        token: "t".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "telegram",
        profile: profileFixture,
      });
    const replace = vi.fn();

    const first = bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${code}`),
      replace,
    );
    const failure = await first.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryableHandoffError);
    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(runtime.token.get()).toBe("guest-token");

    await expect(retryHandoff(runtime, (failure as RetryableHandoffError).pending))
      .resolves.toEqual({ kind: "telegram", profile: profileFixture });
    expect(runtime.api.exchangeHandoff).toHaveBeenNthCalledWith(1, code, expect.any(AbortSignal));
    expect(runtime.api.exchangeHandoff).toHaveBeenNthCalledWith(2, code, expect.any(AbortSignal));
  });

  it("strips a fixed OIDC denial and continues as the same guest", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const replace = vi.fn();
    const failure = await bootstrapSession(
      runtime,
      new URL("https://app.test/a-move-ago/?case=2026-08-03&authError=access_denied"),
      replace,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramAuthDeniedError);
    expect((failure as TelegramAuthDeniedError).me).toEqual({ kind: "guest", profile: null });
    expect(replace).toHaveBeenCalledWith("/a-move-ago/?case=2026-08-03");
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
  });

  it("starts web OIDC without a client-supplied return URL", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.api.startOidc = vi.fn().mockResolvedValue({
      authorizationUrl: "https://oauth.telegram.org/auth?response_type=code&state=server-state",
      expiresAt: "2026-08-03T12:10:00.000Z",
    });
    await expect(saveProgress(runtime)).resolves.toBeNull();
    expect(runtime.api.startOidc).toHaveBeenCalledWith("web", expect.any(AbortSignal));
    expect(runtime.platform.openAuthorization).toHaveBeenCalledWith(
      "https://oauth.telegram.org/auth?response_type=code&state=server-state",
    );
  });
});

const profileFixture = {
  telegramUserId: "42",
  displayName: "Ada",
  username: null,
  avatarUrl: null,
};
```

`apps/client/src/features/session/SessionProvider.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { SaveProgressButton } from "./SaveProgressButton";
import { SessionProvider } from "./SessionProvider";

it("returns to guest-ready after opening OIDC without an immediate callback", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider><SaveProgressButton /></SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() => expect(runtime.platform.openAuthorization).toHaveBeenCalledWith(
    "https://oauth.telegram.org/auth?response_type=code",
  ));
  await waitFor(() => expect(save).toBeEnabled());
  expect(save).toHaveTextContent("Save progress with Telegram");
});
```

`apps/client/src/test/runtime-fixture.ts`:

```ts
import { vi } from "vitest";
import type { ApiClient } from "@a-move-ago/api-contract";
import type { PlatformAdapter } from "@a-move-ago/platform";
import { createTokenHolder, type AppRuntime } from "../app/runtime";

export function runtimeFixture(options: {
  storedToken: string | null;
  platformKind: "web" | "telegram";
}): AppRuntime {
  let stored = options.storedToken;
  const token = createTokenHolder();
  token.set(stored);
  const profile = {
    telegramUserId: "42",
    displayName: "Ada",
    username: null,
    avatarUrl: null,
  } as const;
  const api = {
    createGuest: vi.fn(async () => ({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest" as const,
    })),
    getMe: vi.fn(async () => ({ kind: "guest" as const, profile: null })),
    getDaily: vi.fn(async () => ({
      id: "case-2026-08-03",
      date: "2026-08-03",
      title: "The missing pawn",
      puzzles: [],
      solvedPuzzleIds: [],
    })),
    submitAttempt: vi.fn(async (request: { attemptUuid: string }) => ({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: request.attemptUuid,
      correct: false as const,
      contradiction: { code: "NOT_THE_LAST_MOVE" as const, message: "Try again." },
    })),
    requestHint: vi.fn(async (_attemptId: string, level: number) => ({
      level,
      text: "Look at the pawn file.",
      exhausted: false,
    })),
    getStats: vi.fn(async () => ({
      attempts: 0,
      hintsUsed: 0,
      solvedPuzzles: 0,
      completedCases: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastCompletedDate: null,
    })),
    loginMiniApp: vi.fn(async () => ({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram" as const,
      profile,
    })),
    startOidc: vi.fn(async () => ({
      authorizationUrl: "https://oauth.telegram.org/auth?response_type=code",
      expiresAt: "2026-08-03T12:10:00.000Z",
    })),
    exchangeHandoff: vi.fn(async () => ({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram" as const,
      profile,
    })),
    logout: vi.fn(async () => ({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest" as const,
    })),
  } as unknown as ApiClient;
  const platform = {
    kind: options.platformKind,
    channel: options.platformKind,
    authMode: options.platformKind === "telegram" ? "mini-app" : "oidc-web",
    tokenStore: {
      read: vi.fn(async () => stored),
      write: vi.fn(async (value: string) => { stored = value; }),
      clear: vi.fn(async () => { stored = null; }),
    },
    authReturn: {
      initialUrl: vi.fn(async () => null),
      subscribe: vi.fn(async () => () => undefined),
    },
    ready: vi.fn(async () => undefined),
    installLayoutVars: vi.fn(() => () => undefined),
    setBackHandler: vi.fn(async () => undefined),
    haptic: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    openAuthorization: vi.fn(async () => undefined),
    requestTelegramProof: vi.fn(async () => null),
  } as PlatformAdapter;
  return {
    api,
    platform,
    token,
    now: () => 1_785_690_000_000,
    attemptUuid: () => "22222222-2222-4222-8222-222222222222",
    sleep: vi.fn(async () => undefined),
  };
}
```

- [ ] **Step 3: Run session tests RED**

Run: `npm test -w @a-move-ago/client -- src/features/session/session-service.test.ts src/features/session/SessionProvider.test.tsx`

Expected: FAIL because the session service, provider, consent button and runtime fixture do not exist.

- [ ] **Step 4: Implement session state and service**

`apps/client/src/features/session/session-state.ts`:

```ts
import type { z } from "zod";
import type { MeResponseSchema } from "@a-move-ago/api-contract";

export type Me = z.infer<typeof MeResponseSchema>;

export type SessionState =
  | { tag: "booting" }
  | { tag: "ready"; me: Me }
  | { tag: "authenticating"; me: Me }
  | { tag: "handoff-retry"; me: Me; handoffCode: string; message: string }
  | { tag: "auth-error"; me: Me; message: string; requestId?: string }
  | { tag: "fatal"; message: string; requestId?: string };
```

`apps/client/src/features/session/session-service.ts`:

```ts
import { ApiError, ApiTransportError, type MeResponseSchema } from "@a-move-ago/api-contract";
import type { z } from "zod";
import type { AppRuntime } from "../../app/runtime";
import { parseEntryQuery, stripAuthReturn } from "../../app/entry-query";

type Me = z.infer<typeof MeResponseSchema>;

export interface PendingHandoff {
  handoffCode: string;
}

export class RetryableHandoffError extends Error {
  constructor(readonly pending: PendingHandoff, override readonly cause: unknown) {
    super("Telegram sign-in could not be exchanged. Retry when the connection recovers.");
    this.name = "RetryableHandoffError";
  }
}

export class TelegramAuthDeniedError extends Error {
  constructor(readonly me: Me) {
    super("Telegram sign-in was cancelled. Guest progress is still available.");
    this.name = "TelegramAuthDeniedError";
  }
}

async function installToken(runtime: AppRuntime, token: string): Promise<void> {
  await runtime.platform.tokenStore.write(token);
  runtime.token.set(token);
}

async function issueGuest(runtime: AppRuntime, signal: AbortSignal): Promise<Me> {
  const issued = await runtime.api.createGuest(runtime.platform.channel, signal);
  await installToken(runtime, issued.token);
  return { kind: "guest", profile: null };
}

export async function bootstrapSession(
  runtime: AppRuntime,
  sourceUrl: URL,
  replaceUrl: (relativeUrl: string) => void,
  signal = new AbortController().signal,
): Promise<Me> {
  const { handoff, authError } = parseEntryQuery(sourceUrl);
  if (sourceUrl.searchParams.has("handoff") || sourceUrl.searchParams.has("authError")) {
    replaceUrl(stripAuthReturn(sourceUrl));
  }

  const stored = await runtime.platform.tokenStore.read();
  let me: Me;
  if (stored) {
    runtime.token.set(stored);
    try {
      me = await runtime.api.getMe(signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        if (handoff && retryableHandoffFailure(error)) {
          throw new RetryableHandoffError({ handoffCode: handoff }, error);
        }
        throw error;
      }
      await runtime.platform.tokenStore.clear();
      runtime.token.set(null);
      me = await issueGuest(runtime, signal);
    }
  } else {
    me = await issueGuest(runtime, signal);
  }

  if (authError) throw new TelegramAuthDeniedError(me);
  return handoff
    ? retryHandoff(runtime, { handoffCode: handoff }, signal)
    : me;
}

function retryableHandoffFailure(error: unknown): boolean {
  return error instanceof ApiTransportError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500));
}

export async function retryHandoff(
  runtime: AppRuntime,
  pending: PendingHandoff,
  signal = new AbortController().signal,
): Promise<Me> {
  try {
    const issued = await runtime.api.exchangeHandoff(pending.handoffCode, signal);
    await installToken(runtime, issued.token);
    return { kind: "telegram", profile: issued.profile };
  } catch (error) {
    if (retryableHandoffFailure(error)) throw new RetryableHandoffError(pending, error);
    throw error;
  }
}

export async function saveProgress(
  runtime: AppRuntime,
  signal = new AbortController().signal,
): Promise<Me | null> {
  if (runtime.platform.authMode === "mini-app") {
    const proof = await runtime.platform.requestTelegramProof({
      reason: "save-progress",
      userInitiatedAt: runtime.now(),
    });
    if (!proof) throw new Error("Telegram did not provide Mini App initData.");
    const issued = await runtime.api.loginMiniApp(proof.initData, signal);
    await installToken(runtime, issued.token);
    return { kind: "telegram", profile: issued.profile };
  }

  const channel = runtime.platform.authMode === "oidc-android" ? "android" : "web";
  const started = await runtime.api.startOidc(channel, signal);
  const authorizationUrl = new URL(started.authorizationUrl);
  if (authorizationUrl.origin !== "https://oauth.telegram.org" || authorizationUrl.pathname !== "/auth") {
    throw new Error("API returned an unexpected Telegram authorization URL.");
  }
  await runtime.platform.openAuthorization(authorizationUrl.toString());
  return null;
}
```

- [ ] **Step 5: Implement the provider and explicit consent button**

`apps/client/src/features/session/SessionProvider.tsx`:

```tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@a-move-ago/api-contract";
import { useRuntime } from "../../app/runtime";
import {
  bootstrapSession,
  RetryableHandoffError,
  retryHandoff as exchangePendingHandoff,
  saveProgress,
  TelegramAuthDeniedError,
} from "./session-service";
import type { SessionState } from "./session-state";

interface SessionContextValue {
  state: SessionState;
  save(): Promise<void>;
  retryHandoff(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function authReturnFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${value.length}:${hash.toString(16)}`;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const runtime = useRuntime();
  const [state, setState] = useState<SessionState>({ tag: "booting" });

  useEffect(() => {
    const controller = new AbortController();
    const pendingUrls = new Set<string>();
    const handledFingerprints = new Set<string>();
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    let queue = Promise.resolve();

    function fail(error: unknown) {
      if (controller.signal.aborted) return;
      if (error instanceof TelegramAuthDeniedError) {
        setState({ tag: "auth-error", me: error.me, message: error.message });
        return;
      }
      if (error instanceof RetryableHandoffError) {
        setState({
          tag: "handoff-retry",
          me: { kind: "guest", profile: null },
          handoffCode: error.pending.handoffCode,
          message: error.message,
        });
        return;
      }
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.status === 401) {
        setState({
          tag: "auth-error",
          me: { kind: "guest", profile: null },
          message: "Telegram return expired or was already consumed. Start Save progress again.",
          requestId: apiError.requestId,
        });
        return;
      }
      setState({
        tag: "fatal",
        message: apiError?.message ?? "Could not start a guest session.",
        ...(apiError ? { requestId: apiError.requestId } : {}),
      });
    }

    function schedule(rawUrl: string) {
      const fingerprint = authReturnFingerprint(rawUrl);
      if (pendingUrls.has(rawUrl) || handledFingerprints.has(fingerprint)) return;
      pendingUrls.add(rawUrl);
      queue = queue.then(async () => {
        if (handledFingerprints.has(fingerprint)) return;
        handledFingerprints.add(fingerprint);
        const source = new URL(rawUrl, window.location.href);
        const browser = new URL(window.location.href);
        const sameDocument = source.origin === browser.origin && source.pathname === browser.pathname;
        const me = await bootstrapSession(
          runtime,
          source,
          (url) => { if (sameDocument) window.history.replaceState(null, "", url); },
          controller.signal,
        );
        if (!controller.signal.aborted) setState({ tag: "ready", me });
      }).catch(fail).finally(() => pendingUrls.delete(rawUrl));
    }

    void (async () => {
      const stop = await runtime.platform.authReturn.subscribe(schedule);
      if (disposed) {
        stop();
        return;
      }
      unsubscribe = stop;
      const initial = await runtime.platform.authReturn.initialUrl();
      if (!disposed) schedule(initial ?? window.location.href);
    })().catch(fail);
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
    };
  }, [runtime]);

  const value = useMemo<SessionContextValue>(() => ({
    state,
    async save() {
      if (state.tag !== "ready" && state.tag !== "auth-error") return;
      const previous = state.me;
      setState({ tag: "authenticating", me: previous });
      try {
        const me = await saveProgress(runtime);
        setState({ tag: "ready", me: me ?? previous });
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;
        setState({
          tag: "auth-error",
          me: previous,
          message: apiError?.message ?? "Telegram sign-in did not finish.",
          ...(apiError ? { requestId: apiError.requestId } : {}),
        });
      }
    },
    async retryHandoff() {
      if (state.tag !== "handoff-retry") return;
      const handoffCode = state.handoffCode;
      setState({ tag: "authenticating", me: state.me });
      try {
        const me = await exchangePendingHandoff(runtime, { handoffCode });
        setState({ tag: "ready", me });
      } catch (error) {
        if (error instanceof RetryableHandoffError) {
          setState({
            tag: "handoff-retry",
            me: { kind: "guest", profile: null },
            handoffCode,
            message: error.message,
          });
          return;
        }
        const apiError = error instanceof ApiError ? error : null;
        setState({
          tag: "auth-error",
          me: { kind: "guest", profile: null },
          message: "Telegram return expired or was already consumed. Start Save progress again.",
          ...(apiError ? { requestId: apiError.requestId } : {}),
        });
      }
    },
  }), [runtime, state]);

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is missing.");
  return value;
}
```

`apps/client/src/features/session/SaveProgressButton.tsx`:

```tsx
import { useSession } from "./SessionProvider";

export function SaveProgressButton() {
  const { state, save, retryHandoff } = useSession();
  if (state.tag === "ready" && state.me.kind === "telegram") return null;
  const disabled = state.tag === "booting" || state.tag === "authenticating" || state.tag === "fatal";
  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { void (state.tag === "handoff-retry" ? retryHandoff() : save()); }}
      >
        {state.tag === "authenticating"
          ? "Connecting…"
          : state.tag === "handoff-retry"
            ? "Retry Telegram return"
            : "Save progress with Telegram"}
      </button>
      {state.tag === "auth-error" || state.tag === "handoff-retry"
        ? <p role="alert">{state.message}</p>
        : null}
      {state.tag === "auth-error" && state.requestId
        ? <p>Request ID: <code>{state.requestId}</code></p>
        : null}
    </div>
  );
}
```

- [ ] **Step 6: Run GREEN and privacy regression**

Run: `npm test -w @a-move-ago/client -- src/features/session/session-service.test.ts src/features/session/SessionProvider.test.tsx`

Expected: PASS, 8 tests; bootstrap requests no identity proof, the stripped 43-character handoff survives only in memory for explicit retry, `authError=access_denied` is stripped while the same guest remains playable, OIDC start sends only the server-defined channel, and dismissing the external browser leaves the guest UI enabled for another explicit attempt.

Run: `npm run typecheck -w @a-move-ago/api-contract`

Expected: exit `0`.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

If the server consumes the handoff and rotates the guest session but the success response is lost, the old guest Bearer can no longer replay it. The explicit retry then receives `401`; the client clears the in-memory handoff by moving to `auth-error` and asks the player to start a fresh Telegram login. It never restores the code to URL or persistent storage.

- [ ] **Step 7: Commit**

```bash
git add packages/api-contract/src/client.ts packages/api-contract/src/client.test.ts apps/client/src/features/session apps/client/src/test
git commit -m "feat: add guest-first Telegram consent flow"
```

### Task 6: Разделить GET retry и пользовательские категории ошибок

**Files:**
- Create: `apps/client/src/shared/retry-get.ts`
- Create: `apps/client/src/shared/retry-get.test.ts`
- Create: `apps/client/src/shared/failure.ts`
- Test: `apps/client/src/shared/failure.test.ts`
- Modify: `apps/client/src/features/session/session-service.ts`

- [ ] **Step 1: Write failing deterministic retry tests**

`apps/client/src/shared/retry-get.test.ts`:

```ts
import { expect, it, vi } from "vitest";
import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { retryGet } from "./retry-get";

it("retries transport and server failures with bounded jitter", async () => {
  const operation = vi.fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "Retry.", "req-1", null))
    .mockResolvedValue("daily");
  const sleep = vi.fn().mockResolvedValue(undefined);

  await expect(retryGet(operation, {
    maxAttempts: 3,
    baseDelayMs: 200,
    random: () => 0.5,
    sleep,
  })).resolves.toBe("daily");

  expect(operation).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenNthCalledWith(1, 200, undefined);
  expect(sleep).toHaveBeenNthCalledWith(2, 400, undefined);
});

it("does not retry auth or content errors", async () => {
  const operation = vi.fn().mockRejectedValue(
    new ApiError(404, "DAILY_NOT_FOUND", "Missing.", "req-2", null),
  );
  await expect(retryGet(operation, {
    maxAttempts: 3,
    baseDelayMs: 200,
    random: () => 0.5,
    sleep: vi.fn(),
  })).rejects.toMatchObject({ code: "DAILY_NOT_FOUND" });
  expect(operation).toHaveBeenCalledOnce();
});
```

`apps/client/src/shared/failure.test.ts`:

```ts
import { expect, it } from "vitest";
import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { classifyFailure } from "./failure";

it("classifies transport, auth, rate, content and server failures", () => {
  expect(classifyFailure(new ApiTransportError("offline"))).toEqual({ kind: "offline" });
  expect(classifyFailure(new ApiError(401, "INVALID_SESSION", "Expired.", "r1", null)))
    .toEqual({ kind: "auth", requestId: "r1" });
  expect(classifyFailure(new ApiError(429, "RATE_LIMITED", "Wait.", "r2", 8)))
    .toEqual({ kind: "rate-limit", requestId: "r2", retryAfterSeconds: 8 });
  expect(classifyFailure(new ApiError(404, "DAILY_NOT_FOUND", "Missing.", "r3", null)))
    .toEqual({ kind: "content", requestId: "r3" });
  expect(classifyFailure(new ApiError(503, "UNAVAILABLE", "Down.", "r4", null)))
    .toEqual({ kind: "server", requestId: "r4" });
  expect(classifyFailure(new ApiContractError("invalid"))).toEqual({ kind: "contract" });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/shared`

Expected: FAIL because retry and classifier modules do not exist.

- [ ] **Step 3: Implement GET-only retry policy**

`apps/client/src/shared/retry-get.ts`:

```ts
import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  random(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

function retryable(error: unknown): boolean {
  return error instanceof ApiTransportError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500));
}

export async function retryGet<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (!retryable(error) || attempt >= options.maxAttempts) throw error;
      const serverDelay = error instanceof ApiError && error.retryAfterSeconds !== null
        ? error.retryAfterSeconds * 1_000
        : null;
      const exponential = options.baseDelayMs * 2 ** (attempt - 1);
      const jittered = Math.round(exponential * (0.5 + options.random()));
      await options.sleep(serverDelay ?? jittered, options.signal);
    }
  }
}
```

`retryGet` is used only at named GET call sites (`getDaily`, `getMe`, `getStats`). Attempt and hint POST retries remain explicit UI events carrying the original immutable request.

- [ ] **Step 4: Implement failure classification**

`apps/client/src/shared/failure.ts`:

```ts
import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";

export type ClientFailure =
  | { kind: "offline" }
  | { kind: "auth"; requestId: string }
  | { kind: "rate-limit"; requestId: string; retryAfterSeconds: number | null }
  | { kind: "content"; requestId: string }
  | { kind: "server"; requestId?: string }
  | { kind: "contract" };

export function classifyFailure(error: unknown): ClientFailure {
  if (error instanceof ApiTransportError) return { kind: "offline" };
  if (error instanceof ApiContractError) return { kind: "contract" };
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: "auth", requestId: error.requestId };
    }
    if (error.status === 429) {
      return {
        kind: "rate-limit",
        requestId: error.requestId,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    if (error.code === "DAILY_NOT_FOUND") {
      return { kind: "content", requestId: error.requestId };
    }
    return { kind: "server", requestId: error.requestId };
  }
  return { kind: "server" };
}
```

- [ ] **Step 5: Wire the guest-profile GET through the same safe policy**

Add this import to `apps/client/src/features/session/session-service.ts`:

```ts
import { retryGet } from "../../shared/retry-get";
```

Add this helper immediately after `issueGuest`:

```ts
async function readMe(runtime: AppRuntime, signal: AbortSignal): Promise<Me> {
  return retryGet(() => runtime.api.getMe(signal), {
    maxAttempts: 3,
    baseDelayMs: 250,
    random: Math.random,
    sleep: runtime.sleep,
    signal,
  });
}
```

Replace the single `me = await runtime.api.getMe(signal);` inside `bootstrapSession` with:

```ts
me = await readMe(runtime, signal);
```

This retries only transport/429/5xx failures; a `401` still immediately rotates to a new guest in the existing branch.

- [ ] **Step 6: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/shared src/features/session/session-service.test.ts`

Expected: PASS, 10 tests across retry/failure classification and the unchanged session flows.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/shared apps/client/src/features/session/session-service.ts
git commit -m "feat: classify failures and retry safe reads"
```

### Task 7: Построить доступную custom-доску без drag-only interaction

**Files:**
- Create: `apps/client/src/features/game/ui/board-order.ts`
- Create: `apps/client/src/features/game/ui/board-order.test.ts`
- Create: `apps/client/src/features/game/ui/Chessboard.tsx`
- Create: `apps/client/src/features/game/ui/Chessboard.test.tsx`
- Create: `apps/client/src/styles/chessboard.css`
- Modify: `apps/client/src/styles/base.css`

- [ ] **Step 1: Write failing orientation, keyboard and click tests**

`apps/client/src/features/game/ui/board-order.test.ts`:

```ts
import { expect, it } from "vitest";
import { squareAt } from "./board-order";

it("maps the visual corners for both orientations", () => {
  expect(squareAt("white", 0, 0)).toBe("a8");
  expect(squareAt("white", 7, 7)).toBe("h1");
  expect(squareAt("black", 0, 0)).toBe("h1");
  expect(squareAt("black", 7, 7)).toBe("a8");
});
```

`apps/client/src/features/game/ui/Chessboard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { parseFen } from "@a-move-ago/game-core";
import { Chessboard } from "./Chessboard";

it("exposes 64 named buttons, roving focus and a non-drag selection path", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const board = parseFen("4k3/8/8/3P4/8/8/8/4K3 b - - 0 1").board;
  render(
    <Chessboard
      board={board}
      orientation="white"
      selectedSquare={null}
      onSelect={select}
      label="Position after the unknown move"
    />,
  );

  expect(screen.getAllByRole("row")).toHaveLength(8);
  expect(screen.getAllByRole("gridcell")).toHaveLength(64);
  const a8 = screen.getByRole("gridcell", { name: "a8, empty" });
  a8.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("gridcell", { name: "b8, empty" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledWith("b8");
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  expect(select).toHaveBeenLastCalledWith("d5");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/features/game/ui/board-order.test.ts src/features/game/ui/Chessboard.test.tsx`

Expected: FAIL because the board modules do not exist.

- [ ] **Step 3: Implement deterministic visual ordering**

`apps/client/src/features/game/ui/board-order.ts`:

```ts
import type { Square } from "@a-move-ago/api-contract";

export type BoardOrientation = "white" | "black";

const files = "abcdefgh";

export function squareAt(
  orientation: BoardOrientation,
  row: number,
  column: number,
): Square {
  const fileIndex = orientation === "white" ? column : 7 - column;
  const rank = orientation === "white" ? 8 - row : row + 1;
  return `${files[fileIndex]}${rank}` as Square;
}

export function nextFocus(index: number, key: string): number {
  const row = Math.floor(index / 8);
  const column = index % 8;
  switch (key) {
    case "ArrowUp": return Math.max(0, row - 1) * 8 + column;
    case "ArrowDown": return Math.min(7, row + 1) * 8 + column;
    case "ArrowLeft": return row * 8 + Math.max(0, column - 1);
    case "ArrowRight": return row * 8 + Math.min(7, column + 1);
    case "Home": return row * 8;
    case "End": return row * 8 + 7;
    default: return index;
  }
}
```

- [ ] **Step 4: Implement the semantic grid**

`apps/client/src/features/game/ui/Chessboard.tsx`:

```tsx
import { useRef, useState, type KeyboardEvent } from "react";
import type { Piece, Square } from "@a-move-ago/api-contract";
import type { Board } from "@a-move-ago/game-core";
import { nextFocus, squareAt, type BoardOrientation } from "./board-order";

const names = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
} as const;

const glyphs: Record<string, string> = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

function pieceLabel(piece: Piece | undefined): string {
  return piece ? `${piece.color === "w" ? "white" : "black"} ${names[piece.type]}` : "empty";
}

export function Chessboard(props: {
  board: Board;
  orientation: BoardOrientation;
  selectedSquare: Square | null;
  onSelect(square: Square): void;
  label: string;
  disabled?: boolean;
}) {
  const [active, setActive] = useState(0);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextFocus(index, event.key);
    if (next === index && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    setActive(next);
    cells.current[next]?.focus();
  }

  return (
    <div className="chessboard" role="grid" aria-label={props.label}>
      {Array.from({ length: 8 }, (_, row) => (
        <div className="board-row" key={row} role="row">
          {Array.from({ length: 8 }, (_, column) => {
            const index = row * 8 + column;
            const square = squareAt(props.orientation, row, column);
            const piece = props.board[square];
            const selected = props.selectedSquare === square;
            return (
              <button
                aria-label={`${square}, ${pieceLabel(piece)}`}
                aria-selected={selected}
                className={`board-cell ${(row + column) % 2 ? "dark" : "light"}`}
                disabled={props.disabled}
                key={square}
                onClick={() => props.onSelect(square)}
                onFocus={() => setActive(index)}
                onKeyDown={(event) => onKeyDown(event, index)}
                ref={(element) => { cells.current[index] = element; }}
                role="gridcell"
                tabIndex={active === index ? 0 : -1}
                type="button"
              >
                <span aria-hidden="true" className="piece-glyph">
                  {piece ? glyphs[`${piece.color}${piece.type}`] : ""}
                </span>
                <span aria-hidden="true" className="square-coordinate">{square}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

`apps/client/src/styles/chessboard.css`:

```css
.chessboard {
  display: grid;
  grid-template-rows: repeat(8, 1fr);
  width: min(100%, 32rem);
  aspect-ratio: 1;
  border: 0.2rem solid #302d2a;
}

.board-row {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  min-height: 0;
}

.board-cell {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
  border: 0;
  color: #171513;
  cursor: pointer;
}

.board-cell.light { background: #eee2c7; }
.board-cell.dark { background: #8a674b; }
.board-cell[aria-selected="true"] { box-shadow: inset 0 0 0 0.25rem #ffcf4a; }
.board-cell:focus-visible { z-index: 1; outline: 0.25rem solid #62b5ff; outline-offset: -0.25rem; }
.piece-glyph { font-size: clamp(1.6rem, 8vw, 3.2rem); line-height: 1; }
.square-coordinate { position: absolute; inset: auto 0.15rem 0.05rem auto; font-size: 0.58rem; font-weight: 700; }

@media (prefers-reduced-motion: reduce) {
  .board-cell { scroll-behavior: auto; }
}
```

Prepend this import after the host-layout import at the top of `apps/client/src/styles/base.css`:

```css
@import "./chessboard.css";
```

- [ ] **Step 5: Run GREEN and accessibility tests**

Run: `npm test -w @a-move-ago/client -- src/features/game/ui/board-order.test.ts src/features/game/ui/Chessboard.test.tsx`

Expected: PASS, 2 tests; assertions prove orientation, names, 64 semantic cells, arrow focus and click selection.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/features/game/ui apps/client/src/styles
git commit -m "feat: add accessible chessboard controls"
```

### Task 8: Смоделировать normal, capture и специальные ретракции

**Files:**
- Create: `apps/client/src/features/game/model/draft.ts`
- Create: `apps/client/src/features/game/model/draft.test.ts`
- Create: `apps/client/src/features/game/ui/RetractionComposer.tsx`
- Test: `apps/client/src/features/game/ui/RetractionComposer.test.tsx`

- [ ] **Step 1: Write failing model tests for every MVP retraction kind**

`apps/client/src/features/game/model/draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Square } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { buildPreview, draftReducer, initialDraft } from "./draft";

function choose(fen: string, current: string, previous: string) {
  const post = parseFen(fen);
  let state = draftReducer(post, "w", initialDraft, { type: "select-square", square: current as Square });
  state = draftReducer(post, "w", state, { type: "select-square", square: previous as Square });
  return { post, state };
}

describe("retraction draft", () => {
  it("previews an ordinary capture restored on the arrival square", () => {
    const { post, state: selected } = choose(
      "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
      "d5",
      "e4",
    );
    const state = draftReducer(post, "w", selected, { type: "set-capture", pieceType: "p" });
    const preview = buildPreview(post, "w", state);
    expect(preview.ok && preview.retraction).toMatchObject({
      currentSquare: "d5",
      previousSquare: "e4",
      restoredPiece: { color: "b", type: "p", square: "d5" },
      special: "normal",
    });
    expect(preview.ok && preview.previous.board.e4).toEqual({ color: "w", type: "p" });
  });

  it("delegates castling, en-passant and unpromotion previews to game-core", () => {
    const castle = choose("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1", "g1", "e1");
    const castleState = draftReducer(castle.post, "w", castle.state, {
      type: "set-special",
      special: "castle-kingside",
    });
    const castlePreview = buildPreview(castle.post, "w", castleState);
    expect(castlePreview.ok && castlePreview.previous.board.h1).toEqual({ color: "w", type: "r" });

    const passant = choose("4k3/8/3P4/8/8/8/8/4K3 b - - 0 1", "d6", "e5");
    const passantState = draftReducer(passant.post, "w", passant.state, {
      type: "set-special",
      special: "en-passant",
    });
    const passantPreview = buildPreview(passant.post, "w", passantState);
    expect(passantPreview.ok && passantPreview.previous.board.d5).toEqual({ color: "b", type: "p" });

    const promotion = choose("Q3k3/8/8/8/8/8/8/4K3 b - - 0 1", "a8", "a7");
    const promotionState = draftReducer(promotion.post, "w", promotion.state, {
      type: "set-special",
      special: "unpromotion",
    });
    const promotionPreview = buildPreview(promotion.post, "w", promotionState);
    expect(promotionPreview.ok && promotionPreview.previous.board.a7).toEqual({ color: "w", type: "p" });
  });

  it("does not select an opponent piece as the last mover", () => {
    const post = parseFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(draftReducer(post, "w", initialDraft, { type: "select-square", square: "e8" }))
      .toEqual(initialDraft);
  });
});
```

- [ ] **Step 2: Run model tests RED**

Run: `npm test -w @a-move-ago/client -- src/features/game/model/draft.test.ts`

Expected: FAIL because `draft.ts` does not exist.

- [ ] **Step 3: Implement the pure draft reducer and validated preview**

`apps/client/src/features/game/model/draft.ts`:

```ts
import type { Color, PieceType, Retraction, Square } from "@a-move-ago/api-contract";
import { applyRetraction, RetractionError, type FenState } from "@a-move-ago/game-core";

export type CapturePieceType = Exclude<PieceType, "k">;

export type DraftState =
  | { tag: "select-current" }
  | { tag: "select-previous"; currentSquare: Square }
  | {
      tag: "configure";
      currentSquare: Square;
      previousSquare: Square;
      special: Retraction["special"];
      captureType: CapturePieceType | null;
    };

export type DraftEvent =
  | { type: "select-square"; square: Square }
  | { type: "set-special"; special: Retraction["special"] }
  | { type: "set-capture"; pieceType: CapturePieceType | null }
  | { type: "reset" };

export const initialDraft: DraftState = { tag: "select-current" };

export function draftReducer(
  post: FenState,
  retractingColor: Color,
  state: DraftState,
  event: DraftEvent,
): DraftState {
  if (event.type === "reset") return initialDraft;
  if (event.type === "select-square") {
    if (state.tag === "select-current") {
      return post.board[event.square]?.color === retractingColor
        ? { tag: "select-previous", currentSquare: event.square }
        : state;
    }
    if (state.tag === "select-previous") {
      if (event.square === state.currentSquare || post.board[event.square]) return state;
      return {
        tag: "configure",
        currentSquare: state.currentSquare,
        previousSquare: event.square,
        special: "normal",
        captureType: null,
      };
    }
    return post.board[event.square]?.color === retractingColor
      ? { tag: "select-previous", currentSquare: event.square }
      : state;
  }
  if (state.tag !== "configure") return state;
  if (event.type === "set-capture") {
    if (state.special.startsWith("castle") || state.special === "en-passant") return state;
    return { ...state, captureType: event.pieceType };
  }
  if (event.type === "set-special") {
    return {
      ...state,
      special: event.special,
      captureType: event.special === "en-passant"
        ? "p"
        : event.special.startsWith("castle")
          ? null
          : state.captureType,
    };
  }
  return state;
}

function opponent(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function restoreSquare(state: Extract<DraftState, { tag: "configure" }>): Square {
  return state.special === "en-passant"
    ? `${state.currentSquare[0]}${state.previousSquare[1]}` as Square
    : state.currentSquare;
}

export type DraftPreview =
  | { ok: true; retraction: Retraction; previous: FenState }
  | { ok: false; reason: string };

export function buildPreview(
  post: FenState,
  retractingColor: Color,
  state: DraftState,
): DraftPreview {
  if (state.tag !== "configure") return { ok: false, reason: "Choose current and previous squares." };
  const movedPiece = post.board[state.currentSquare];
  if (!movedPiece || movedPiece.color !== retractingColor) {
    return { ok: false, reason: "The selected piece cannot be retracted." };
  }
  const restoredPiece = state.captureType
    ? { color: opponent(retractingColor), type: state.captureType, square: restoreSquare(state) }
    : null;
  const retraction: Retraction = {
    currentSquare: state.currentSquare,
    previousSquare: state.previousSquare,
    movedPiece,
    restoredPiece,
    special: state.special,
  };
  try {
    return { ok: true, retraction, previous: applyRetraction(post, retraction) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof RetractionError ? error.code : "This retraction cannot be previewed.",
    };
  }
}
```

- [ ] **Step 4: Build the tap/keyboard composer**

`apps/client/src/features/game/ui/RetractionComposer.tsx`:

```tsx
import { useReducer } from "react";
import type { Color, Retraction } from "@a-move-ago/api-contract";
import type { FenState } from "@a-move-ago/game-core";
import {
  buildPreview,
  type CapturePieceType,
  draftReducer,
  initialDraft,
} from "../model/draft";
import { Chessboard } from "./Chessboard";

const captureOptions: ReadonlyArray<{ value: CapturePieceType; label: string }> = [
  { value: "p", label: "Pawn" },
  { value: "n", label: "Knight" },
  { value: "b", label: "Bishop" },
  { value: "r", label: "Rook" },
  { value: "q", label: "Queen" },
];

export function RetractionComposer(props: {
  post: FenState;
  retractingColor: Color;
  disabled: boolean;
  onSubmit(retraction: Retraction): void;
}) {
  const [draft, dispatch] = useReducer(
    (state: typeof initialDraft | ReturnType<typeof draftReducer>, event: Parameters<typeof draftReducer>[3]) =>
      draftReducer(props.post, props.retractingColor, state, event),
    initialDraft,
  );
  const preview = buildPreview(props.post, props.retractingColor, draft);
  const board = preview.ok ? preview.previous.board : props.post.board;
  const selectedSquare = draft.tag === "select-current" ? null : draft.currentSquare;
  const instruction = draft.tag === "select-current"
    ? "Choose the piece that moved last."
    : draft.tag === "select-previous"
      ? "Choose the square it came from."
      : "Add a captured piece or special move, then submit.";

  return (
    <section aria-labelledby="retraction-heading">
      <h2 id="retraction-heading">Reconstruct the previous position</h2>
      <p aria-live="polite">{instruction}</p>
      <Chessboard
        board={board}
        disabled={props.disabled}
        label="Interactive retraction board"
        onSelect={(square) => dispatch({ type: "select-square", square })}
        orientation={props.retractingColor === "w" ? "white" : "black"}
        selectedSquare={selectedSquare}
      />
      {draft.tag === "configure" ? (
        <fieldset disabled={props.disabled}>
          <legend>Retraction details</legend>
          <label>
            Special move
            <select
              aria-label="Special move"
              onChange={(event) => dispatch({
                type: "set-special",
                special: event.currentTarget.value as Retraction["special"],
              })}
              value={draft.special}
            >
              <option value="normal">Normal move</option>
              <option value="castle-kingside">Castle kingside</option>
              <option value="castle-queenside">Castle queenside</option>
              <option value="en-passant">En passant</option>
              <option value="unpromotion">Reverse promotion</option>
            </select>
          </label>
          <label>
            Captured piece
            <select
              aria-label="Captured piece"
              disabled={props.disabled || draft.special.startsWith("castle") || draft.special === "en-passant"}
              onChange={(event) => dispatch({
                type: "set-capture",
                pieceType: event.currentTarget.value === ""
                  ? null
                  : event.currentTarget.value as CapturePieceType,
              })}
              value={draft.captureType ?? ""}
            >
              <option value="">None</option>
              {captureOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </fieldset>
      ) : null}
      {!preview.ok && draft.tag === "configure" ? <p role="alert">{preview.reason}</p> : null}
      <div>
        <button type="button" disabled={props.disabled} onClick={() => dispatch({ type: "reset" })}>
          Reset
        </button>
        <button
          type="button"
          disabled={props.disabled || !preview.ok}
          onClick={() => { if (preview.ok) props.onSubmit(preview.retraction); }}
        >
          Submit retraction
        </button>
      </div>
    </section>
  );
}
```

`apps/client/src/features/game/ui/RetractionComposer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { parseFen } from "@a-move-ago/game-core";
import { RetractionComposer } from "./RetractionComposer";

it("submits a capture through clicks and native selects", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2")}
      retractingColor="w"
    />,
  );
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(screen.getByRole("button", { name: "Submit retraction" }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({
    currentSquare: "d5",
    previousSquare: "e4",
    restoredPiece: { color: "b", type: "p", square: "d5" },
  }));
});
```

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/features/game/model/draft.test.ts src/features/game/ui/RetractionComposer.test.tsx`

Expected: PASS, 4 tests covering normal capture, all three special families, wrong-color rejection and the end-user click path.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/features/game
git commit -m "feat: compose normal and special retractions"
```

### Task 9: Загрузить daily case только после guest bootstrap

**Files:**
- Create: `apps/client/src/features/daily/use-daily-case.ts`
- Create: `apps/client/src/features/daily/use-daily-case.test.tsx`
- Create: `apps/client/src/features/daily/DailyCaseGate.tsx`

- [ ] **Step 1: Write the failing gated-load test**

`apps/client/src/features/daily/use-daily-case.test.tsx`:

```tsx
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { useDailyCase } from "./use-daily-case";

const daily = {
  id: "case-2026-08-03",
  date: "2026-08-03",
  title: "The missing pawn",
  puzzles: [{
    id: "opening-exd5",
    version: 1,
    title: "A pawn vanished",
    prompt: "What happened one move ago?",
    postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
    retractingColor: "w" as const,
    maxHints: 2,
    provenance: "A MOVE AGO sample",
    license: "CC BY 4.0",
  }],
  solvedPuzzleIds: [],
};

it("does not request daily content until a session is ready", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
  runtime.api.getDaily = vi.fn().mockResolvedValue(daily);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const { rerender, result } = renderHook(
    ({ enabled }) => useDailyCase(enabled, "2026-08-03"),
    { initialProps: { enabled: false }, wrapper },
  );
  expect(result.current.state.tag).toBe("idle");
  expect(runtime.api.getDaily).not.toHaveBeenCalled();

  rerender({ enabled: true });
  await waitFor(() => expect(result.current.state.tag).toBe("ready"));
  expect(runtime.api.getDaily).toHaveBeenCalledWith("2026-08-03", expect.any(AbortSignal));
  expect(JSON.stringify(daily)).not.toContain("acceptedSolutions");
  expect(JSON.stringify(daily)).not.toContain("previousFen");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/features/daily/use-daily-case.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the abortable GET controller**

`apps/client/src/features/daily/use-daily-case.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import type { DailyCaseResponseSchema } from "@a-move-ago/api-contract";
import { useRuntime } from "../../app/runtime";
import { classifyFailure, type ClientFailure } from "../../shared/failure";
import { retryGet } from "../../shared/retry-get";

export type DailyCase = z.infer<typeof DailyCaseResponseSchema>;

export type DailyLoadState =
  | { tag: "idle" }
  | { tag: "loading" }
  | { tag: "ready"; daily: DailyCase }
  | { tag: "error"; failure: ClientFailure };

export function useDailyCase(enabled: boolean, caseDate: string | null) {
  const runtime = useRuntime();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DailyLoadState>({ tag: "idle" });

  useEffect(() => {
    if (!enabled) {
      setState({ tag: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ tag: "loading" });
    void retryGet(
      () => runtime.api.getDaily(caseDate ?? undefined, controller.signal),
      {
        maxAttempts: 3,
        baseDelayMs: 250,
        random: Math.random,
        sleep: runtime.sleep,
        signal: controller.signal,
      },
    ).then((daily) => {
      if (!controller.signal.aborted) setState({ tag: "ready", daily });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ tag: "error", failure: classifyFailure(error) });
    });
    return () => controller.abort();
  }, [caseDate, enabled, revision, runtime]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { state, retry };
}
```

- [ ] **Step 4: Add recoverable content UI**

`apps/client/src/features/daily/DailyCaseGate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useDailyCase, type DailyCase } from "./use-daily-case";

function message(kind: "offline" | "auth" | "rate-limit" | "content" | "server" | "contract") {
  switch (kind) {
    case "offline": return "You appear to be offline. Your board has not been submitted.";
    case "auth": return "The guest session expired. Reload to start a new guest session.";
    case "rate-limit": return "Too many requests. Wait a moment and retry.";
    case "content": return "There is no published case for this date.";
    case "contract": return "The case response was not understood.";
    case "server": return "The case service is temporarily unavailable.";
  }
}

export function DailyCaseGate(props: {
  enabled: boolean;
  caseDate: string | null;
  children(daily: DailyCase): ReactNode;
}) {
  const { state, retry } = useDailyCase(props.enabled, props.caseDate);
  if (state.tag === "idle" || state.tag === "loading") return <p role="status">Loading today’s case…</p>;
  if (state.tag === "error") {
    const requestId = "requestId" in state.failure ? state.failure.requestId : undefined;
    return (
      <section aria-labelledby="daily-error-heading">
        <h2 id="daily-error-heading">Case unavailable</h2>
        <p role="alert">{message(state.failure.kind)}</p>
        {requestId ? <p>Request ID: <code>{requestId}</code></p> : null}
        <button type="button" onClick={retry}>Retry case</button>
      </section>
    );
  }
  return props.children(state.daily);
}
```

- [ ] **Step 5: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/features/daily/use-daily-case.test.tsx`

Expected: PASS, 1 test; daily content is absent before session readiness and contains no reveal fields after load.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/features/daily
git commit -m "feat: gate daily cases behind guest bootstrap"
```

### Task 10: Заморозить attempt UUID и сделать POST retry только явным

**Files:**
- Create: `apps/client/src/features/game/model/attempt.ts`
- Create: `apps/client/src/features/game/model/attempt.test.tsx`

- [ ] **Step 1: Write failing lost-response and hint-retry tests**

`apps/client/src/features/game/model/attempt.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { ApiTransportError } from "@a-move-ago/api-contract";
import { RuntimeProvider } from "../../../app/runtime";
import { runtimeFixture } from "../../../test/runtime-fixture";
import { useAttempt } from "./attempt";

const retraction = {
  currentSquare: "d5",
  previousSquare: "e4",
  movedPiece: { color: "w", type: "p" },
  restoredPiece: { color: "b", type: "p", square: "d5" },
  special: "normal",
} as const;

function setup() {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
  );
  const hook = renderHook(() => useAttempt("case-2026-08-03", "opening-exd5"), { wrapper });
  return { runtime, ...hook };
}

it("retries a lost attempt response with the same object and UUID", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi.fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "The pawn came from another square." },
    });

  await act(() => result.current.submit(retraction));
  expect(result.current.attempt.tag).toBe("retry");
  expect(runtime.api.submitAttempt).toHaveBeenCalledOnce();
  await act(() => result.current.retryAttempt());

  const first = vi.mocked(runtime.api.submitAttempt).mock.calls[0]?.[0];
  const second = vi.mocked(runtime.api.submitAttempt).mock.calls[1]?.[0];
  expect(second).toBe(first);
  expect(first?.attemptUuid).toBe("22222222-2222-4222-8222-222222222222");
  expect(result.current.attempt.tag).toBe("incorrect");
});

it("uses the server attempt ID and same requested hint level on explicit retry", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi.fn().mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    attemptUuid: "22222222-2222-4222-8222-222222222222",
    correct: false,
    contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
  });
  runtime.api.requestHint = vi.fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockResolvedValueOnce({ level: 1, text: "A pawn changed files.", exhausted: false });

  await act(() => result.current.submit(retraction));
  await act(() => result.current.requestHint());
  expect(result.current.hints.tag).toBe("retry");
  await act(() => result.current.retryHint());
  expect(vi.mocked(runtime.api.requestHint).mock.calls.map(([attemptId, level]) => [attemptId, level]))
    .toEqual([
      ["11111111-1111-4111-8111-111111111111", 1],
      ["11111111-1111-4111-8111-111111111111", 1],
    ]);
  expect(result.current.hints).toMatchObject({
    tag: "idle",
    items: [{ level: 1, text: "A pawn changed files.", exhausted: false }],
  });
});

it("discards a late hint response after a newer submit", async () => {
  const { runtime, result } = setup();
  runtime.api.submitAttempt = vi.fn()
    .mockResolvedValueOnce({
      id: "11111111-1111-4111-8111-111111111111",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Try another move." },
    })
    .mockResolvedValueOnce({
      id: "44444444-4444-4444-8444-444444444444",
      attemptUuid: "22222222-2222-4222-8222-222222222222",
      correct: false,
      contradiction: { code: "NOT_THE_LAST_MOVE", message: "Still not the last move." },
    });

  let resolveOldHint: ((hint: { level: number; text: string; exhausted: boolean }) => void) | undefined;
  runtime.api.requestHint = vi.fn(() => new Promise<{
    level: number;
    text: string;
    exhausted: boolean;
  }>((resolve) => {
    resolveOldHint = resolve;
  }));

  await act(() => result.current.submit(retraction));
  await act(async () => {
    void result.current.requestHint();
    await Promise.resolve();
  });
  expect(result.current.hints.tag).toBe("loading");

  await act(() => result.current.submit(retraction));
  expect(vi.mocked(runtime.api.requestHint).mock.calls[0]?.[2]?.aborted).toBe(true);
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });

  await act(async () => {
    resolveOldHint?.({ level: 1, text: "This response is stale.", exhausted: false });
    await Promise.resolve();
  });
  expect(result.current.hints).toEqual({ tag: "idle", items: [] });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/features/game/model/attempt.test.tsx`

Expected: FAIL because `attempt.ts` does not exist.

- [ ] **Step 3: Implement the attempt and hint controller**

`apps/client/src/features/game/model/attempt.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type {
  AttemptRequestSchema,
  AttemptResultSchema,
  HintResponseSchema,
  Retraction,
} from "@a-move-ago/api-contract";
import { useRuntime } from "../../../app/runtime";
import { classifyFailure, type ClientFailure } from "../../../shared/failure";

type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
type AttemptResult = z.infer<typeof AttemptResultSchema>;
type IncorrectResult = Extract<AttemptResult, { correct: false }>;
type CorrectResult = Extract<AttemptResult, { correct: true }>;
type Hint = z.infer<typeof HintResponseSchema>;

export type AttemptState =
  | { tag: "idle" }
  | { tag: "submitting"; request: AttemptRequest }
  | { tag: "retry"; request: AttemptRequest; failure: ClientFailure }
  | { tag: "incorrect"; request: AttemptRequest; result: IncorrectResult }
  | { tag: "solved"; request: AttemptRequest; result: CorrectResult };

interface HintRequest {
  attemptId: string;
  level: number;
}

export type HintState =
  | { tag: "idle"; items: readonly Hint[] }
  | { tag: "loading"; items: readonly Hint[]; request: HintRequest }
  | { tag: "retry"; items: readonly Hint[]; request: HintRequest; failure: ClientFailure };

function frozenRetraction(value: Retraction): Retraction {
  return Object.freeze({
    ...value,
    movedPiece: Object.freeze({ ...value.movedPiece }),
    restoredPiece: value.restoredPiece ? Object.freeze({ ...value.restoredPiece }) : null,
  });
}

export function useAttempt(caseId: string, puzzleId: string) {
  const runtime = useRuntime();
  const [attempt, setAttempt] = useState<AttemptState>({ tag: "idle" });
  const [hints, setHints] = useState<HintState>({ tag: "idle", items: [] });
  const attemptAbort = useRef<AbortController | null>(null);
  const hintAbort = useRef<AbortController | null>(null);

  useEffect(() => () => {
    attemptAbort.current?.abort();
    hintAbort.current?.abort();
  }, []);

  const sendAttempt = useCallback(async (request: AttemptRequest) => {
    if (attemptAbort.current) return;
    const controller = new AbortController();
    attemptAbort.current = controller;
    setAttempt({ tag: "submitting", request });
    try {
      const result = await runtime.api.submitAttempt(request, controller.signal);
      if (controller.signal.aborted) return;
      setAttempt(result.correct
        ? { tag: "solved", request, result }
        : { tag: "incorrect", request, result });
    } catch (error) {
      if (!controller.signal.aborted) {
        setAttempt({ tag: "retry", request, failure: classifyFailure(error) });
      }
    } finally {
      if (attemptAbort.current === controller) attemptAbort.current = null;
    }
  }, [runtime]);

  const submit = useCallback(async (retraction: Retraction) => {
    if (attempt.tag === "submitting") return;
    const request = Object.freeze({
      attemptUuid: runtime.attemptUuid(),
      caseId,
      puzzleId,
      retraction: frozenRetraction(retraction),
    }) satisfies AttemptRequest;
    hintAbort.current?.abort();
    hintAbort.current = null;
    setHints({ tag: "idle", items: [] });
    await sendAttempt(request);
  }, [attempt.tag, caseId, puzzleId, runtime, sendAttempt]);

  const retryAttempt = useCallback(async () => {
    if (attempt.tag === "retry") await sendAttempt(attempt.request);
  }, [attempt, sendAttempt]);

  const sendHint = useCallback(async (request: HintRequest, items: readonly Hint[]) => {
    if (hintAbort.current) return;
    const controller = new AbortController();
    hintAbort.current = controller;
    setHints({ tag: "loading", items, request });
    try {
      const hint = await runtime.api.requestHint(request.attemptId, request.level, controller.signal);
      if (controller.signal.aborted) return;
      const next = items.some((item) => item.level === hint.level) ? items : [...items, hint];
      setHints({ tag: "idle", items: next });
    } catch (error) {
      if (!controller.signal.aborted) {
        setHints({ tag: "retry", items, request, failure: classifyFailure(error) });
      }
    } finally {
      if (hintAbort.current === controller) hintAbort.current = null;
    }
  }, [runtime]);

  const requestHint = useCallback(async () => {
    if (attempt.tag !== "incorrect" || hints.tag !== "idle") return;
    await sendHint({ attemptId: attempt.result.id, level: hints.items.length + 1 }, hints.items);
  }, [attempt, hints, sendHint]);

  const retryHint = useCallback(async () => {
    if (hints.tag === "retry") await sendHint(hints.request, hints.items);
  }, [hints, sendHint]);

  return { attempt, hints, submit, retryAttempt, requestHint, retryHint };
}
```

There is deliberately no timer or effect that resubmits `submitAttempt` or `requestHint`. Only `Retry attempt` and `Retry hint` call the controller again, carrying the same frozen attempt request or the same `{ attemptId, level }`. This matches API idempotency for `(session_id, attempt_uuid)` and retry-safe hint levels.

- [ ] **Step 4: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/features/game/model/attempt.test.tsx`

Expected: PASS, 3 tests; the first POST is called once before the user retry, both replay assertions use the exact UUID/server attempt ID/level, and an aborted stale hint cannot overwrite a newer attempt.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/features/game/model/attempt.ts apps/client/src/features/game/model/attempt.test.tsx
git commit -m "feat: make attempts and hints explicitly retryable"
```

### Task 11: Собрать reveal, ordered acts, stats и app shell

**Files:**
- Create: `apps/client/src/features/game/ui/RevealPlayer.tsx`
- Create: `apps/client/src/features/game/ui/RevealPlayer.test.tsx`
- Create: `apps/client/src/features/game/ui/PuzzleGame.tsx`
- Create: `apps/client/src/features/daily/case-progress.ts`
- Create: `apps/client/src/features/daily/case-progress.test.ts`
- Create: `apps/client/src/features/daily/CaseGame.tsx`
- Create: `apps/client/src/features/stats/use-stats.ts`
- Create: `apps/client/src/features/stats/StatsPanel.tsx`
- Create: `apps/client/src/styles/game.css`
- Modify: `apps/client/src/styles/base.css`
- Modify: `apps/client/src/App.tsx`
- Test: `apps/client/src/App.test.tsx`

- [ ] **Step 1: Write failing reveal and ordered-act tests**

`apps/client/src/features/game/ui/RevealPlayer.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RevealPlayer } from "./RevealPlayer";

const solution = {
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
} as const;

it("shows the prior position, replays forward, then completes", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  render(
    <RevealPlayer
      onComplete={complete}
      postFen="rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"
      solution={solution}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Rewinding the last move");
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getByRole("status")).toHaveTextContent("Previous position reconstructed");
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByRole("status")).toHaveTextContent("Playing exd5 forward");
  expect(complete).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(750));
  expect(complete).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
```

`apps/client/src/features/daily/case-progress.test.ts`:

```ts
import { expect, it } from "vitest";
import { nextUnsolvedIndex } from "./case-progress";

it("preserves server puzzle order across multiple acts", () => {
  const ids = ["act-1", "act-2", "act-3"];
  expect(nextUnsolvedIndex(ids, new Set())).toBe(0);
  expect(nextUnsolvedIndex(ids, new Set(["act-1"]))).toBe(1);
  expect(nextUnsolvedIndex(ids, new Set(["act-1", "act-2"]))).toBe(2);
  expect(nextUnsolvedIndex(ids, new Set(ids))).toBeNull();
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -w @a-move-ago/client -- src/features/game/ui/RevealPlayer.test.tsx src/features/daily/case-progress.test.ts`

Expected: FAIL because reveal and progress modules do not exist.

- [ ] **Step 3: Implement the deterministic reveal timeline**

`apps/client/src/features/game/ui/RevealPlayer.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { Chessboard } from "./Chessboard";

type RevealStage = "post" | "previous" | "forward" | "done";

export function RevealPlayer(props: {
  postFen: string;
  solution: AcceptedSolution;
  onComplete(): void;
}) {
  const [stage, setStage] = useState<RevealStage>("post");
  const complete = useRef(props.onComplete);
  complete.current = props.onComplete;
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const previous = useMemo(() => parseFen(props.solution.previousFen), [props.solution.previousFen]);
  const post = useMemo(() => parseFen(props.postFen), [props.postFen]);

  useEffect(() => {
    const rewindAt = reduced ? 0 : 50;
    const forwardAt = reduced ? 0 : 800;
    const doneAt = reduced ? 0 : 1_550;
    const rewind = setTimeout(() => setStage("previous"), rewindAt);
    const forward = setTimeout(() => setStage("forward"), forwardAt);
    const done = setTimeout(() => {
      setStage("done");
      complete.current();
    }, doneAt);
    return () => {
      clearTimeout(rewind);
      clearTimeout(forward);
      clearTimeout(done);
    };
  }, [props.postFen, props.solution.previousFen, reduced]);

  const showingPrevious = stage === "previous";
  const announcement = stage === "post"
    ? "Rewinding the last move."
    : stage === "previous"
      ? "Previous position reconstructed."
      : stage === "forward"
        ? `Playing ${props.solution.forwardSan} forward.`
        : "Solution replay complete.";
  return (
    <section aria-labelledby="solution-heading">
      <h2 id="solution-heading">Solved</h2>
      <p role="status" aria-live="polite">{announcement}</p>
      <div className={`reveal-board reveal-${stage}`}>
        <Chessboard
          board={showingPrevious ? previous.board : post.board}
          disabled
          label={showingPrevious ? "Reconstructed previous position" : "Position after the true move"}
          onSelect={() => undefined}
          orientation={props.solution.retraction.movedPiece.color === "w" ? "white" : "black"}
          selectedSquare={null}
        />
      </div>
      <p><strong>{props.solution.forwardSan}</strong> — {props.solution.explanation}</p>
    </section>
  );
}
```

`apps/client/src/styles/game.css`:

```css
.game-layout { display: grid; gap: 1rem; justify-items: center; }
.game-copy { width: min(100%, 40rem); }
.feedback-panel { width: min(100%, 32rem); padding: 0.8rem; border: 1px solid #6d6961; }
.hint-list { padding-left: 1.5rem; }
.reveal-board { transition: opacity 180ms ease, transform 260ms ease; }
.reveal-post { opacity: 0.65; transform: scale(0.985); }
.reveal-previous { opacity: 1; transform: scale(1); }
.reveal-forward,
.reveal-done { opacity: 1; transform: scale(1.01); }

@media (prefers-reduced-motion: reduce) {
  .reveal-board { transition: none; }
}
```

Prepend this import with the other CSS imports in `apps/client/src/styles/base.css`:

```css
@import "./game.css";
```

- [ ] **Step 4: Implement stats GET and the complete puzzle panel**

`apps/client/src/features/stats/use-stats.ts`:

```ts
import { useCallback, useEffect, useState } from "react";
import type { z } from "zod";
import type { StatsResponseSchema } from "@a-move-ago/api-contract";
import { useRuntime } from "../../app/runtime";
import { classifyFailure, type ClientFailure } from "../../shared/failure";
import { retryGet } from "../../shared/retry-get";

type Stats = z.infer<typeof StatsResponseSchema>;
type StatsState =
  | { tag: "loading" }
  | { tag: "ready"; stats: Stats }
  | { tag: "error"; failure: ClientFailure };

export function useStats(enabled: boolean, refreshKey = "default") {
  const runtime = useRuntime();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<StatsState>({ tag: "loading" });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ tag: "loading" });
    void retryGet(() => runtime.api.getStats(controller.signal), {
      maxAttempts: 3,
      baseDelayMs: 250,
      random: Math.random,
      sleep: runtime.sleep,
      signal: controller.signal,
    }).then((stats) => {
      if (!controller.signal.aborted) setState({ tag: "ready", stats });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ tag: "error", failure: classifyFailure(error) });
    });
    return () => controller.abort();
  }, [enabled, refreshKey, revision, runtime]);
  return { state, retry: useCallback(() => setRevision((value) => value + 1), []) };
}
```

`apps/client/src/features/stats/StatsPanel.tsx`:

```tsx
import { useStats } from "./use-stats";

export function StatsPanel(props: { title?: string; refreshKey?: string }) {
  const { title = "Case complete", refreshKey = "default" } = props;
  const { state, retry } = useStats(true, refreshKey);
  if (state.tag === "loading") return <p role="status">Updating statistics…</p>;
  if (state.tag === "error") {
    return (
      <section>
        <p role="alert">Statistics could not be refreshed.</p>
        <button type="button" onClick={retry}>Retry statistics</button>
      </section>
    );
  }
  return (
    <section aria-labelledby="stats-heading">
      <h2 id="stats-heading">{title}</h2>
      <dl>
        <dt>Current streak</dt><dd>{state.stats.currentStreak}</dd>
        <dt>Best streak</dt><dd>{state.stats.bestStreak}</dd>
        <dt>Solved puzzles</dt><dd>{state.stats.solvedPuzzles}</dd>
        <dt>Hints used</dt><dd>{state.stats.hintsUsed}</dd>
      </dl>
    </section>
  );
}
```

`apps/client/src/features/game/ui/PuzzleGame.tsx`:

```tsx
import { useEffect, useMemo } from "react";
import type { PuzzlePublic } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { useRuntime } from "../../../app/runtime";
import { useAttempt } from "../model/attempt";
import { RetractionComposer } from "./RetractionComposer";
import { RevealPlayer } from "./RevealPlayer";

function retryCopy(kind: string): string {
  return kind === "offline"
    ? "No response was received. Retry sends the same attempt UUID."
    : "The attempt could not be confirmed. Retry the same attempt.";
}

function requestId(failure: { kind: string }): string | null {
  return "requestId" in failure && typeof failure.requestId === "string"
    ? failure.requestId
    : null;
}

export function PuzzleGame(props: {
  caseId: string;
  puzzle: PuzzlePublic;
  onSolved(): void;
}) {
  const runtime = useRuntime();
  const post = useMemo(() => parseFen(props.puzzle.postFen), [props.puzzle.postFen]);
  const controller = useAttempt(props.caseId, props.puzzle.id);

  useEffect(() => {
    if (controller.attempt.tag === "solved") void runtime.platform.haptic("success");
    if (controller.attempt.tag === "incorrect") void runtime.platform.haptic("error");
  }, [controller.attempt.tag, runtime.platform]);

  if (controller.attempt.tag === "solved") {
    return (
      <RevealPlayer
        onComplete={props.onSolved}
        postFen={props.puzzle.postFen}
        solution={controller.attempt.result.reveal}
      />
    );
  }

  const hintItems = controller.hints.items;
  const exhausted = hintItems.at(-1)?.exhausted ?? false;
  return (
    <article className="game-layout">
      <div className="game-copy">
        <h2>{props.puzzle.title}</h2>
        <p>{props.puzzle.prompt}</p>
      </div>
      <RetractionComposer
        disabled={controller.attempt.tag === "submitting" || controller.attempt.tag === "retry"}
        onSubmit={(retraction) => { void controller.submit(retraction); }}
        post={post}
        retractingColor={props.puzzle.retractingColor}
      />
      <section className="feedback-panel" aria-label="Attempt feedback">
        {controller.attempt.tag === "submitting" ? <p role="status">Checking retraction…</p> : null}
        {controller.attempt.tag === "retry" ? (
          <div>
            <p role="alert">{retryCopy(controller.attempt.failure.kind)}</p>
            {requestId(controller.attempt.failure)
              ? <p>Request ID: <code>{requestId(controller.attempt.failure)}</code></p>
              : null}
            <button type="button" onClick={() => { void controller.retryAttempt(); }}>Retry attempt</button>
          </div>
        ) : null}
        {controller.attempt.tag === "incorrect" ? (
          <div>
            <p role="alert">{controller.attempt.result.contradiction.message}</p>
            {!exhausted && hintItems.length < props.puzzle.maxHints && controller.hints.tag !== "retry" ? (
              <button
                type="button"
                disabled={controller.hints.tag === "loading"}
                onClick={() => { void controller.requestHint(); }}
              >
                {controller.hints.tag === "loading" ? "Requesting hint…" : "Get hint"}
              </button>
            ) : null}
            {controller.hints.tag === "retry" ? (
              <div>
                <p role="alert">Hint was not received. Retry requests the same level.</p>
                {requestId(controller.hints.failure)
                  ? <p>Request ID: <code>{requestId(controller.hints.failure)}</code></p>
                  : null}
                <button type="button" onClick={() => { void controller.retryHint(); }}>Retry hint</button>
              </div>
            ) : null}
          </div>
        ) : null}
        {hintItems.length ? (
          <ol className="hint-list" aria-label="Hints">
            {hintItems.map((hint) => <li key={hint.level}>{hint.text}</li>)}
          </ol>
        ) : null}
      </section>
      <footer>{props.puzzle.provenance} · {props.puzzle.license}</footer>
    </article>
  );
}
```

- [ ] **Step 5: Advance ordered acts and fetch stats only after reveal completion**

`apps/client/src/features/daily/case-progress.ts`:

```ts
export function nextUnsolvedIndex(
  puzzleIds: readonly string[],
  solved: ReadonlySet<string>,
): number | null {
  const index = puzzleIds.findIndex((id) => !solved.has(id));
  return index === -1 ? null : index;
}
```

`apps/client/src/features/daily/CaseGame.tsx`:

```tsx
import { useMemo, useState } from "react";
import { PuzzleGame } from "../game/ui/PuzzleGame";
import { StatsPanel } from "../stats/StatsPanel";
import { nextUnsolvedIndex } from "./case-progress";
import type { DailyCase } from "./use-daily-case";

export function CaseGame({ daily }: { daily: DailyCase }) {
  const [solved, setSolved] = useState<ReadonlySet<string>>(
    () => new Set(daily.solvedPuzzleIds),
  );
  const puzzleIds = useMemo(() => daily.puzzles.map((puzzle) => puzzle.id), [daily.puzzles]);
  const index = nextUnsolvedIndex(puzzleIds, solved);
  if (index === null) return <StatsPanel />;
  const puzzle = daily.puzzles[index];
  if (!puzzle) return <p role="alert">Case puzzle order is invalid.</p>;
  return (
    <section aria-labelledby="case-title">
      <header>
        <h1 id="case-title">{daily.title}</h1>
        <p>Act {index + 1} of {daily.puzzles.length}</p>
      </header>
      <PuzzleGame
        caseId={daily.id}
        key={puzzle.id}
        onSolved={() => setSolved((current) => new Set([...current, puzzle.id]))}
        puzzle={puzzle}
      />
    </section>
  );
}
```

The solved ID is added only by `RevealPlayer.onComplete`; therefore `StatsPanel` cannot mount and call `GET /v1/me/stats` until the reverse animation and true forward move have both played. With multiple puzzles, the next server-ordered act mounts first and stats wait for the final act.

- [ ] **Step 6: Compose guest-first App, memory navigation and host lifecycle**

Replace `apps/client/src/App.tsx`:

```tsx
import { useEffect, useMemo, useReducer } from "react";
import { initialNavigation, navigationReducer } from "./app/navigation";
import { parseEntryQuery } from "./app/entry-query";
import { useHostBack } from "./app/use-host-back";
import { useRuntime } from "./app/runtime";
import { CaseGame } from "./features/daily/CaseGame";
import { DailyCaseGate } from "./features/daily/DailyCaseGate";
import { SaveProgressButton } from "./features/session/SaveProgressButton";
import { SessionProvider, useSession } from "./features/session/SessionProvider";
import { StatsPanel } from "./features/stats/StatsPanel";

function AppContent() {
  const runtime = useRuntime();
  const { state } = useSession();
  const entry = useMemo(() => parseEntryQuery(new URL(window.location.href)), []);
  const [navigation, dispatch] = useReducer(
    navigationReducer,
    entry.caseDate,
    initialNavigation,
  );
  useHostBack(navigation, dispatch);

  useEffect(() => {
    const disposeLayout = runtime.platform.installLayoutVars(document.documentElement);
    void runtime.platform.ready();
    return disposeLayout;
  }, [runtime.platform]);

  const screen = navigation.stack.at(-1) ?? { name: "case" as const };
  const sessionReady = state.tag !== "booting" && state.tag !== "fatal";
  const me = "me" in state ? state.me : null;
  return (
    <main className="app-shell">
      <header>
        <strong>A MOVE AGO</strong>
        {screen.name === "profile" ? (
          <button type="button" onClick={() => dispatch({ type: "back" })}>Back to case</button>
        ) : (
          <button
            type="button"
            disabled={!sessionReady}
            onClick={() => dispatch({ type: "push", screen: { name: "profile" } })}
          >
            Progress
          </button>
        )}
      </header>
      {state.tag === "fatal" ? (
        <section>
          <p role="alert">{state.message}</p>
          <button type="button" onClick={() => window.location.reload()}>Retry startup</button>
        </section>
      ) : null}
      {screen.name === "profile" ? (
        <section aria-labelledby="profile-heading">
          <h1 id="profile-heading">Progress</h1>
          <p>{me?.kind === "telegram" ? `Connected as ${me.profile.displayName}` : "Playing as a guest"}</p>
          <SaveProgressButton />
          {sessionReady ? <StatsPanel refreshKey={me?.kind ?? "none"} title="Statistics" /> : null}
        </section>
      ) : (
        <DailyCaseGate enabled={sessionReady} caseDate={entry.caseDate}>
          {(daily) => <CaseGame daily={daily} key={daily.id} />}
        </DailyCaseGate>
      )}
    </main>
  );
}

export function App() {
  return <SessionProvider><AppContent /></SessionProvider>;
}
```

`apps/client/src/App.test.tsx`:

```tsx
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { RuntimeProvider } from "./app/runtime";
import { runtimeFixture } from "./test/runtime-fixture";

it("mounts the shell, creates a guest, then loads daily without identity proof", async () => {
  const runtime = runtimeFixture({ storedToken: null, platformKind: "telegram" });
  const order: string[] = [];
  runtime.api.createGuest = vi.fn(async () => {
    order.push("guest");
    return { token: "g".repeat(43), expiresAt: "2026-11-01T00:00:00.000Z", kind: "guest" as const };
  });
  runtime.api.getDaily = vi.fn(async () => {
    order.push("daily");
    return {
      id: "case-2026-08-03",
      date: "2026-08-03",
      title: "The missing pawn",
      puzzles: [{
        id: "opening-exd5",
        version: 1,
        title: "A pawn vanished",
        prompt: "What happened one move ago?",
        postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
        retractingColor: "w" as const,
        maxHints: 2,
        provenance: "A MOVE AGO sample",
        license: "CC BY 4.0",
      }],
      solvedPuzzleIds: [],
    };
  });
  render(<RuntimeProvider runtime={runtime}><App /></RuntimeProvider>);

  await waitFor(() => expect(runtime.api.getDaily).toHaveBeenCalledOnce());
  expect(order).toEqual(["guest", "daily"]);
  expect(runtime.platform.ready).toHaveBeenCalledOnce();
  expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
  expect(runtime.api.loginMiniApp).not.toHaveBeenCalled();
});

it("exchanges a future platform auth-return event through the same session provider", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const listeners: Array<(url: string) => void> = [];
  runtime.platform.authReturn.subscribe = vi.fn(async (listener: (url: string) => void) => {
    listeners.push(listener);
    return () => undefined;
  });
  runtime.api.exchangeHandoff = vi.fn().mockResolvedValue({
    token: "t".repeat(43),
    expiresAt: "2026-11-01T00:00:00.000Z",
    kind: "telegram" as const,
    profile: { telegramUserId: "42", displayName: "Ada", username: null, avatarUrl: null },
  });
  render(<RuntimeProvider runtime={runtime}><App /></RuntimeProvider>);
  await waitFor(() => expect(listeners).toHaveLength(1));
  act(() => listeners[0]?.("amoveago-debug://auth?handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"));
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(
    "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    expect.any(AbortSignal),
  ));
  expect(runtime.token.get()).toBe("t".repeat(43));
  act(() => listeners[0]?.("amoveago-debug://auth?handoff=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"));
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
});
```

- [ ] **Step 7: Run GREEN**

Run: `npm test -w @a-move-ago/client -- src/features/game/ui/RevealPlayer.test.tsx src/features/daily/case-progress.test.ts src/App.test.tsx`

Expected: PASS, 4 tests; reveal ordering, multiple-act ordering, guest-before-daily, no implicit Telegram identity and future platform auth-return exchange are locked.

Run: `npm test -w @a-move-ago/client`

Expected: every client unit/component test PASS.

Run: `npm run typecheck -w @a-move-ago/client`

Expected: exit `0`.

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/App.tsx apps/client/src/App.test.tsx apps/client/src/features apps/client/src/styles
git commit -m "feat: complete the daily guest game loop"
```

### Task 12: Проверить Pages, Telegram host и production artifacts через Playwright

**Files:**
- Create: `apps/client/playwright.config.ts`
- Create: `apps/client/e2e/api-mock.ts`
- Create: `apps/client/e2e/guest-game.spec.ts`
- Create: `apps/client/e2e/telegram-host.spec.ts`
- Create: `apps/client/test/verify-builds.mjs`
- Modify: `apps/client/package.json`
- Modify: `apps/client/tsconfig.json`
- Modify: `apps/client/vitest.config.ts`
- Modify: `package-lock.json` through `npm install`

- [ ] **Step 1: Add Playwright without coupling it to a local Worker database**

Add to `apps/client/package.json` scripts:

```json
"e2e": "playwright test",
"verify:artifacts": "node test/verify-builds.mjs"
```

Add to `apps/client/package.json` dev dependencies:

```json
"@playwright/test": "1.62.1"
```

Add `"node"` to `compilerOptions.types` and add `"e2e"` plus `"playwright.config.ts"` to `include` in `apps/client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["node", "vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": [
    "build",
    "e2e",
    "src",
    "test",
    "playwright.config.ts",
    "vite.config.ts",
    "vitest.config.ts"
  ]
}
```

Add an explicit unit/component include list inside `test` in `apps/client/vitest.config.ts`, after
`environment`. This prevents Vitest's default `*.spec.ts` glob from collecting the Playwright files:

```ts
include: [
  "build/**/*.test.ts",
  "src/**/*.test.ts",
  "src/**/*.test.tsx",
  "test/**/*.test.ts",
],
```

`apps/client/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173/a-move-ago/",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview:pages -- --port 4173",
    url: "http://127.0.0.1:4173/a-move-ago/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
```

Run: `npm install`

Expected: exit `0`; Playwright is locked at `1.62.1`.

Run: `npx playwright install chromium`

Expected: exit `0`; Chromium is available locally. CI installation belongs to plan 5’s workflow task.

- [ ] **Step 2: Implement a contract-shaped browser mock, including response loss**

`apps/client/e2e/api-mock.ts`:

```ts
import type { Page, Route } from "@playwright/test";

const profile = {
  telegramUserId: "42",
  displayName: "Ada",
  username: "ada",
  avatarUrl: null,
};

export interface ApiObservations {
  attemptBodies: Array<Record<string, unknown>>;
  guestChannels: string[];
  hintRequests: Array<{ attemptId: string; level: number }>;
  miniAppProofs: string[];
  statsRequests: number;
}

async function json(route: Route, status: number, value: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  });
}

export async function installApiMock(page: Page, options: {
  loseFirstAttempt?: boolean;
  loseFirstHint?: boolean;
} = {}): Promise<ApiObservations> {
  const observed: ApiObservations = {
    attemptBodies: [],
    guestChannels: [],
    hintRequests: [],
    miniAppProofs: [],
    statsRequests: 0,
  };
  let attemptLost = false;
  let hintLost = false;
  let identity: "guest" | "telegram" = "guest";

  await page.route("https://telegram.org/js/telegram-web-app.js?63", async (route) => {
    await route.fulfill({ contentType: "application/javascript", body: "window.Telegram={WebApp:{platform:'unknown'}};" });
  });
  await page.route("https://api.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,OPTIONS",
        },
      });
      return;
    }
    if (url.pathname === "/v1/sessions/guest" && request.method() === "POST") {
      const body = request.postDataJSON() as { channel: string };
      observed.guestChannels.push(body.channel);
      await json(route, 201, {
        token: "g".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "guest",
      });
      return;
    }
    if (url.pathname === "/v1/me" && request.method() === "GET") {
      await json(route, 200, identity === "guest"
        ? { kind: "guest", profile: null }
        : { kind: "telegram", profile });
      return;
    }
    if (url.pathname === "/v1/daily" && request.method() === "GET") {
      await json(route, 200, {
        id: "case-2026-08-03",
        date: "2026-08-03",
        title: "The missing pawn",
        puzzles: [{
          id: "opening-exd5",
          version: 1,
          title: "A pawn vanished",
          prompt: "What happened one move ago?",
          postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
          retractingColor: "w",
          maxHints: 2,
          provenance: "A MOVE AGO sample",
          license: "CC BY 4.0",
        }],
        solvedPuzzleIds: [],
      });
      return;
    }
    if (url.pathname === "/v1/attempts" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      observed.attemptBodies.push(body);
      if (options.loseFirstAttempt && !attemptLost) {
        attemptLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      const move = body.retraction as { currentSquare: string; previousSquare: string; restoredPiece: unknown };
      const correct = move.currentSquare === "d5" && move.previousSquare === "e4" && move.restoredPiece !== null;
      await json(route, 201, correct
        ? {
            id: "11111111-1111-4111-8111-111111111111",
            attemptUuid: body.attemptUuid,
            correct: true,
            reveal: {
              retraction: body.retraction,
              previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
              forwardSan: "exd5",
              explanation: "The white e-pawn captured the black pawn on d5.",
              historyConstraints: [
                { kind: "previous-castling", value: "KQkq" },
                { kind: "previous-en-passant", value: "d6" },
              ],
            },
          }
        : {
            id: "33333333-3333-4333-8333-333333333333",
            attemptUuid: body.attemptUuid,
            correct: false,
            contradiction: { code: "NOT_THE_LAST_MOVE", message: "That does not explain the missing pawn." },
          });
      return;
    }
    const hint = url.pathname.match(/^\/v1\/attempts\/([^/]+)\/hints$/);
    if (hint && request.method() === "POST") {
      const body = request.postDataJSON() as { level: number };
      observed.hintRequests.push({ attemptId: decodeURIComponent(hint[1] ?? ""), level: body.level });
      if (options.loseFirstHint && !hintLost) {
        hintLost = true;
        await route.abort("internetdisconnected");
        return;
      }
      await json(route, 200, { level: body.level, text: "A pawn changed files.", exhausted: false });
      return;
    }
    if (url.pathname === "/v1/me/stats" && request.method() === "GET") {
      observed.statsRequests += 1;
      await json(route, 200, {
        attempts: 2,
        hintsUsed: 1,
        solvedPuzzles: 7,
        completedCases: 5,
        currentStreak: 4,
        bestStreak: 9,
        lastCompletedDate: "2026-08-03",
      });
      return;
    }
    if (url.pathname === "/v1/auth/telegram/mini-app" && request.method() === "POST") {
      const body = request.postDataJSON() as { initData: string };
      observed.miniAppProofs.push(body.initData);
      identity = "telegram";
      await json(route, 200, {
        token: "t".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "telegram",
        profile,
      });
      return;
    }
    await json(route, 404, {
      error: { code: "NOT_FOUND", message: "Mock route not found.", requestId: "e2e-request" },
    });
  });
  return observed;
}
```

- [ ] **Step 3: Write the failing guest journey tests**

`apps/client/e2e/guest-game.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

async function chooseCorrectRetraction(page: import("@playwright/test").Page) {
  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "e4, empty" }).click();
  await page.getByLabel("Captured piece").selectOption("p");
  await page.getByRole("button", { name: "Submit retraction" }).click();
}

test("guest survives a lost success response and retries the exact UUID", async ({ page }) => {
  const observed = await installApiMock(page, { loseFirstAttempt: true });
  const dailyPayloads: unknown[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/v1/daily") {
      void response.json().then((body) => dailyPayloads.push(body));
    }
  });
  await page.goto("./?case=2026-08-03");
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  await expect.poll(() => dailyPayloads.length).toBe(1);
  expect(JSON.stringify(dailyPayloads[0])).not.toContain("acceptedSolutions");
  expect(JSON.stringify(dailyPayloads[0])).not.toContain("previousFen");
  expect(observed.guestChannels).toEqual(["web"]);

  await chooseCorrectRetraction(page);
  await expect(page.getByRole("button", { name: "Retry attempt" })).toBeVisible();
  await page.getByRole("button", { name: "Retry attempt" }).click();
  expect(observed.attemptBodies).toHaveLength(2);
  expect(observed.attemptBodies[1]?.attemptUuid).toBe(observed.attemptBodies[0]?.attemptUuid);
  expect(observed.attemptBodies[1]).toEqual(observed.attemptBodies[0]);
  await expect(page.getByRole("heading", { name: "Solved" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Case complete" })).toBeVisible();
  await expect(page.getByText("Current streak")).toBeVisible();
});

test("incorrect attempt retries the same hint level, then solves", async ({ page }) => {
  const observed = await installApiMock(page, { loseFirstHint: true });
  await page.goto("./?case=2026-08-03");
  await page.getByRole("gridcell", { name: "d5, white pawn" }).click();
  await page.getByRole("gridcell", { name: "c4, empty" }).click();
  await page.getByRole("button", { name: "Submit retraction" }).click();
  await expect(page.getByText("That does not explain the missing pawn.")).toBeVisible();
  await page.getByRole("button", { name: "Get hint" }).click();
  await expect(page.getByRole("button", { name: "Retry hint" })).toBeVisible();
  await page.getByRole("button", { name: "Retry hint" }).click();
  expect(observed.hintRequests).toEqual([
    { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
    { attemptId: "33333333-3333-4333-8333-333333333333", level: 1 },
  ]);
  await expect(page.getByText("A pawn changed files.")).toBeVisible();

  await page.getByRole("button", { name: "Reset" }).click();
  await chooseCorrectRetraction(page);
  await expect(page.getByRole("heading", { name: "Case complete" })).toBeVisible();
});
```

- [ ] **Step 4: Write the Telegram host/privacy test**

`apps/client/e2e/telegram-host.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { installApiMock } from "./api-mock";

test("Telegram ready/layout/back work while identity waits for explicit consent", async ({ page }) => {
  const observed = await installApiMock(page);
  await page.route("https://telegram.org/js/telegram-web-app.js?63", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        window.__tgReady = 0;
        window.__tgBack = null;
        window.Telegram = { WebApp: {
          platform: "android",
          initData: "query_id=raw%2Bproof&hash=unchanged",
          viewportStableHeight: 640,
          safeAreaInset: { top: 24, right: 0, bottom: 16, left: 0 },
          contentSafeAreaInset: { top: 48, right: 0, bottom: 20, left: 0 },
          ready() { window.__tgReady += 1; },
          openLink() {},
          BackButton: {
            show() {}, hide() {},
            onClick(handler) { window.__tgBack = handler; },
            offClick(handler) { if (window.__tgBack === handler) window.__tgBack = null; }
          },
          HapticFeedback: { selectionChanged() {}, notificationOccurred() {} },
          onEvent() {}, offEvent() {}
        }};
      `,
    });
  });
  await page.goto("./?case=2026-08-03#tgWebAppData=kept");
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  expect(observed.guestChannels).toEqual(["telegram"]);
  expect(observed.miniAppProofs).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __tgReady: number }).__tgReady)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--host-content-safe-top")))
    .toBe("48px");
  expect(await page.locator("main.app-shell").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { minHeight: style.minHeight, paddingTop: style.paddingTop };
  })).toEqual({ minHeight: "640px", paddingTop: "48px" });

  await page.getByRole("button", { name: "Progress" }).click();
  await expect.poll(() => observed.statsRequests).toBe(1);
  await page.getByRole("button", { name: "Save progress with Telegram" }).click();
  await expect.poll(() => observed.miniAppProofs.length).toBe(1);
  await expect.poll(() => observed.statsRequests).toBe(2);
  expect(observed.miniAppProofs[0]).toBe("query_id=raw%2Bproof&hash=unchanged");
  await page.evaluate(() => (window as unknown as { __tgBack: null | (() => void) }).__tgBack?.());
  await expect(page.getByRole("heading", { name: "The missing pawn" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#tgWebAppData=kept");
});
```

`apps/client/test/verify-builds.mjs`:

```js
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const pages = await readFile(new URL("../dist/pages/index.html", import.meta.url), "utf8");
const android = await readFile(new URL("../dist/android/index.html", import.meta.url), "utf8");
const csp = pages.indexOf("Content-Security-Policy");
const telegram = pages.indexOf("telegram-web-app.js?63");
const application = pages.indexOf('type="module"');
assert(csp >= 0 && telegram > csp && application > telegram, "Pages CSP and Telegram script must precede the app module");
assert.match(pages, /connect-src[^;]*https:\/\/api\.test/);
assert.match(pages, /\/a-move-ago\/assets\//);
assert.doesNotMatch(pages, /unsafe-eval|script-src[^;]*\*|connect-src[^;]*\*/);
assert.match(android, /Content-Security-Policy/);
assert.match(android, /["']\/assets\//);
assert.doesNotMatch(android, /telegram-web-app\.js|\/a-move-ago\/assets\/|@capacitor/);

const assetDirectories = [
  new URL("../dist/pages/assets/", import.meta.url),
  new URL("../dist/android/assets/", import.meta.url),
];
const entries = await Promise.all(assetDirectories.map((directory) => readdir(directory)));
assert.equal(entries.flat().some((name) => name.endsWith(".map")), false, "Deployable source maps are disabled");
const scripts = assetDirectories.flatMap((directory, index) =>
  (entries[index] ?? []).filter((name) => name.endsWith(".js")).map((name) => new URL(name, directory)),
);
const bundle = (await Promise.all(scripts.map((url) => readFile(url, "utf8")))).join("\n");
assert.doesNotMatch(
  bundle,
  /rnbqkbnr\/ppp1pppp\/8\/3p4\/4P3\/8\/PPPP1PPP/,
  "The known previous-position answer must not enter either production frontend bundle",
);
console.log("Pages and Android web artifacts verified.");
```

- [ ] **Step 5: Build Pages, run E2E and inspect security-sensitive HTML**

Run: `VITE_API_BASE_URL=https://api.test npm run build:pages -w @a-move-ago/client`

Expected: exit `0` and creates `apps/client/dist/pages`.

Run: `npm run e2e -w @a-move-ago/client`

Expected: PASS, 3 Chromium tests: lost attempt response, retry-safe hint, complete reveal/stats and Telegram privacy/host behavior.

Run: `rg -n "Content-Security-Policy|telegram-web-app.js\?63|/a-move-ago/assets/" apps/client/dist/pages/index.html`

Expected: all three patterns are present; CSP precedes executable application markup and the application asset uses the repository base.

Run: `rg -n "unsafe-eval|script-src[^;]*\*|connect-src[^;]*\*" apps/client/dist/pages/index.html`

Expected: exit `1` with no matches.

- [ ] **Step 6: Build and inspect the separate Android web artifact**

Run: `VITE_API_BASE_URL=https://api.test npm run build:android:web -w @a-move-ago/client`

Expected: exit `0` and creates `apps/client/dist/android/index.html` without changing `dist/pages`.

Run: `rg -n "Content-Security-Policy|/assets/" apps/client/dist/android/index.html`

Expected: both patterns are present and assets use root base.

Run: `rg -n "telegram-web-app.js|/a-move-ago/assets/|@capacitor" apps/client/dist/android/index.html apps/client/dist/android/assets`

Expected: exit `1`; this artifact has no Telegram bootstrap and this plan has not added a Capacitor/Android adapter. Plan 5 owns the dynamic loader implementation, native project, Preferences, Browser and App Links.

Run: `npm run verify:artifacts -w @a-move-ago/client`

Expected: exit `0`; the executable build check proves CSP/script/module order, exact base paths, no wildcard/`unsafe-eval`, no Telegram/Capacitor code in Android, no deployable source maps in either artifact, and no known sample answer in either artifact's JavaScript.

- [ ] **Step 7: Run the whole repository verification matrix**

Run: `npm run format`

Expected: Biome mechanically formats every plan-created source and test file.

Run: `npm run check`

Expected: Biome reports no formatting, lint or import-order errors after the mechanical format pass.

Run: `npm test`

Expected: every foundation, API, auth, platform and client unit/component test PASS.

Run: `npm run typecheck`

Expected: every workspace typecheck exits `0` under strict and `exactOptionalPropertyTypes`.

Run: `VITE_API_BASE_URL=https://api.test npm run build`

Expected: all workspace build scripts exit `0`; client default build remains Pages.

Run: `git status --short`

Expected: only the files named by plans 1–4 plus generated lockfile changes are present; no `apps/client/android`, Capacitor package, private/production puzzle solution, real token, real handoff code, or build secret is tracked. The CC BY sample answer may exist in tests but the artifact verifier proves it is absent from production JavaScript.

- [ ] **Step 8: Commit**

```bash
git add apps/client/e2e apps/client/test/verify-builds.mjs apps/client/playwright.config.ts apps/client/package.json apps/client/tsconfig.json apps/client/vitest.config.ts package-lock.json
git commit -m "test: cover Pages and Telegram client journeys"
```

## Граница передачи плану 5

На выходе этого плана существуют два проверенных, но разных artifact: `apps/client/dist/pages` с `/a-move-ago/` base, CSP и Telegram script; `apps/client/dist/android` с `/` base, CSP и без Telegram script. `createPlatformAdapter()` и `createBrowserRuntime()` уже асинхронны и принимают `loadAndroid`, но реализация loader отсутствует намеренно. План 5 обязан добавить её через dynamic import только для Android build, после чего реализовать Capacitor storage/browser/app-link adapter и native delivery, не меняя web/Telegram поведение этого плана.
