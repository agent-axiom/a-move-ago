import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { verifyPlatformArtifactMarkers } from "./artifact-profile-verifier.ts";

const pages = await readFile(new URL("../dist/pages/index.html", import.meta.url), "utf8");
const android = await readFile(new URL("../dist/android/index.html", import.meta.url), "utf8");
const decodeHtmlAttributes = (value) =>
  value.replaceAll("&#39;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const decodedPages = decodeHtmlAttributes(pages);
const decodedAndroid = decodeHtmlAttributes(android);
const csp = pages.indexOf("Content-Security-Policy");
const telegram = pages.indexOf("telegram-web-app.js?63");
const application = pages.indexOf('type="module"');
assert(
  csp >= 0 && telegram > csp && application > telegram,
  "Pages CSP and Telegram script must precede the app module",
);
assert.match(decodedPages, /connect-src[^;]*https:\/\/api\.test/);
assert.match(pages, /\/a-move-ago\/assets\//);
assert.doesNotMatch(decodedPages, /unsafe-eval|script-src[^;]*\*|connect-src[^;]*\*/);
const androidCsp = android.indexOf("Content-Security-Policy");
const androidApplication = android.indexOf('type="module"');
assert(
  androidCsp >= 0 && androidApplication > androidCsp,
  "Android CSP must precede the app module",
);
assert.match(decodedAndroid, /connect-src[^;]*https:\/\/api\.test/);
assert.doesNotMatch(decodedAndroid, /unsafe-eval|script-src[^;]*\*|connect-src[^;]*\*/);
assert.doesNotMatch(decodedAndroid, /telegram\.org/);
assert.match(android, /["']\/assets\//);
assert.doesNotMatch(android, /telegram-web-app\.js|\/a-move-ago\/assets\//);

const assetDirectories = [
  new URL("../dist/pages/assets/", import.meta.url),
  new URL("../dist/android/assets/", import.meta.url),
];
const entries = await Promise.all(
  assetDirectories.map((directory) => readdir(directory, { recursive: true })),
);
assert.equal(
  entries.flat().some((name) => name.endsWith(".map")),
  false,
  "Deployable source maps are disabled",
);
const scriptsByProfile = assetDirectories.map((directory, index) =>
  (entries[index] ?? [])
    .filter((name) => name.endsWith(".js"))
    .map((name) => new URL(name, directory)),
);
assert(
  scriptsByProfile.every((scripts) => scripts.length > 0),
  "Each production artifact must contain an application script",
);
const bundles = await Promise.all(
  scriptsByProfile.map(async (scripts) =>
    (await Promise.all(scripts.map((url) => readFile(url, "utf8")))).join("\n"),
  ),
);
verifyPlatformArtifactMarkers({
  pages: [pages, bundles[0] ?? ""].join("\n"),
  android: [android, bundles[1] ?? ""].join("\n"),
  androidHtml: android,
});
assert.doesNotMatch(
  [pages, android, ...bundles].join("\n"),
  /rnbqkbnr\/ppp1pppp\/8\/3p4\/4P3\/8\/PPPP1PPP/,
  "The known previous-position answer must not enter either production frontend bundle",
);
console.log("Pages and Android web artifacts verified.");
