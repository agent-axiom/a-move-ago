export type PlatformKind = "web" | "telegram" | "android";
export type ClientChannel = "web" | "telegram" | "android";
export type AuthMode = "oidc-web" | "mini-app" | "oidc-android";
export type HapticKind = "selection" | "success" | "error";

export interface TokenStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TelegramProof {
  kind: "telegram-mini-app";
  initData: string;
}

export interface AuthReturnPort {
  initialUrl(): Promise<string | null>;
  subscribe(listener: (url: string) => void): Promise<() => void>;
}

export interface PlatformAdapter {
  readonly kind: PlatformKind;
  readonly channel: ClientChannel;
  readonly authMode: AuthMode;
  readonly tokenStore: TokenStore;
  readonly authReturn: AuthReturnPort;
  ready(): Promise<void>;
  installLayoutVars(target: HTMLElement): () => void;
  setBackHandler(handler: (() => void) | null): Promise<void>;
  haptic(kind: HapticKind): Promise<void>;
  openExternal(url: string): Promise<void>;
  openAuthorization(url: string): Promise<void>;
  requestTelegramProof(input: {
    reason: "save-progress";
    userInitiatedAt: number;
  }): Promise<TelegramProof | null>;
}
