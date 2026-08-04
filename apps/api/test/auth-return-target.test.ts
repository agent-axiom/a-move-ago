import { describe, expect, it } from "vitest";
import { resolveAuthReturnTarget } from "../src/auth/return-target";

const base = {
  ENVIRONMENT: "test",
  ALLOWED_ORIGINS: "https://agent-axiom.github.io,http://localhost:5173",
  API_ORIGIN: "https://api.test",
  WEB_AUTH_RETURN_URL: "https://agent-axiom.github.io/a-move-ago/",
  ANDROID_AUTH_RETURN_URL: "amoveago-debug://auth",
};

describe("auth return targets", () => {
  it("maps only stored channels to fixed server configuration", () => {
    expect(resolveAuthReturnTarget(base, "web").toString()).toBe(
      "https://agent-axiom.github.io/a-move-ago/",
    );
    expect(resolveAuthReturnTarget(base, "android").toString()).toBe("amoveago-debug://auth");
  });

  it("requires the production Android App Link at API_ORIGIN/auth/android", () => {
    expect(
      resolveAuthReturnTarget(
        {
          ...base,
          ENVIRONMENT: "production",
          API_ORIGIN: "https://api.example.com",
          ANDROID_AUTH_RETURN_URL: "https://api.example.com/auth/android",
        },
        "android",
      ).toString(),
    ).toBe("https://api.example.com/auth/android");

    expect(() =>
      resolveAuthReturnTarget(
        {
          ...base,
          ENVIRONMENT: "production",
          API_ORIGIN: "https://api.example.com",
          ANDROID_AUTH_RETURN_URL: "https://evil.test/auth/android",
        },
        "android",
      ),
    ).toThrow("Invalid production Android auth return target");
  });

  it.each([
    "http://api.example.com",
    "https://user:pass@api.example.com",
    "https://api.example.com/prefix",
    "https://api.example.com?query=1",
    "https://api.example.com#fragment",
  ])("rejects an unsafe production API_ORIGIN: %s", (API_ORIGIN) => {
    expect(() =>
      resolveAuthReturnTarget(
        {
          ...base,
          ENVIRONMENT: "production",
          API_ORIGIN,
          ANDROID_AUTH_RETURN_URL: "https://api.example.com/auth/android",
        },
        "android",
      ),
    ).toThrow("API_ORIGIN must be an HTTPS origin");
  });

  it.each(["other-app://auth", "amoveago-debug://auth/", "https://api.test/auth/android"])(
    "rejects debug Android target substitution: %s",
    (ANDROID_AUTH_RETURN_URL) => {
      expect(() =>
        resolveAuthReturnTarget({ ...base, ANDROID_AUTH_RETURN_URL }, "android"),
      ).toThrow("Invalid debug Android auth return target");
    },
  );

  it.each([
    "not a URL",
    "javascript:alert(1)",
    "http://agent-axiom.github.io/a-move-ago/",
    "https://evil.test/a-move-ago/",
    "https://user:pass@agent-axiom.github.io/a-move-ago/",
    "https://agent-axiom.github.io/a-move-ago/?next=https://evil.test",
    "https://agent-axiom.github.io/a-move-ago/#fragment",
    "https://AGENT-AXIOM.github.io/a-move-ago/",
  ])("rejects an unsafe, normalized, or non-allowlisted Web target: %s", (WEB_AUTH_RETURN_URL) => {
    expect(() => resolveAuthReturnTarget({ ...base, WEB_AUTH_RETURN_URL }, "web")).toThrow(
      "Invalid Web auth return target",
    );
  });

  it("treats every non-development/test environment as production", () => {
    expect(() => resolveAuthReturnTarget({ ...base, ENVIRONMENT: "staging" }, "android")).toThrow(
      "Invalid production Android auth return target",
    );
  });
});
