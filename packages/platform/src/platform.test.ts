import { describe, expect, it, vi } from "vitest";
import { browserPortFromWindow, createPlatformAdapter } from "./factory";
import type { TelegramWebAppLike } from "./telegram/telegram-types";
import type { PlatformAdapter } from "./types";
import { SESSION_TOKEN_KEY } from "./web/token-store";

function browserPort(input: { href?: string; height?: number } = {}) {
  const values = new Map<string, string>();
  const resizeListeners = new Set<() => void>();
  let height = input.height ?? 700;
  return {
    href: () => input.href ?? "https://agent-axiom.github.io/a-move-ago/#tgWebAppData=kept",
    height: () => height,
    addResizeListener: vi.fn((listener: () => void) => resizeListeners.add(listener)),
    removeResizeListener: vi.fn((listener: () => void) => resizeListeners.delete(listener)),
    open: vi.fn(),
    navigate: vi.fn(),
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    setHeight(value: number) {
      height = value;
    },
    emitResize() {
      for (const listener of resizeListeners) listener();
    },
  };
}

function telegramFake(input: { platform?: string; initData?: string } = {}) {
  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const fake = {
    platform: input.platform ?? "android",
    initData: input.initData ?? "query_id=raw%2Bproof&hash=unchanged",
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
  return fake as typeof fake & TelegramWebAppLike;
}

function layoutRoot() {
  const values = new Map<string, string>();
  return {
    root: {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement,
    values,
  };
}

describe("platform adapters", () => {
  it("uses web storage and browser navigation outside Telegram", async () => {
    const browser = browserPort();
    const adapter = await createPlatformAdapter({ browser });

    expect(adapter).toMatchObject({ kind: "web", channel: "web", authMode: "oidc-web" });
    await adapter.tokenStore.write("guest-token");
    expect(await adapter.tokenStore.read()).toBe("guest-token");
    expect(browser.storage.getItem(SESSION_TOKEN_KEY)).toBe("guest-token");
    const restoredAdapter = await createPlatformAdapter({ browser });
    expect(await restoredAdapter.tokenStore.read()).toBe("guest-token");
    await adapter.tokenStore.clear();
    expect(await adapter.tokenStore.read()).toBeNull();
    expect(await restoredAdapter.tokenStore.read()).toBeNull();
    await expect(adapter.authReturn.initialUrl()).resolves.toBe(
      "https://agent-axiom.github.io/a-move-ago/#tgWebAppData=kept",
    );
    await expect(
      adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 }),
    ).resolves.toBeNull();

    await adapter.openExternal("https://example.test/help");
    await adapter.openAuthorization("https://oauth.telegram.org/auth?state=server-state");
    expect(browser.open).toHaveBeenCalledWith("https://example.test/help");
    expect(browser.navigate).toHaveBeenCalledWith(
      "https://oauth.telegram.org/auth?state=server-state",
    );
  });

  it("keeps session tokens in memory when the localStorage getter is denied", async () => {
    const browserWindow = {
      get localStorage(): Storage {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    } as Window;
    const browser = browserPortFromWindow(browserWindow);
    const adapter = await createPlatformAdapter({ browser });

    expect(await adapter.tokenStore.read()).toBeNull();
    await adapter.tokenStore.write("guest-token");
    expect(await adapter.tokenStore.read()).toBe("guest-token");
    await adapter.tokenStore.clear();
    expect(await adapter.tokenStore.read()).toBeNull();
  });

  it.each(["web", "telegram"] as const)(
    "keeps %s session tokens in memory when getItem is denied",
    async (kind) => {
      const browser = browserPort();
      browser.storage.getItem = vi.fn(() => {
        throw new DOMException("Storage is blocked", "SecurityError");
      });
      const write = vi.spyOn(browser.storage, "setItem");
      const remove = vi.spyOn(browser.storage, "removeItem");
      const adapter = await createPlatformAdapter({
        browser,
        telegram: kind === "telegram" ? telegramFake() : undefined,
      });

      expect(await adapter.tokenStore.read()).toBeNull();
      await adapter.tokenStore.write("guest-token");
      expect(await adapter.tokenStore.read()).toBe("guest-token");
      await adapter.tokenStore.clear();
      expect(await adapter.tokenStore.read()).toBeNull();
      expect(browser.storage.getItem).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("keeps the last known token when storage access is denied after a successful read", async () => {
    const browser = browserPort();
    browser.storage.setItem(SESSION_TOKEN_KEY, "stored-token");
    const adapter = await createPlatformAdapter({ browser });
    expect(await adapter.tokenStore.read()).toBe("stored-token");
    browser.storage.getItem = vi.fn(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    expect(await adapter.tokenStore.read()).toBe("stored-token");
    await adapter.tokenStore.write("rotated-token");
    expect(await adapter.tokenStore.read()).toBe("rotated-token");
  });

  it.each(["setItem", "removeItem"] as const)(
    "keeps token changes in memory when %s is denied",
    async (operation) => {
      const browser = browserPort();
      const adapter = await createPlatformAdapter({ browser });
      await adapter.tokenStore.write("stored-token");
      vi.spyOn(browser.storage, operation).mockImplementation(() => {
        throw new DOMException("Storage is blocked", "SecurityError");
      });

      if (operation === "setItem") {
        await adapter.tokenStore.write("rotated-token");
        expect(await adapter.tokenStore.read()).toBe("rotated-token");
      } else {
        await adapter.tokenStore.clear();
        expect(await adapter.tokenStore.read()).toBeNull();
      }
    },
  );

  it("propagates unrelated errors from the localStorage getter", () => {
    const failure = new TypeError("Broken storage integration");
    const browserWindow = {
      get localStorage(): Storage {
        throw failure;
      },
    } as Window;

    expect(() => browserPortFromWindow(browserWindow)).toThrow(failure);
  });

  it.each(["getItem", "setItem", "removeItem"] as const)(
    "propagates unrelated storage errors from %s",
    async (operation) => {
      const browser = browserPort();
      const failure = new TypeError("Broken storage integration");
      vi.spyOn(browser.storage, operation).mockImplementation(() => {
        throw failure;
      });
      const adapter = await createPlatformAdapter({ browser });
      const pending =
        operation === "getItem"
          ? adapter.tokenStore.read()
          : operation === "setItem"
            ? adapter.tokenStore.write("guest-token")
            : adapter.tokenStore.clear();

      await expect(pending).rejects.toBe(failure);
    },
  );

  it("treats an unknown Telegram host as web", async () => {
    const telegram = telegramFake({ platform: "unknown" });
    const adapter = await createPlatformAdapter({ browser: browserPort(), telegram });

    expect(adapter.kind).toBe("web");
    await adapter.ready();
    expect(telegram.ready).not.toHaveBeenCalled();
  });

  it("updates and disposes web layout listeners", async () => {
    const browser = browserPort();
    const adapter = await createPlatformAdapter({ browser });
    const { root } = layoutRoot();

    const dispose = adapter.installLayoutVars(root);
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("700px");
    expect(root.style.getPropertyValue("--host-safe-top")).toBe("env(safe-area-inset-top, 0px)");
    expect(root.style.getPropertyValue("--host-content-safe-top")).toBe("0px");

    browser.setHeight(720);
    browser.emitResize();
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("720px");
    const listener = browser.addResizeListener.mock.calls[0]?.[0];
    dispose();
    expect(browser.removeResizeListener).toHaveBeenCalledWith(listener);

    browser.setHeight(800);
    browser.emitResize();
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("720px");
  });

  it("wires Telegram ready, stable layout disposal and raw proof", async () => {
    const telegram = telegramFake();
    const adapter = await createPlatformAdapter({ browser: browserPort(), telegram });
    const { root } = layoutRoot();

    expect(adapter).toMatchObject({
      kind: "telegram",
      channel: "telegram",
      authMode: "mini-app",
    });
    await adapter.ready();
    await adapter.ready();
    expect(telegram.ready).toHaveBeenCalledOnce();

    const dispose = adapter.installLayoutVars(root);
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("640px");
    expect(root.style.getPropertyValue("--host-safe-top")).toBe("24px");
    expect(root.style.getPropertyValue("--host-content-safe-top")).toBe("48px");
    await expect(
      adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 }),
    ).resolves.toEqual({
      kind: "telegram-mini-app",
      initData: "query_id=raw%2Bproof&hash=unchanged",
    });

    telegram.viewportStableHeight = 700;
    telegram.emit("viewportChanged", { isStateStable: false });
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("640px");
    telegram.emit("viewportChanged", { isStateStable: true });
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("700px");

    telegram.safeAreaInset.top = 30;
    telegram.contentSafeAreaInset.top = 52;
    telegram.emit("safeAreaChanged");
    telegram.emit("contentSafeAreaChanged");
    expect(root.style.getPropertyValue("--host-safe-top")).toBe("30px");
    expect(root.style.getPropertyValue("--host-content-safe-top")).toBe("52px");

    dispose();
    expect(telegram.offEvent).toHaveBeenCalledTimes(3);
    telegram.viewportStableHeight = 900;
    telegram.emit("viewportChanged", { isStateStable: true });
    expect(root.style.getPropertyValue("--host-stable-height")).toBe("700px");
  });

  it("returns no Telegram proof for empty initData", async () => {
    const adapter = await createPlatformAdapter({
      browser: browserPort(),
      telegram: telegramFake({ initData: "" }),
    });

    await expect(
      adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 }),
    ).resolves.toBeNull();
  });

  it("replaces and removes the Telegram back handler", async () => {
    const telegram = telegramFake();
    const adapter = await createPlatformAdapter({ browser: browserPort(), telegram });
    const first = vi.fn();
    const second = vi.fn();

    await adapter.setBackHandler(first);
    await adapter.setBackHandler(second);
    await adapter.setBackHandler(null);

    expect(telegram.BackButton.onClick.mock.calls).toEqual([[first], [second]]);
    expect(telegram.BackButton.offClick.mock.calls).toEqual([[first], [second]]);
    expect(telegram.BackButton.show).toHaveBeenCalledTimes(2);
    expect(telegram.BackButton.hide).toHaveBeenCalledOnce();
  });

  it("maps every Telegram haptic kind to the host API", async () => {
    const telegram = telegramFake();
    const adapter = await createPlatformAdapter({ browser: browserPort(), telegram });

    await adapter.haptic("selection");
    await adapter.haptic("success");
    await adapter.haptic("error");

    expect(telegram.HapticFeedback.selectionChanged).toHaveBeenCalledOnce();
    expect(telegram.HapticFeedback.notificationOccurred.mock.calls).toEqual([
      ["success"],
      ["error"],
    ]);
  });

  it("uses Telegram links and rejects OIDC navigation", async () => {
    const telegram = telegramFake();
    const adapter = await createPlatformAdapter({ browser: browserPort(), telegram });

    await adapter.openExternal("https://example.test/help");
    expect(telegram.openLink).toHaveBeenCalledWith("https://example.test/help");
    await expect(adapter.openAuthorization("https://oauth.telegram.org/auth")).rejects.toThrow(
      "Telegram Mini Apps authenticate with initData, not OIDC redirect.",
    );
  });

  it("awaits an optional Android loader before inspecting browser host hints", async () => {
    const android = { kind: "android" } as PlatformAdapter;
    let resolveAndroid: ((adapter: PlatformAdapter | null) => void) | undefined;
    const loaded = new Promise<PlatformAdapter | null>((resolve) => {
      resolveAndroid = resolve;
    });
    const loadAndroid = vi.fn(() => loaded);
    const telegram = telegramFake();
    const readPlatform = vi.fn(() => "android");
    Object.defineProperty(telegram, "platform", { configurable: true, get: readPlatform });

    const pending = createPlatformAdapter({ browser: browserPort(), telegram, loadAndroid });
    await Promise.resolve();
    expect(loadAndroid).toHaveBeenCalledOnce();
    expect(readPlatform).not.toHaveBeenCalled();

    resolveAndroid?.(android);
    await expect(pending).resolves.toBe(android);
    expect(readPlatform).not.toHaveBeenCalled();
  });

  it("falls back to Telegram when the Android loader returns null", async () => {
    const loadAndroid = vi.fn().mockResolvedValue(null);
    const adapter = await createPlatformAdapter({
      browser: browserPort(),
      telegram: telegramFake(),
      loadAndroid,
    });

    expect(loadAndroid).toHaveBeenCalledOnce();
    expect(adapter.kind).toBe("telegram");
  });

  it("adapts a Window into the browser port without rewriting URLs", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const open = vi.fn();
    const assign = vi.fn();
    const storage = browserPort().storage;
    const browserWindow = {
      location: { href: "https://example.test/#raw%2Bfragment", assign },
      innerHeight: 812,
      addEventListener,
      removeEventListener,
      open,
      localStorage: storage,
    } as unknown as Window;
    const port = browserPortFromWindow(browserWindow);
    const resize = vi.fn();

    expect(port.href()).toBe("https://example.test/#raw%2Bfragment");
    expect(port.height()).toBe(812);
    expect(port.storage).toBe(storage);
    port.addResizeListener(resize);
    port.removeResizeListener(resize);
    port.open("https://outside.test/path");
    port.navigate("https://oauth.telegram.org/auth?state=raw%2Bstate");

    expect(addEventListener).toHaveBeenCalledWith("resize", resize);
    expect(removeEventListener).toHaveBeenCalledWith("resize", resize);
    expect(open).toHaveBeenCalledWith("https://outside.test/path", "_blank", "noopener,noreferrer");
    expect(assign).toHaveBeenCalledWith("https://oauth.telegram.org/auth?state=raw%2Bstate");
  });
});
