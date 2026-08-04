import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AndroidAdapterConfig, type AndroidBridge, createAndroidAdapter } from "./android";
import { createCapacitorAndroidAdapter } from "./android-entry";

const entryBridge = vi.hoisted(() => ({
  preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  browser: {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
  app: {
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
  },
  haptics: {
    selectionChanged: vi.fn(async () => undefined),
    notification: vi.fn(async () => undefined),
  },
  layout: {
    height: vi.fn(() => 800),
    addResizeListener: vi.fn(),
    removeResizeListener: vi.fn(),
  },
  initialUrl: vi.fn(async () => null),
  isNative: vi.fn(() => false),
}));

vi.mock("./android-bridge", () => ({ capacitorAndroidBridge: entryBridge }));

type UrlListener = (event: { url: string }) => void | Promise<void>;
type BackListener = () => void | Promise<void>;

function fakeAndroidBridge(
  input: {
    initialUrl?: string | null;
    height?: number;
    native?: boolean;
    beforeAddListener?(name: "appUrlOpen" | "backButton"): Promise<void>;
  } = {},
) {
  const values = new Map<string, string>();
  const urlListeners = new Set<UrlListener>();
  const backListeners = new Set<BackListener>();
  const resizeListeners = new Set<() => void>();
  let height = input.height ?? 700;

  const bridge = {
    preferences: {
      get: vi.fn(async ({ key }: { key: string }) => ({ value: values.get(key) ?? null })),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        values.set(key, value);
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        values.delete(key);
      }),
    },
    browser: {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    app: {
      addListener: vi.fn(async (name: "appUrlOpen" | "backButton", listener: unknown) => {
        await input.beforeAddListener?.(name);
        const listeners = name === "appUrlOpen" ? urlListeners : backListeners;
        const typed = listener as UrlListener & BackListener;
        listeners.add(typed);
        return {
          remove: vi.fn(async () => {
            listeners.delete(typed);
          }),
        };
      }),
    },
    haptics: {
      selectionChanged: vi.fn(async () => undefined),
      notification: vi.fn(async (_kind: "success" | "error") => undefined),
    },
    layout: {
      height: vi.fn(() => height),
      addResizeListener: vi.fn((listener: () => void) => resizeListeners.add(listener)),
      removeResizeListener: vi.fn((listener: () => void) => resizeListeners.delete(listener)),
    },
    initialUrl: vi.fn(async () => input.initialUrl ?? null),
    isNative: vi.fn(() => input.native ?? true),
    async emitUrl(url: string) {
      await Promise.all([...urlListeners].map((listener) => listener({ url })));
    },
    async emitBack() {
      await Promise.all([...backListeners].map((listener) => listener()));
    },
    setHeight(value: number) {
      height = value;
    },
    emitResize() {
      for (const listener of resizeListeners) listener();
    },
  };

  return bridge as typeof bridge & AndroidBridge;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapterFor(bridge = fakeAndroidBridge(), allowDebugScheme = false) {
  return createAndroidAdapter(bridge, {
    apiOrigin: "https://api.example.test",
    allowDebugScheme,
  });
}

function layoutTarget() {
  const values = new Map<string, string>();
  return {
    target: {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement,
    values,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Android adapter", () => {
  it("exposes the Android platform identity", () => {
    expect(adapterFor()).toMatchObject({
      kind: "android",
      channel: "android",
      authMode: "oidc-android",
    });
  });

  it("persists only the app session token under the versioned Preferences key", async () => {
    const bridge = fakeAndroidBridge();
    const adapter = adapterFor(bridge);

    await adapter.tokenStore.write("session-token");
    expect(bridge.preferences.set).toHaveBeenCalledWith({
      key: "amoveago.session.v1",
      value: "session-token",
    });
    await expect(adapter.tokenStore.read()).resolves.toBe("session-token");
    expect(bridge.preferences.get).toHaveBeenCalledWith({ key: "amoveago.session.v1" });
    await adapter.tokenStore.clear();
    expect(bridge.preferences.remove).toHaveBeenCalledWith({ key: "amoveago.session.v1" });
    await expect(adapter.tokenStore.read()).resolves.toBeNull();
  });

  it.each([
    "http://api.example.test",
    "https://user@api.example.test",
    "https://api.example.test/",
    "https://api.example.test/path",
    "https://api.example.test?query=yes",
    "https://api.example.test#fragment",
    "not a URL",
  ])("rejects a non-bare HTTPS API origin: %s", (apiOrigin) => {
    expect(() =>
      createAndroidAdapter(fakeAndroidBridge(), { apiOrigin, allowDebugScheme: false }),
    ).toThrow("apiOrigin must be a bare HTTPS origin");
  });

  it("opens authorization and external links only through the system browser port", async () => {
    const bridge = fakeAndroidBridge();
    const adapter = adapterFor(bridge);

    await adapter.openAuthorization("https://oauth.telegram.org/auth");
    await adapter.openExternal("https://example.test/help");

    expect(bridge.browser.open.mock.calls).toEqual([
      [{ url: "https://oauth.telegram.org/auth", presentationStyle: "popover" }],
      [{ url: "https://example.test/help", presentationStyle: "popover" }],
    ]);
  });

  it("forwards only exact production handoffs or explicit provider denials", async () => {
    const bridge = fakeAndroidBridge();
    const adapter = adapterFor(bridge);
    const seen: string[] = [];
    const unsubscribe = await adapter.authReturn.subscribe((url) => seen.push(url));
    const handoff = "a".repeat(43);
    const accepted = [
      `https://api.example.test/auth/android?handoff=${handoff}`,
      "https://api.example.test/auth/android?authError=access_denied",
    ];
    const rejected = [
      `https://evil.test/auth/android?handoff=${handoff}`,
      `https://user@api.example.test/auth/android?handoff=${handoff}`,
      `https://@api.example.test/auth/android?handoff=${handoff}`,
      `https://api.example.test/other?handoff=${handoff}`,
      `https://api.example.test/auth/android/?handoff=${handoff}`,
      `https://api.example.test/auth/android?handoff=${handoff}&next=evil`,
      `https://api.example.test/auth/android?handoff=${handoff}&handoff=${handoff}`,
      `https://api.example.test/auth/android?handoff=${handoff}&`,
      `https://api.example.test/auth/android?%68andoff=${handoff}`,
      `https://api.example.test/auth/android?handoff=%61${handoff.slice(1)}`,
      `https://api.example.test/auth/android?handoff=${handoff}#`,
      "https://api.example.test/auth/android?authError=server_error",
      "https://api.example.test/auth/android?authError=access_denied&next=evil",
      "https://api.example.test/auth/android?authError=access_denied#fragment",
      `amoveago-debug://auth?handoff=${handoff}`,
      "javascript:alert(1)",
      "not a URL",
    ];

    for (const url of [...accepted, ...rejected]) await bridge.emitUrl(url);

    expect(seen).toEqual(accepted);
    expect(bridge.browser.close).toHaveBeenCalledTimes(2);
    const handle = await bridge.app.addListener.mock.results[0]?.value;
    await unsubscribe();
    expect(handle?.remove).toHaveBeenCalledOnce();

    await bridge.emitUrl(`https://api.example.test/auth/android?handoff=${handoff}`);
    expect(seen).toEqual(accepted);
  });

  it("allows the exact debug target only behind the explicit build capability", async () => {
    const handoff = "b".repeat(43);
    const accepted = [
      `amoveago-debug://auth?handoff=${handoff}`,
      "amoveago-debug://auth?authError=access_denied",
    ];
    const debugBridge = fakeAndroidBridge();
    const seen: string[] = [];
    await adapterFor(debugBridge, true).authReturn.subscribe((url) => seen.push(url));

    for (const url of [
      ...accepted,
      `amoveago-debug://evil?handoff=${handoff}`,
      `amoveago-debug://auth/path?handoff=${handoff}`,
      `amoveago-debug://auth?handoff=${handoff}&next=evil`,
      "amoveago-debug://auth?authError=server_error",
      "amoveago-debug://auth?authError=access_denied#fragment",
    ]) {
      await debugBridge.emitUrl(url);
    }

    expect(seen).toEqual(accepted);
    expect(debugBridge.browser.close).toHaveBeenCalledTimes(2);

    const releaseBridge = fakeAndroidBridge();
    const releaseSeen: string[] = [];
    await adapterFor(releaseBridge).authReturn.subscribe((url) => releaseSeen.push(url));
    for (const url of accepted) await releaseBridge.emitUrl(url);
    expect(releaseSeen).toEqual([]);
    expect(releaseBridge.browser.close).not.toHaveBeenCalled();
  });

  it("does not widen the debug capability for a truthy non-boolean runtime value", async () => {
    const handoff = "c".repeat(43);
    const debugUrl = `amoveago-debug://auth?handoff=${handoff}`;
    const bridge = fakeAndroidBridge({ initialUrl: debugUrl });
    const invalidRuntimeConfig = {
      apiOrigin: "https://api.example.test",
      allowDebugScheme: "true",
    } as unknown as AndroidAdapterConfig;

    await expect(
      createAndroidAdapter(bridge, invalidRuntimeConfig).authReturn.initialUrl(),
    ).resolves.toBeNull();
    expect(bridge.browser.close).not.toHaveBeenCalled();
  });

  it("filters cold-start returns and closes the browser only for an accepted URL", async () => {
    const productionDenial = "https://api.example.test/auth/android?authError=access_denied";
    const productionBridge = fakeAndroidBridge({ initialUrl: productionDenial });
    await expect(adapterFor(productionBridge).authReturn.initialUrl()).resolves.toBe(
      productionDenial,
    );
    expect(productionBridge.browser.close).toHaveBeenCalledOnce();

    const debugDenial = "amoveago-debug://auth?authError=access_denied";
    const debugBridge = fakeAndroidBridge({ initialUrl: debugDenial });
    await expect(adapterFor(debugBridge, true).authReturn.initialUrl()).resolves.toBe(debugDenial);
    expect(debugBridge.browser.close).toHaveBeenCalledOnce();

    const releaseBridge = fakeAndroidBridge({ initialUrl: debugDenial });
    await expect(adapterFor(releaseBridge).authReturn.initialUrl()).resolves.toBeNull();
    expect(releaseBridge.browser.close).not.toHaveBeenCalled();
  });

  it("forwards accepted warm and cold returns when closing the browser fails", async () => {
    const handoff = "d".repeat(43);
    const url = `https://api.example.test/auth/android?handoff=${handoff}`;
    const coldBridge = fakeAndroidBridge({ initialUrl: url });
    coldBridge.browser.close.mockRejectedValue(new Error("already closed"));
    await expect(adapterFor(coldBridge).authReturn.initialUrl()).resolves.toBe(url);

    const warmBridge = fakeAndroidBridge();
    warmBridge.browser.close.mockRejectedValue(new Error("already closed"));
    const seen: string[] = [];
    await adapterFor(warmBridge).authReturn.subscribe((value) => seen.push(value));
    await expect(warmBridge.emitUrl(url)).resolves.toBeUndefined();
    expect(seen).toEqual([url]);
  });

  it("suppresses an in-flight auth callback after synchronous unsubscribe", async () => {
    const handoff = "e".repeat(43);
    const url = `https://api.example.test/auth/android?handoff=${handoff}`;
    const close = deferred();
    const bridge = fakeAndroidBridge();
    bridge.browser.close.mockImplementation(async () => {
      await close.promise;
      return undefined;
    });
    const seen: string[] = [];
    const unsubscribe = await adapterFor(bridge).authReturn.subscribe((value) => seen.push(value));

    const pending = bridge.emitUrl(url);
    await vi.waitFor(() => expect(bridge.browser.close).toHaveBeenCalledOnce());
    const handle = await bridge.app.addListener.mock.results[0]?.value;
    handle?.remove.mockRejectedValue(new Error("listener already removed"));
    expect(unsubscribe()).toBeUndefined();
    close.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(seen).toEqual([]);
    await Promise.resolve();
  });

  it("replaces and removes the native back-button listener", async () => {
    const bridge = fakeAndroidBridge();
    const adapter = adapterFor(bridge);
    const first = vi.fn();
    const second = vi.fn();

    await adapter.setBackHandler(first);
    const firstHandle = await bridge.app.addListener.mock.results[0]?.value;
    await bridge.emitBack();
    expect(first).toHaveBeenCalledOnce();

    await adapter.setBackHandler(second);
    const secondHandle = await bridge.app.addListener.mock.results[1]?.value;
    expect(firstHandle?.remove).toHaveBeenCalledOnce();
    await bridge.emitBack();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    await adapter.setBackHandler(null);
    expect(secondHandle?.remove).toHaveBeenCalledOnce();
    await bridge.emitBack();
    expect(second).toHaveBeenCalledOnce();
    expect(bridge.app.addListener.mock.calls.map(([name]) => name)).toEqual([
      "backButton",
      "backButton",
    ]);
  });

  it("serializes overlapping back-handler replacements without leaking a stale listener", async () => {
    const firstAddStarted = deferred();
    const releaseFirstAdd = deferred();
    let backAdds = 0;
    const bridge = fakeAndroidBridge({
      async beforeAddListener(name) {
        if (name === "backButton" && backAdds++ === 0) {
          firstAddStarted.resolve();
          await releaseFirstAdd.promise;
        }
      },
    });
    const adapter = adapterFor(bridge);
    const first = vi.fn();
    const second = vi.fn();

    const installFirst = adapter.setBackHandler(first);
    await firstAddStarted.promise;
    const installSecond = adapter.setBackHandler(second);
    releaseFirstAdd.resolve();
    await Promise.all([installFirst, installSecond]);
    await bridge.emitBack();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    const firstHandle = await bridge.app.addListener.mock.results[0]?.value;
    expect(firstHandle?.remove).toHaveBeenCalledOnce();
  });

  it("updates and cleans up Android layout variables", () => {
    const bridge = fakeAndroidBridge({ height: 720 });
    const adapter = adapterFor(bridge);
    const { target } = layoutTarget();

    const removeLayout = adapter.installLayoutVars(target);
    expect(target.style.getPropertyValue("--host-stable-height")).toBe("720px");
    for (const edge of ["top", "right", "bottom", "left"]) {
      const inset = `env(safe-area-inset-${edge}, 0px)`;
      expect(target.style.getPropertyValue(`--host-safe-${edge}`)).toBe(inset);
      expect(target.style.getPropertyValue(`--host-content-safe-${edge}`)).toBe(inset);
    }

    bridge.setHeight(744);
    bridge.emitResize();
    expect(target.style.getPropertyValue("--host-stable-height")).toBe("744px");
    const listener = bridge.layout.addResizeListener.mock.calls[0]?.[0];
    removeLayout();
    expect(bridge.layout.removeResizeListener).toHaveBeenCalledWith(listener);

    bridge.setHeight(800);
    bridge.emitResize();
    expect(target.style.getPropertyValue("--host-stable-height")).toBe("744px");
  });

  it("maps every haptic kind and implements the non-Telegram proof contract", async () => {
    const bridge = fakeAndroidBridge();
    const adapter = adapterFor(bridge);

    await adapter.ready();
    await adapter.ready();
    await adapter.haptic("selection");
    await adapter.haptic("success");
    await adapter.haptic("error");
    await expect(
      adapter.requestTelegramProof({ reason: "save-progress", userInitiatedAt: 1 }),
    ).resolves.toBeNull();

    expect(bridge.haptics.selectionChanged).toHaveBeenCalledOnce();
    expect(bridge.haptics.notification.mock.calls).toEqual([["success"], ["error"]]);
  });
});

describe("Capacitor Android entry", () => {
  it("returns null when Capacitor does not report a native Android platform", async () => {
    entryBridge.isNative.mockReturnValue(false);

    await expect(
      createCapacitorAndroidAdapter({
        apiOrigin: "https://api.example.test",
        allowDebugScheme: false,
      }),
    ).resolves.toBeNull();
    expect(entryBridge.isNative).toHaveBeenCalledOnce();
  });

  it("creates the Android adapter only after native Android detection", async () => {
    entryBridge.isNative.mockReturnValue(true);

    await expect(
      createCapacitorAndroidAdapter({
        apiOrigin: "https://api.example.test",
        allowDebugScheme: false,
      }),
    ).resolves.toMatchObject({
      kind: "android",
      channel: "android",
      authMode: "oidc-android",
    });
    expect(entryBridge.isNative).toHaveBeenCalledOnce();
  });
});
