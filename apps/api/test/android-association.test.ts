import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";

const TEST_FINGERPRINT =
  "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const SECOND_FINGERPRINT = Array.from({ length: 32 }, () => "FF").join(":");
const ANDROID_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

type AndroidBindings = {
  ANDROID_PACKAGE_NAME: string;
  ANDROID_SHA256_CERT_FINGERPRINTS: string;
};

const workerEnv = env as Env & AndroidBindings;
const app = createApp();

function overrideEnv(bindings: Partial<AndroidBindings>): Env {
  const requestEnv = Object.create(workerEnv) as Env & AndroidBindings;
  for (const [key, value] of Object.entries(bindings)) {
    Object.defineProperty(requestEnv, key, { configurable: true, enumerable: true, value });
  }
  return requestEnv;
}

async function directFetch(
  path: string,
  bindings: Partial<AndroidBindings>,
  init?: RequestInit,
): Promise<Response> {
  return await app.fetch(new Request(`https://api.test${path}`, init), overrideEnv(bindings));
}

async function expectConfigurationError(bindings: Partial<AndroidBindings>): Promise<void> {
  const response = await directFetch("/.well-known/assetlinks.json", bindings);
  const body = (await response.json()) as {
    error?: { code?: string; message?: string; requestId?: string };
  };

  expect(response.status).toBe(503);
  expect(body.error?.code).toBe("CONFIGURATION_ERROR");
  expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  const configuredFingerprints = bindings.ANDROID_SHA256_CERT_FINGERPRINTS;
  if (configuredFingerprints?.trim()) {
    expect(JSON.stringify(body)).not.toContain(configuredFingerprints);
  }
}

describe("Android association", () => {
  it("publishes the exact Digital Asset Links statement without authentication", async () => {
    const association = await SELF.fetch("https://api.test/.well-known/assetlinks.json");

    expect(association.status).toBe(200);
    await expect(association.json()).resolves.toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.agentaxiom.amoveago",
          sha256_cert_fingerprints: [TEST_FINGERPRINT],
        },
      },
    ]);
    expect(association.headers.get("content-type")).toContain("application/json");
    expect(association.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("trims, deduplicates, and sorts comma-separated fingerprints", async () => {
    const association = await directFetch("/.well-known/assetlinks.json", {
      ANDROID_SHA256_CERT_FINGERPRINTS: ` ${SECOND_FINGERPRINT}, ${TEST_FINGERPRINT},${SECOND_FINGERPRINT} `,
    });

    expect(association.status).toBe(200);
    const body = (await association.json()) as Array<{
      target: { sha256_cert_fingerprints: string[] };
    }>;
    expect(body[0]?.target.sha256_cert_fingerprints).toEqual([
      TEST_FINGERPRINT,
      SECOND_FINGERPRINT,
    ]);
  });

  it.each([
    "",
    "   ",
    TEST_FINGERPRINT.toLowerCase(),
    "AA:BB:CC",
    `${TEST_FINGERPRINT},`,
    `,${TEST_FINGERPRINT}`,
    `${TEST_FINGERPRINT},,${SECOND_FINGERPRINT}`,
  ])("fails closed for an empty or malformed fingerprint list: %j", async (fingerprints) => {
    await expectConfigurationError({ ANDROID_SHA256_CERT_FINGERPRINTS: fingerprints });
  });

  it.each([
    "",
    "com..agentaxiom.amoveago",
    "com.agent-axiom.amoveago",
    "com.agentaxiom.amoveago<script>",
    "1com.agentaxiom.amoveago",
  ])("fails closed for a malformed package name: %j", async (packageName) => {
    const response = await directFetch("/.well-known/assetlinks.json", {
      ANDROID_PACKAGE_NAME: packageName,
    });
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(503);
    expect(body.error?.code).toBe("CONFIGURATION_ERROR");
    if (packageName) expect(JSON.stringify(body)).not.toContain(packageName);
  });
});

describe("Android callback fallback", () => {
  it("returns static hardened HTML and never reflects duplicate handoff or query secrets", async () => {
    const fallback = await SELF.fetch(
      "https://api.test/auth/android?handoff=secret-code&handoff=second-secret&next=https%3A%2F%2Fevil.test",
    );
    const html = await fallback.text();

    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    expect(fallback.headers.get("content-security-policy")).toBe(ANDROID_CSP);
    expect(fallback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fallback.headers.get("cache-control")).toBe("no-store");
    expect(fallback.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.match(/Return to A MOVE AGO on your Android device\./g)).toHaveLength(1);
    expect(html).not.toMatch(/secret-code|second-secret|evil\.test|handoff|<script|<img|https?:/i);
  });

  it.each([
    ["/.well-known/assetlinks.json?handoff=asset-secret", "POST"],
    ["/auth/android?handoff=callback-secret", "POST"],
  ])("does not serve static GET content for %s %s", async (path, method) => {
    const response = await SELF.fetch(`https://api.test${path}`, { method });
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toMatch(/asset-secret|callback-secret/);
  });
});
