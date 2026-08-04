import { createTelegramAdapter } from "./telegram/telegram-adapter";
import type { TelegramWebAppLike } from "./telegram/telegram-types";
import type { PlatformAdapter } from "./types";
import { type BrowserPort, createWebAdapter } from "./web/web-adapter";

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
