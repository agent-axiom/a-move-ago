/// <reference types="vite/client" />

import type { TelegramWebAppLike } from "@a-move-ago/platform";

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebAppLike };
  }
}
