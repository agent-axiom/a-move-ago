import { describe, expect, it } from "vitest";
import { hostHeadTags } from "./telegram-script-plugin";

const API_BASE_URL_ERROR = "VITE_API_BASE_URL must be a bare HTTPS origin without credentials.";

function expectedCsp(origin: string, allowTelegram = true) {
  return [
    "default-src 'none'",
    allowTelegram ? "script-src 'self' https://telegram.org" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src 'self' ${origin}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function cspTag(origin: string, allowTelegram = true) {
  return {
    tag: "meta",
    attrs: {
      "http-equiv": "Content-Security-Policy",
      content: expectedCsp(origin, allowTelegram),
    },
    injectTo: "head-prepend",
  };
}

const androidDebugCapabilityTag = {
  tag: "meta",
  attrs: { name: "a-move-ago-android-debug-auth", content: "enabled" },
  injectTo: "head-prepend",
};

describe("Telegram host-head tags", () => {
  it("adds the exact bounded CSP before the Telegram script in Pages", () => {
    const tags = hostHeadTags("pages", "https://api.example.test");

    expect(tags).toEqual([
      cspTag("https://api.example.test"),
      {
        tag: "script",
        attrs: { src: "https://telegram.org/js/telegram-web-app.js?63" },
        injectTo: "head-prepend",
      },
    ]);
    const content = String(tags[0]?.attrs?.content);
    expect(content).not.toContain("unsafe-eval");
    expect(content).not.toMatch(/(?:^|\s)\*(?:;|\s|$)/);
  });

  it("removes the Telegram script and its CSP permission in Android", () => {
    expect(hostHeadTags("android", "https://api.example.test")).toEqual([
      cspTag("https://api.example.test", false),
    ]);
  });

  it("emits an explicit artifact marker only for a debug-enabled Android build", () => {
    expect(hostHeadTags("android", "https://api.example.test", true)).toEqual([
      cspTag("https://api.example.test", false),
      androidDebugCapabilityTag,
    ]);
    expect(hostHeadTags("pages", "https://api.example.test", true)).not.toContainEqual(
      androidDebugCapabilityTag,
    );
  });

  it.each([
    ["localhost", "http://localhost:8787", "http://localhost:8787"],
    ["127.0.0.1", "http://127.0.0.1:8787", "http://127.0.0.1:8787"],
  ])("allows HTTP only for %s development origins", (_label, input, origin) => {
    expect(hostHeadTags("pages", input)[0]).toEqual(cspTag(origin));
  });

  it.each([
    ["a blank value", ""],
    ["a non-URL value", "api.test"],
    ["remote HTTP", "http://api.test"],
    ["credentials", "https://user:password@api.test"],
    ["a path", "https://api.test/v1"],
    ["a query", "https://api.test?preview=true"],
    ["a fragment", "https://api.test#preview"],
    ["another IPv4 loopback address", "http://127.0.0.2:8787"],
    ["an IPv6 loopback address", "http://[::1]:8787"],
    ["a localhost lookalike", "http://localhost.example.test:8787"],
  ])("rejects %s", (_label, input) => {
    expect(() => hostHeadTags("pages", input)).toThrowError(
      new RegExp(`^${API_BASE_URL_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
  });
});
