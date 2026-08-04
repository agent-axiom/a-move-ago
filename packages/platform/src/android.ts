import type { PlatformAdapter } from "./types";

const SESSION_TOKEN_KEY = "amoveago.session.v1";
const HANDOFF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BROWSER_OPTIONS = { presentationStyle: "popover" as const };
const READY = Promise.resolve();

interface AndroidListenerHandle {
  remove(): Promise<void>;
}

export interface AndroidBridge {
  preferences: {
    get(input: { key: string }): Promise<{ value: string | null }>;
    set(input: { key: string; value: string }): Promise<void>;
    remove(input: { key: string }): Promise<void>;
  };
  browser: {
    open(input: { url: string; presentationStyle: "popover" }): Promise<void>;
    close(): Promise<void>;
  };
  app: {
    addListener(
      eventName: "appUrlOpen",
      listener: (event: { url: string }) => void,
    ): Promise<AndroidListenerHandle>;
    addListener(eventName: "backButton", listener: () => void): Promise<AndroidListenerHandle>;
  };
  haptics: {
    selectionChanged(): Promise<void>;
    notification(kind: "success" | "error"): Promise<void>;
  };
  layout: {
    height(): number;
    addResizeListener(listener: () => void): void;
    removeResizeListener(listener: () => void): void;
  };
  initialUrl(): Promise<string | null>;
  isNative(): boolean;
}

export interface AndroidAdapterConfig {
  apiOrigin: string;
  allowDebugScheme: boolean;
}

function requireBareHttpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("apiOrigin must be a bare HTTPS origin.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    throw new Error("apiOrigin must be a bare HTTPS origin.");
  }
  return parsed.origin;
}

function hasExactAuthResult(candidate: string, target: string, parsed: URL): boolean {
  const entries = [...parsed.searchParams.entries()];
  if (entries.length !== 1) return false;
  const [entry] = entries;
  if (!entry) return false;
  const [key, value] = entry;
  if (key === "handoff" && HANDOFF_PATTERN.test(value)) {
    return candidate === `${target}?handoff=${value}`;
  }
  return key === "authError" && value === "access_denied"
    ? candidate === `${target}?authError=access_denied`
    : false;
}

function isAcceptedAuthReturn(
  candidate: string,
  apiOrigin: string,
  allowDebugScheme: boolean,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;

  const productionTarget =
    parsed.protocol === "https:" &&
    parsed.origin === apiOrigin &&
    parsed.pathname === "/auth/android";
  const debugTarget =
    allowDebugScheme &&
    parsed.protocol === "amoveago-debug:" &&
    parsed.host === "auth" &&
    parsed.pathname === "";
  const target = productionTarget
    ? `${apiOrigin}/auth/android`
    : debugTarget
      ? "amoveago-debug://auth"
      : null;
  return target !== null && hasExactAuthResult(candidate, target, parsed);
}

export function createAndroidAdapter(
  bridge: AndroidBridge,
  config: AndroidAdapterConfig,
): PlatformAdapter {
  const apiOrigin = requireBareHttpsOrigin(config.apiOrigin);
  const allowDebugScheme = config.allowDebugScheme === true;
  let backHandle: AndroidListenerHandle | null = null;
  let backQueue: Promise<void> = READY;

  const acceptAuthReturn = async (candidate: string): Promise<string | null> => {
    if (!isAcceptedAuthReturn(candidate, apiOrigin, allowDebugScheme)) return null;
    try {
      await bridge.browser.close();
    } catch {
      // The verified return is authoritative even if the system browser is already closed.
    }
    return candidate;
  };

  return {
    kind: "android",
    channel: "android",
    authMode: "oidc-android",
    tokenStore: {
      async read() {
        return (await bridge.preferences.get({ key: SESSION_TOKEN_KEY })).value;
      },
      async write(token) {
        await bridge.preferences.set({ key: SESSION_TOKEN_KEY, value: token });
      },
      async clear() {
        await bridge.preferences.remove({ key: SESSION_TOKEN_KEY });
      },
    },
    authReturn: {
      async initialUrl() {
        const candidate = await bridge.initialUrl();
        return candidate === null ? null : acceptAuthReturn(candidate);
      },
      async subscribe(listener) {
        let active = true;
        const handle = await bridge.app.addListener("appUrlOpen", async ({ url }) => {
          const accepted = await acceptAuthReturn(url);
          if (active && accepted !== null) listener(accepted);
        });
        return () => {
          active = false;
          void handle.remove().catch(() => undefined);
        };
      },
    },
    ready() {
      return READY;
    },
    installLayoutVars(target) {
      const update = () => {
        target.style.setProperty("--host-stable-height", `${bridge.layout.height()}px`);
        for (const edge of ["top", "right", "bottom", "left"]) {
          const inset = `env(safe-area-inset-${edge}, 0px)`;
          target.style.setProperty(`--host-safe-${edge}`, inset);
          target.style.setProperty(`--host-content-safe-${edge}`, inset);
        }
      };
      update();
      bridge.layout.addResizeListener(update);
      return () => bridge.layout.removeResizeListener(update);
    },
    setBackHandler(handler) {
      const replace = backQueue.then(async () => {
        await backHandle?.remove();
        backHandle = null;
        if (handler) {
          backHandle = await bridge.app.addListener("backButton", () => handler());
        }
      });
      backQueue = replace.catch(() => undefined);
      return replace;
    },
    async haptic(kind) {
      if (kind === "selection") await bridge.haptics.selectionChanged();
      else await bridge.haptics.notification(kind);
    },
    async openExternal(url) {
      await bridge.browser.open({ url, ...BROWSER_OPTIONS });
    },
    async openAuthorization(url) {
      await bridge.browser.open({ url, ...BROWSER_OPTIONS });
    },
    async requestTelegramProof() {
      return null;
    },
  };
}
