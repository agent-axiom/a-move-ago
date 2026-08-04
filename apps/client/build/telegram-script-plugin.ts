import type { HtmlTagDescriptor, Plugin } from "vite";

export type ClientBuildMode = "pages" | "android";

function apiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_API_BASE_URL must be a bare HTTPS origin without credentials.");
  }
  const localHttp =
    url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (!localHttp && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("VITE_API_BASE_URL must be a bare HTTPS origin without credentials.");
  }
  return url.origin;
}

export function hostHeadTags(
  mode: ClientBuildMode,
  apiBaseUrl: string,
  allowAndroidDebugScheme = false,
): HtmlTagDescriptor[] {
  const content = [
    "default-src 'none'",
    mode === "pages" ? "script-src 'self' https://telegram.org" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src 'self' ${apiOrigin(apiBaseUrl)}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const tags: HtmlTagDescriptor[] = [
    {
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content },
      injectTo: "head-prepend",
    },
  ];
  if (mode === "pages") {
    tags.push({
      tag: "script",
      attrs: { src: "https://telegram.org/js/telegram-web-app.js?63" },
      injectTo: "head-prepend",
    });
  } else if (allowAndroidDebugScheme === true) {
    tags.push({
      tag: "meta",
      attrs: { name: "a-move-ago-android-debug-auth", content: "enabled" },
      injectTo: "head-prepend",
    });
  }
  return tags;
}

export function hostHeadPlugin(
  mode: ClientBuildMode,
  apiBaseUrl: string,
  allowAndroidDebugScheme = false,
): Plugin {
  return {
    name: "a-move-ago-host-head",
    transformIndexHtml: {
      order: "pre",
      handler: () => hostHeadTags(mode, apiBaseUrl, allowAndroidDebugScheme),
    },
  };
}
