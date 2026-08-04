export interface TelegramInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TelegramWebAppLike {
  platform: string;
  initData: string;
  viewportStableHeight: number;
  safeAreaInset: TelegramInsets;
  contentSafeAreaInset: TelegramInsets;
  ready(): void;
  openLink(url: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  HapticFeedback: {
    selectionChanged(): void;
    notificationOccurred(type: "success" | "error"): void;
  };
  onEvent(name: string, handler: (...args: unknown[]) => void): void;
  offEvent(name: string, handler: (...args: unknown[]) => void): void;
}
