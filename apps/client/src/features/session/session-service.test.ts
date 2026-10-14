import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { browserPortFromWindow, createPlatformAdapter } from "@a-move-ago/platform";
import { describe, expect, it, vi } from "vitest";
import { runtimeFixture } from "../../test/runtime-fixture";
import {
  bootstrapSession,
  deleteProfile,
  RetryableHandoffError,
  retryHandoff,
  saveProgress,
  TelegramAuthDeniedError,
} from "./session-service";

const handoffCode = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const profile = {
  telegramUserId: "42",
  displayName: "Ada",
  username: null,
  avatarUrl: null,
};

const telegramSession = {
  token: "t".repeat(43),
  expiresAt: "2026-11-01T00:00:00.000Z",
  kind: "telegram" as const,
  profile,
};

describe("session service", () => {
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

  it("creates a channel-specific guest without requesting Telegram identity", async () => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "telegram" });

    await expect(bootstrapSession(runtime, new URL("https://app.test/"), vi.fn())).resolves.toEqual(
      { kind: "guest", profile: null },
    );

    expect(runtime.api.createGuest).toHaveBeenCalledWith("telegram", expect.any(AbortSignal));
    expect(runtime.platform.requestTelegramProof).not.toHaveBeenCalled();
    expect(runtime.api.loginMiniApp).not.toHaveBeenCalled();
    expect(runtime.token.get()).toBe("g".repeat(43));
  });

  it("boots a usable guest when browser storage access is denied", async () => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
    const browserWindow = {
      get localStorage(): Storage {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    } as Window;
    runtime.platform = await createPlatformAdapter({
      browser: browserPortFromWindow(browserWindow),
    });

    await expect(bootstrapSession(runtime, new URL("https://app.test/"), vi.fn())).resolves.toEqual(
      { kind: "guest", profile: null },
    );
    expect(runtime.api.createGuest).toHaveBeenCalledWith("web", expect.any(AbortSignal));
    expect(runtime.token.get()).toBe("g".repeat(43));
    expect(await runtime.platform.tokenStore.read()).toBe("g".repeat(43));
  });

  it("strips auth query synchronously before the first await and preserves the fragment", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const replace = vi.fn();
    let stripped = false;
    replace.mockImplementation(() => {
      stripped = true;
    });
    runtime.platform.tokenStore.read = vi.fn(async () => {
      expect(stripped).toBe(true);
      return "guest-token";
    });

    const pending = bootstrapSession(
      runtime,
      new URL(
        `https://app.test/a-move-ago/?case=2026-08-03&handoff=${handoffCode}` +
          "#tgWebAppData=raw%2Bfragment",
      ),
      replace,
    );

    expect(replace).toHaveBeenCalledWith(
      "/a-move-ago/?case=2026-08-03#tgWebAppData=raw%2Bfragment",
    );
    await expect(pending).resolves.toEqual({ kind: "telegram", profile });
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(handoffCode, expect.any(AbortSignal));
  });

  it("restores a valid stored session without rotating or clearing it", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });

    await expect(bootstrapSession(runtime, new URL("https://app.test/"), vi.fn())).resolves.toEqual(
      { kind: "guest", profile: null },
    );

    expect(runtime.api.getMe).toHaveBeenCalledOnce();
    expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
    expect(runtime.api.createGuest).not.toHaveBeenCalled();
  });

  it("retries a transient getMe failure before restoring the stored session", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const controller = new AbortController();
    runtime.api.getMe = vi
      .fn()
      .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
      .mockResolvedValueOnce({ kind: "guest" as const, profile: null });

    await expect(
      bootstrapSession(runtime, new URL("https://app.test/"), vi.fn(), controller.signal),
    ).resolves.toEqual({ kind: "guest", profile: null });

    expect(runtime.api.getMe).toHaveBeenCalledTimes(2);
    expect(runtime.sleep).toHaveBeenCalledOnce();
    expect(runtime.sleep).toHaveBeenCalledWith(expect.any(Number), controller.signal);
    expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
    expect(runtime.api.createGuest).not.toHaveBeenCalled();
  });

  it("does not exchange a stale handoff after restoring a Telegram session", async () => {
    const runtime = runtimeFixture({ storedToken: "telegram-token", platformKind: "web" });
    runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
    const replace = vi.fn();

    await expect(
      bootstrapSession(
        runtime,
        new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
        replace,
      ),
    ).resolves.toEqual({ kind: "telegram", profile });

    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
    expect(runtime.token.get()).toBe("telegram-token");
  });

  it("does not downgrade a restored Telegram session for a stale denial", async () => {
    const runtime = runtimeFixture({ storedToken: "telegram-token", platformKind: "web" });
    runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));

    await expect(
      bootstrapSession(
        runtime,
        new URL("https://app.test/a-move-ago/?authError=access_denied"),
        vi.fn(),
      ),
    ).resolves.toEqual({ kind: "telegram", profile });

    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
    expect(runtime.token.get()).toBe("telegram-token");
  });

  it("clears a stored token only when getMe returns 401 and installs a fresh guest", async () => {
    const runtime = runtimeFixture({ storedToken: "expired-token", platformKind: "web" });
    runtime.api.getMe = vi
      .fn()
      .mockRejectedValue(new ApiError(401, "INVALID_SESSION", "Expired.", "req-1", null));

    await expect(bootstrapSession(runtime, new URL("https://app.test/"), vi.fn())).resolves.toEqual(
      { kind: "guest", profile: null },
    );

    expect(runtime.platform.tokenStore.clear).toHaveBeenCalledOnce();
    expect(runtime.api.createGuest).toHaveBeenCalledWith("web", expect.any(AbortSignal));
    expect(runtime.token.get()).toBe("g".repeat(43));
  });

  it("does not clear a stored token for a transient getMe failure", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const failure = new ApiTransportError(new TypeError("offline"));
    runtime.api.getMe = vi.fn().mockRejectedValue(failure);

    await expect(bootstrapSession(runtime, new URL("https://app.test/"), vi.fn())).rejects.toBe(
      failure,
    );
    expect(runtime.api.getMe).toHaveBeenCalledTimes(3);
    expect(runtime.sleep).toHaveBeenCalledTimes(2);
    expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
    expect(runtime.token.get()).toBe("guest-token");
  });

  it("keeps a stripped handoff in memory when token storage cannot be read", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const failure = new ApiTransportError(new TypeError("storage bridge offline"));
    runtime.platform.tokenStore.read = vi.fn().mockRejectedValue(failure);
    const replace = vi.fn();

    const error = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      replace,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableHandoffError);
    expect((error as RetryableHandoffError).pending).toEqual({ handoffCode });
    expect((error as RetryableHandoffError).cause).toBe(failure);
    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
  });

  it("re-reads the original guest before retrying a cold-start handoff", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.token.set(null);
    const failure = new ApiTransportError(new TypeError("storage bridge offline"));
    runtime.platform.tokenStore.read = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce("guest-token");
    runtime.api.exchangeHandoff = vi.fn(async () => {
      if (!runtime.token.get()) {
        throw new ApiError(401, "MISSING_SESSION", "Missing.", "client", null);
      }
      return telegramSession;
    });

    const first = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      vi.fn(),
    ).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(RetryableHandoffError);

    await expect(retryHandoff(runtime, (first as RetryableHandoffError).pending)).resolves.toEqual({
      kind: "telegram",
      profile,
    });
    expect(runtime.platform.tokenStore.read).toHaveBeenCalledTimes(2);
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
  });

  it("keeps the handoff retryable while session recovery remains transient", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.token.set(null);
    const failure = new ApiTransportError(new TypeError("storage bridge offline"));
    runtime.platform.tokenStore.read = vi.fn().mockRejectedValue(failure);

    const first = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      vi.fn(),
    ).catch((caught: unknown) => caught);
    const second = await retryHandoff(runtime, (first as RetryableHandoffError).pending).catch(
      (caught: unknown) => caught,
    );

    expect(second).toBeInstanceOf(RetryableHandoffError);
    expect((second as RetryableHandoffError).pending).toEqual({ handoffCode });
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
  });

  it("keeps a stripped handoff in memory when fresh guest issuance is transiently unavailable", async () => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
    const failure = new ApiTransportError(new TypeError("offline"));
    runtime.api.createGuest = vi.fn().mockRejectedValue(failure);
    const replace = vi.fn();

    const error = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      replace,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableHandoffError);
    expect((error as RetryableHandoffError).pending).toEqual({ handoffCode });
    expect((error as RetryableHandoffError).cause).toBe(failure);
    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
  });

  it("recovers a usable guest before surfacing a permanent handoff rejection", async () => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
    runtime.token.set(null);
    const transient = new ApiTransportError(new TypeError("offline"));
    runtime.api.createGuest = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({
        token: "g".repeat(43),
        expiresAt: "2026-11-01T00:00:00.000Z",
        kind: "guest" as const,
      });
    const permanent = new ApiError(401, "HANDOFF_INVALID", "Invalid.", "req-5", null);
    runtime.api.exchangeHandoff = vi.fn().mockRejectedValue(permanent);

    const first = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      vi.fn(),
    ).catch((caught: unknown) => caught);
    expect(first).toBeInstanceOf(RetryableHandoffError);

    await expect(retryHandoff(runtime, (first as RetryableHandoffError).pending)).rejects.toBe(
      permanent,
    );
    expect(runtime.api.createGuest).toHaveBeenCalledTimes(2);
    expect(runtime.token.get()).toBe("g".repeat(43));
    expect(await runtime.platform.tokenStore.read()).toBe("g".repeat(43));
  });

  it.each([
    new DOMException("Aborted", "AbortError"),
    new ApiError(400, "BAD_REQUEST", "Invalid.", "req-0", null),
  ])("does not wrap a non-retryable pre-exchange failure", async (failure) => {
    const runtime = runtimeFixture({ storedToken: null, platformKind: "web" });
    runtime.api.createGuest = vi.fn().mockRejectedValue(failure);

    await expect(
      bootstrapSession(
        runtime,
        new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
        vi.fn(),
      ),
    ).rejects.toBe(failure);
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
  });

  it("keeps a transient stripped handoff only in memory and retries the same code", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.api.exchangeHandoff = vi
      .fn()
      .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
      .mockResolvedValueOnce(telegramSession);
    const replace = vi.fn();

    const error = await bootstrapSession(
      runtime,
      new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
      replace,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RetryableHandoffError);
    expect((error as RetryableHandoffError).pending).toEqual({ handoffCode });
    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(await runtime.platform.tokenStore.read()).toBe("guest-token");
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalledWith(handoffCode);

    await expect(retryHandoff(runtime, (error as RetryableHandoffError).pending)).resolves.toEqual({
      kind: "telegram",
      profile,
    });
    expect(runtime.api.exchangeHandoff).toHaveBeenNthCalledWith(
      1,
      handoffCode,
      expect.any(AbortSignal),
    );
    expect(runtime.api.exchangeHandoff).toHaveBeenNthCalledWith(
      2,
      handoffCode,
      expect.any(AbortSignal),
    );
  });

  it("does not persist or restore a permanently rejected handoff", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const failure = new ApiError(401, "HANDOFF_INVALID", "Invalid.", "req-2", null);
    runtime.api.exchangeHandoff = vi.fn().mockRejectedValue(failure);
    const replace = vi.fn();

    await expect(
      bootstrapSession(
        runtime,
        new URL(`https://app.test/a-move-ago/?handoff=${handoffCode}`),
        replace,
      ),
    ).rejects.toBe(failure);

    expect(replace).toHaveBeenCalledWith("/a-move-ago/");
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
    expect(await runtime.platform.tokenStore.read()).toBe("guest-token");
    expect(runtime.token.get()).toBe("guest-token");
  });

  it("recovers a fresh usable guest after retry gets INVALID_SESSION before rethrowing", async () => {
    const runtime = runtimeFixture({ storedToken: "revoked-token", platformKind: "web" });
    const failure = new ApiError(401, "INVALID_SESSION", "Expired.", "req-3", null);
    runtime.api.exchangeHandoff = vi.fn().mockRejectedValue(failure);

    await expect(retryHandoff(runtime, { handoffCode })).rejects.toBe(failure);

    expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
    expect(runtime.api.createGuest).toHaveBeenCalledWith("web", expect.any(AbortSignal));
    expect(runtime.token.get()).toBe("g".repeat(43));
    expect(await runtime.platform.tokenStore.read()).toBe("g".repeat(43));
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalledWith(handoffCode);
  });

  it("strips a fixed OIDC denial and keeps the same guest playable", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    const replace = vi.fn();

    const error = await bootstrapSession(
      runtime,
      new URL("https://app.test/a-move-ago/?case=2026-08-03&authError=access_denied"),
      replace,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TelegramAuthDeniedError);
    expect((error as TelegramAuthDeniedError).me).toEqual({ kind: "guest", profile: null });
    expect(replace).toHaveBeenCalledWith("/a-move-ago/?case=2026-08-03");
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
    expect(runtime.token.get()).toBe("guest-token");
  });

  it("passes raw Mini App initData only after explicit save progress", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "telegram" });
    runtime.platform.requestTelegramProof = vi.fn().mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "user=raw%2Bvalue&hash=unchanged",
    });

    await expect(saveProgress(runtime)).resolves.toEqual({ kind: "telegram", profile });

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
    runtime.api.loginMiniApp = vi
      .fn()
      .mockRejectedValue(new ApiError(401, "TELEGRAM_PROOF_INVALID", "Expired.", "req-4", null));

    await expect(saveProgress(runtime)).rejects.toMatchObject({ code: "TELEGRAM_PROOF_INVALID" });
    expect(runtime.token.get()).toBe("guest-token");
    expect(await runtime.platform.tokenStore.read()).toBe("guest-token");
  });

  it.each([
    ["web", "web"],
    ["android", "android"],
  ] as const)("starts exact Telegram OIDC for the %s channel", async (platformKind, channel) => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind });
    runtime.api.startOidc = vi.fn().mockResolvedValue({
      authorizationUrl: "https://oauth.telegram.org:443/auth?response_type=code&state=server-state",
      expiresAt: "2026-08-03T12:10:00.000Z",
    });

    await expect(saveProgress(runtime)).resolves.toBeNull();
    expect(runtime.api.startOidc).toHaveBeenCalledWith(channel, expect.any(AbortSignal));
    expect(runtime.platform.openAuthorization).toHaveBeenCalledWith(
      "https://oauth.telegram.org/auth?response_type=code&state=server-state",
    );
  });

  it.each([
    "http://oauth.telegram.org/auth?state=x",
    "https://user:password@oauth.telegram.org/auth?state=x",
    "https://oauth.telegram.org:444/auth?state=x",
    "https://oauth.telegram.org.evil.test/auth?state=x",
    "https://telegram.org/auth?state=x",
    "https://oauth.telegram.org./auth?state=x",
    "https://oauth.telegram.org/not-auth?state=x",
    "https://oauth.telegram.org/auth?state=x#fragment",
  ])("rejects unexpected OIDC authorization URL %s", async (authorizationUrl) => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    runtime.api.startOidc = vi.fn().mockResolvedValue({
      authorizationUrl,
      expiresAt: "2026-08-03T12:10:00.000Z",
    });

    await expect(saveProgress(runtime)).rejects.toThrow(
      "API returned an unexpected Telegram authorization URL.",
    );
    expect(runtime.platform.openAuthorization).not.toHaveBeenCalled();
  });

  it("commits an authoritative rotated token when abort races after the response", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "telegram" });
    const controller = new AbortController();
    runtime.platform.requestTelegramProof = vi.fn().mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "raw-proof",
    });
    runtime.api.loginMiniApp = vi.fn(async () => {
      controller.abort();
      return telegramSession;
    });

    await expect(saveProgress(runtime, controller.signal)).resolves.toEqual({
      kind: "telegram",
      profile,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(runtime.token.get()).toBe("t".repeat(43));
    expect(runtime.platform.tokenStore.write).toHaveBeenCalledWith("t".repeat(43));
  });

  it("keeps a rotated token usable in memory when persistence write fails", async () => {
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "telegram" });
    runtime.platform.requestTelegramProof = vi.fn().mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "raw-proof",
    });
    runtime.platform.tokenStore.write = vi.fn().mockRejectedValue(new DOMException("Denied"));

    await expect(saveProgress(runtime)).resolves.toEqual({ kind: "telegram", profile });
    expect(runtime.token.get()).toBe("t".repeat(43));
    expect(await runtime.platform.tokenStore.read()).toBe("guest-token");
  });
});
