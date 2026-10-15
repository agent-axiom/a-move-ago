import { type ApiClient, createApiClient } from "@a-move-ago/api-contract";
import {
  browserPortFromWindow,
  createPlatformAdapter,
  type PlatformAdapter,
} from "@a-move-ago/platform";
import { createContext, type ReactNode, useContext } from "react";

export interface TokenHolder {
  get(): string | null;
  set(value: string | null): void;
}

export function createTokenHolder(): TokenHolder {
  let token: string | null = null;
  return {
    get: () => token,
    set: (value) => {
      token = value;
    },
  };
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
  const api = createApiClient({
    baseUrl,
    getToken: token.get,
    includeLocalizations: true,
    includeGameProgress: true,
  });
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
