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
