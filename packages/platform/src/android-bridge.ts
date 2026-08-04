import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";
import { Haptics, NotificationType } from "@capacitor/haptics";
import { Preferences } from "@capacitor/preferences";
import type { AndroidBridge } from "./android";

export const capacitorAndroidBridge: AndroidBridge = {
  preferences: Preferences,
  browser: Browser,
  app: App,
  haptics: {
    selectionChanged: () => Haptics.selectionChanged(),
    notification: (kind) =>
      Haptics.notification({
        type: kind === "success" ? NotificationType.Success : NotificationType.Error,
      }),
  },
  layout: {
    height: () => window.innerHeight,
    addResizeListener: (listener) => window.addEventListener("resize", listener),
    removeResizeListener: (listener) => window.removeEventListener("resize", listener),
  },
  initialUrl: () => App.getLaunchUrl().then((result) => result?.url ?? null),
  isNative: () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android",
};
