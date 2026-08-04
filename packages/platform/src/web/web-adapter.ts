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
