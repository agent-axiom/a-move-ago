export interface PlatformArtifactContents {
  pages: string;
  android: string;
  androidHtml: string;
}

export function verifyPlatformArtifactMarkers(contents: PlatformArtifactContents): void {
  if (/Capacitor|@capacitor|amoveago-debug|a-move-ago-android-debug-auth/.test(contents.pages)) {
    throw new Error("Pages artifact contains an Android-only marker.");
  }
  if (!/Capacitor/.test(contents.android)) {
    throw new Error("Android artifact is missing the Capacitor runtime marker.");
  }
  if (!/amoveago-debug/.test(contents.android)) {
    throw new Error("Android artifact is missing the debug callback marker.");
  }
  if (!/a-move-ago-android-debug-auth["'][^>]*content=["']enabled/.test(contents.androidHtml)) {
    throw new Error("Android artifact is missing the debug capability build marker.");
  }
  if (/telegram-web-app\.js/.test(contents.android)) {
    throw new Error("Android artifact contains Telegram bootstrap.");
  }
}

const sensitiveArtifactMarkers = [
  /\bBearer [A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/,
  /SESSION_PEPPER|TELEGRAM_BOT_TOKEN|TELEGRAM_OIDC_CLIENT_SECRET|CLOUDFLARE_API_TOKEN/,
  /test-session-pepper-at-least-32-bytes|123456:test-bot-secret|test-oidc-client-secret/,
  /profile-deletion-e2e-marker|query_id=raw%2Bproof&hash=unchanged/,
];

export function verifyNoSensitiveArtifactMarkers(contents: string): void {
  if (sensitiveArtifactMarkers.some((pattern) => pattern.test(contents))) {
    throw new Error("Production artifact contains a sensitive static marker.");
  }
}
