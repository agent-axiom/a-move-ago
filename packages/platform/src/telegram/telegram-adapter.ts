import type { PlatformAdapter } from "../types";
import { createWebTokenStore } from "../web/token-store";
import type { BrowserPort } from "../web/web-adapter";
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
