import type { ApiClient } from "@a-move-ago/api-contract";
import type { PlatformAdapter } from "@a-move-ago/platform";
import { vi } from "vitest";
import { type AppRuntime, createTokenHolder } from "../app/runtime";

const profile = {
  telegramUserId: "42",
  displayName: "Ada",
  username: null,
  avatarUrl: null,
} as const;

export function runtimeFixture(options: {
  storedToken: string | null;
  platformKind: "web" | "telegram" | "android";
}): AppRuntime {
  let stored = options.storedToken;
  const token = createTokenHolder();
  token.set(stored);

  const api = {
    createGuest: vi.fn(async () => ({
      token: "g".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "guest" as const,
    })),
    getMe: vi.fn(async () => ({ kind: "guest" as const, profile: null })),
    deleteProfile: vi.fn(async () => ({
      kind: "guest" as const,
      profile: null,
    })),
    getDaily: vi.fn(async () => ({
      id: "case-2026-08-03",
      date: "2026-08-03",
      title: "The missing pawn",
      puzzles: [
        {
          id: "opening-exd5",
          version: 1,
          title: "The missing pawn",
          prompt: "What happened one move ago?",
          postFen: "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
          retractingColor: "w" as const,
          maxHints: 2,
          provenance: "Original A MOVE AGO sample",
          license: "CC-BY-4.0",
        },
      ],
      solvedPuzzleIds: [],
    })),
    getArchive: vi.fn(async () => ({
      today: "2026-10-15",
      startsOn: null,
      cases: [],
    })),
    submitAttempt: vi.fn(),
    requestHint: vi.fn(),
    getStats: vi.fn(),
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

  const authMode =
    options.platformKind === "telegram"
      ? "mini-app"
      : options.platformKind === "android"
        ? "oidc-android"
        : "oidc-web";
  const platform = {
    kind: options.platformKind,
    channel: options.platformKind,
    authMode,
    tokenStore: {
      read: vi.fn(async () => stored),
      write: vi.fn(async (value: string) => {
        stored = value;
      }),
      clear: vi.fn(async () => {
        stored = null;
      }),
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
  } satisfies PlatformAdapter;

  return {
    api,
    platform,
    token,
    now: () => 1_785_690_000_000,
    attemptUuid: () => "22222222-2222-4222-8222-222222222222",
    sleep: vi.fn(async () => undefined),
  };
}
