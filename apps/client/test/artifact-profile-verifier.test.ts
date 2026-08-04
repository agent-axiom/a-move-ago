import { describe, expect, it } from "vitest";
import { verifyPlatformArtifactMarkers } from "./artifact-profile-verifier";

const separatedProfiles = {
  pages: "web application bundle",
  android:
    'Capacitor native runtime amoveago-debug <meta name="a-move-ago-android-debug-auth" content="enabled">',
  androidHtml: '<meta name="a-move-ago-android-debug-auth" content="enabled">',
};

describe("platform artifact markers", () => {
  it("accepts a Capacitor-free Pages profile and a native Android profile", () => {
    expect(() => verifyPlatformArtifactMarkers(separatedProfiles)).not.toThrow();
  });

  it.each(["Capacitor", "@capacitor", "amoveago-debug"])(
    "rejects the Android-only %s marker in Pages",
    (marker) => {
      expect(() =>
        verifyPlatformArtifactMarkers({
          ...separatedProfiles,
          pages: `web application bundle ${marker}`,
        }),
      ).toThrow("Pages artifact contains an Android-only marker");
    },
  );

  it("rejects the Android debug capability marker in Pages", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        pages: 'web application <meta name="a-move-ago-android-debug-auth" content="enabled">',
      }),
    ).toThrow("Pages artifact contains an Android-only marker");
  });

  it("rejects an Android artifact without the Capacitor runtime", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        android: "native runtime amoveago-debug",
      }),
    ).toThrow("Android artifact is missing the Capacitor runtime marker");
  });

  it("rejects an Android artifact without the build-gated debug callback", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        android: "Capacitor native runtime",
      }),
    ).toThrow("Android artifact is missing the debug callback marker");
  });

  it("rejects an Android artifact without the debug capability build marker", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        android: "Capacitor native runtime amoveago-debug",
        androidHtml: "<html></html>",
      }),
    ).toThrow("Android artifact is missing the debug capability build marker");
  });

  it("does not accept a debug capability marker that exists only in JavaScript", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        android:
          'Capacitor native runtime amoveago-debug "a-move-ago-android-debug-auth" content="enabled"',
        androidHtml: "<html></html>",
      }),
    ).toThrow("Android artifact is missing the debug capability build marker");
  });

  it("rejects Telegram bootstrap in the Android artifact", () => {
    expect(() =>
      verifyPlatformArtifactMarkers({
        ...separatedProfiles,
        android: `${separatedProfiles.android} https://telegram.org/js/telegram-web-app.js?63`,
      }),
    ).toThrow("Android artifact contains Telegram bootstrap");
  });
});
