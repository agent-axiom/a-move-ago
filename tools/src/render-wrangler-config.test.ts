import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type ProductionWranglerInput,
  renderWranglerConfig,
  runRenderWranglerConfig,
} from "./render-wrangler-config";

const sourceUrl = new URL("../../apps/api/wrangler.jsonc", import.meta.url);
const databaseId = "123e4567-e89b-42d3-a456-426614174000";
const apiOrigin = "https://api.a-move-ago.example";
const fingerprint = Array.from({ length: 32 }, () => "AB").join(":");
const sourceOrigins =
  "http://localhost:5173,https://agent-axiom.github.io,https://chess.kosarevsky.dev,https://localhost";

const productionInput: ProductionWranglerInput = {
  databaseId,
  apiOrigin,
  telegramClientId: "987654321",
  androidFingerprints: fingerprint,
  rateLimitNamespaceIds: "910000001,910000002,910000003,910000004",
};

const sentinels = [
  '"database_id": "00000000-0000-0000-0000-000000000000"',
  '"ENVIRONMENT": "development"',
  `"ALLOWED_ORIGINS": "${sourceOrigins}"`,
  '"WEB_AUTH_RETURN_URL": "https://chess.kosarevsky.dev/"',
  '"TELEGRAM_OIDC_CLIENT_ID": "123456789"',
  '"TELEGRAM_OIDC_CALLBACK_URL": "https://a-move-ago-api.example.invalid/v1/auth/telegram/oidc/callback"',
  '"API_ORIGIN": "https://a-move-ago-api.example.invalid"',
  '"ANDROID_AUTH_RETURN_URL": "amoveago-debug://auth"',
  '"ANDROID_SHA256_CERT_FINGERPRINTS": ""',
  '"namespace_id": "900000001"',
  '"namespace_id": "900000002"',
  '"namespace_id": "900000003"',
  '"namespace_id": "900000004"',
] as const;

async function sourceText(): Promise<string> {
  return await readFile(sourceUrl, "utf8");
}

describe("renderWranglerConfig", () => {
  it("renders every production value and removes every fail-closed development marker", async () => {
    const rendered = renderWranglerConfig(await sourceText(), productionInput);

    expect(rendered).toContain(`"database_id": "${databaseId}"`);
    expect(rendered).toContain('"ENVIRONMENT": "production"');
    expect(rendered).toContain(
      '"ALLOWED_ORIGINS": "https://agent-axiom.github.io,https://chess.kosarevsky.dev,https://localhost"',
    );
    expect(rendered).toContain('"TELEGRAM_OIDC_CLIENT_ID": "987654321"');
    expect(rendered).toContain(`"API_ORIGIN": "${apiOrigin}"`);
    expect(rendered).toContain(
      `"TELEGRAM_OIDC_CALLBACK_URL": "${apiOrigin}/v1/auth/telegram/oidc/callback"`,
    );
    expect(rendered).toContain(`"ANDROID_AUTH_RETURN_URL": "${apiOrigin}/auth/android"`);
    expect(rendered).toContain(`"ANDROID_SHA256_CERT_FINGERPRINTS": "${fingerprint}"`);
    for (const id of ["910000001", "910000002", "910000003", "910000004"]) {
      expect(rendered).toContain(`"namespace_id": "${id}"`);
    }
    expect(rendered).not.toContain("00000000-0000-0000-0000-000000000000");
    expect(rendered).not.toContain(".invalid");
    expect(rendered).not.toContain("amoveago-debug:");
    expect(rendered).not.toContain("http://localhost:5173");
    expect(rendered).not.toMatch(/90000000[1-4]/);
    expect(rendered).toContain('"WEB_AUTH_RETURN_URL": "https://chess.kosarevsky.dev/"');
  });

  it("uses the explicit trusted Web origins while retaining Capacitor", async () => {
    const source = (await sourceText())
      .replace("https://chess.kosarevsky.dev/", "https://play.example:8443/a-move-ago/")
      .replace(sourceOrigins, "https://play.example:8443,https://localhost");

    expect(renderWranglerConfig(source, productionInput)).toContain(
      '"ALLOWED_ORIGINS": "https://play.example:8443,https://localhost"',
    );
  });

  it("requires the auth return origin to appear in the explicit allowlist", async () => {
    const source = (await sourceText()).replace(
      "https://chess.kosarevsky.dev/",
      "https://other.example/a-move-ago/",
    );
    expect(() => renderWranglerConfig(source, productionInput)).toThrow(/not explicitly allowed/i);
  });

  it.each([
    "",
    "https://agent-axiom.github.io,,https://localhost",
    "https://agent-axiom.github.io,https://localhost,",
    "https://agent-axiom.github.io,https://localhost,https://localhost",
    "https://agent-axiom.github.io,https://localhost,http://localhost:5173,http://localhost:5173",
    "https://agent-axiom.github.io,https://localhost,*",
    "https://agent-axiom.github.io,https://localhost,https://*.example",
    "https://agent-axiom.github.io,https://localhost,http://other.example",
    "https://agent-axiom.github.io,https://localhost,https://user:pass@other.example",
    "https://agent-axiom.github.io,https://localhost,https://other.example/path",
    "https://agent-axiom.github.io,https://localhost,https://other.example/",
    "https://agent-axiom.github.io,https://localhost,https://other.example?query=yes",
    "https://agent-axiom.github.io,https://localhost,https://other.example#fragment",
    "https://agent-axiom.github.io,https://localhost,https://OTHER.example",
    "https://agent-axiom.github.io,https://localhost,https://other.example:443",
    "https://agent-axiom.github.io, https://localhost",
    "https://chess.kosarevsky.dev",
  ])("rejects malformed or incomplete explicit production origins: %s", async (origins) => {
    const source = (await sourceText()).replace(
      JSON.stringify(sourceOrigins),
      JSON.stringify(origins),
    );
    expect(() => renderWranglerConfig(source, productionInput)).toThrow(/allowed origins/i);
  });

  it("rejects duplicate nonstring declarations before rendering config", async () => {
    const source = (await sourceText()).replace(
      `"ALLOWED_ORIGINS": "${sourceOrigins}"`,
      `"ALLOWED_ORIGINS": "${sourceOrigins}", "ALLOWED_ORIGINS": false`,
    );
    expect(() => renderWranglerConfig(source, productionInput)).toThrow(/sentinel/i);
  });

  it.each([
    "not-a-url",
    "http://play.example/a-move-ago/",
    "https://user:pass@play.example/a-move-ago/",
    "https://play.example/a-move-ago/?query=yes",
    "https://play.example/a-move-ago/#fragment",
    "https://PLAY.example/a-move-ago/",
    "https://play.example:443/a-move-ago/",
    "https://play.example",
    "https://play.example,other.example/a-move-ago/",
  ])("rejects an invalid or noncanonical Web auth return URL: %s", async (returnUrl) => {
    const source = (await sourceText()).replace("https://chess.kosarevsky.dev/", returnUrl);

    expect(() => renderWranglerConfig(source, productionInput)).toThrow(/Web auth return URL/i);
  });

  it("keeps Android association fail-closed when fingerprints are blank", async () => {
    const rendered = renderWranglerConfig(await sourceText(), {
      ...productionInput,
      androidFingerprints: "   ",
    });

    expect(rendered).toContain('"ANDROID_SHA256_CERT_FINGERPRINTS": ""');
  });

  it.each(sentinels)("rejects a missing sentinel: %s", async (sentinel) => {
    const source = await sourceText();
    expect(source).toContain(sentinel);

    expect(() => renderWranglerConfig(source.replace(sentinel, ""), productionInput)).toThrow(
      /sentinel/i,
    );
  });

  it.each(sentinels)("rejects a duplicate sentinel: %s", async (sentinel) => {
    const source = await sourceText();

    expect(() =>
      renderWranglerConfig(source.replace(sentinel, `${sentinel}\n${sentinel}`), productionInput),
    ).toThrow(/sentinel/i);
  });

  it.each([
    ["databaseId", "not-a-uuid"],
    ["databaseId", "00000000-0000-0000-0000-000000000000"],
    ["databaseId", "123e4567-e89b-02d3-a456-426614174000"],
    ["apiOrigin", "http://api.a-move-ago.example"],
    ["apiOrigin", "https://user:pass@api.a-move-ago.example"],
    ["apiOrigin", "https://api.a-move-ago.example/path"],
    ["apiOrigin", "https://api.a-move-ago.example?query=yes"],
    ["apiOrigin", "https://api.a-move-ago.example#fragment"],
    ["apiOrigin", "https://api.a-move-ago.example/"],
    ["apiOrigin", "https://a-move-ago-api.example.invalid"],
    ["telegramClientId", ""],
    ["telegramClientId", "client-123"],
    ["telegramClientId", "123456789"],
    ["androidFingerprints", fingerprint.toLowerCase()],
    ["androidFingerprints", fingerprint.split(":").slice(1).join(":")],
    ["androidFingerprints", `${fingerprint},`],
    ["rateLimitNamespaceIds", "1,2,3"],
    ["rateLimitNamespaceIds", "1,2,3,3"],
    ["rateLimitNamespaceIds", "0,2,3,4"],
    ["rateLimitNamespaceIds", "1,2,3,-4"],
    ["rateLimitNamespaceIds", "1,2,3,4.5"],
    ["rateLimitNamespaceIds", "1,2,3,9007199254740992"],
    ["rateLimitNamespaceIds", "900000001,2,3,4"],
  ] as const)("rejects malformed production input %s=%s", async (key, value) => {
    const source = await sourceText();
    expect(() => renderWranglerConfig(source, { ...productionInput, [key]: value })).toThrow();
  });

  it("rejects remaining invalid and debug markers outside known fields", async () => {
    const source = await sourceText();

    expect(() =>
      renderWranglerConfig(`${source}\n// extra.example.invalid`, productionInput),
    ).toThrow(/marker/i);
    expect(() => renderWranglerConfig(`${source}\n// amoveago-debug:`, productionInput)).toThrow(
      /marker/i,
    );
    expect(() =>
      renderWranglerConfig(`${source}\n// http://localhost:5173`, productionInput),
    ).toThrow(/marker/i);
  });

  it.each([
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
    "SESSION_PEPPER",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OIDC_CLIENT_SECRET",
  ])("does not accept or render secret-shaped input %s", async (key) => {
    const secretMarker = `private-${key}`;
    const unsafe = { ...productionInput, [key]: secretMarker };
    const source = await sourceText();

    expect(() => renderWranglerConfig(source, unsafe)).toThrow(/input/i);
    expect(renderWranglerConfig(source, productionInput)).not.toContain(secretMarker);
  });
});

describe("runRenderWranglerConfig", () => {
  it.each([
    [],
    ["--source", "source.jsonc"],
    ["--unknown", "value"],
    ["--source", "source.jsonc", "--source", "again.jsonc"],
    ["--source", "--target"],
  ])("rejects an incomplete, duplicate, or unknown CLI: %j", async (...args) => {
    await expect(runRenderWranglerConfig(args as string[])).rejects.toThrow("Usage:");
  });

  it("allows an explicitly blank optional fingerprint flag for fail-closed Android auth", async () => {
    let written = "";
    const write = vi.fn(async (_path: string, contents: string) => {
      written = contents;
    });

    await runRenderWranglerConfig(
      [
        "--source",
        "wrangler.jsonc",
        "--target",
        "wrangler.production.jsonc",
        "--database-id",
        databaseId,
        "--api-origin",
        apiOrigin,
        "--telegram-client-id",
        productionInput.telegramClientId,
        "--rate-limit-namespace-ids",
        productionInput.rateLimitNamespaceIds,
        "--android-fingerprints",
        "",
      ],
      {
        cwd: "/workspace",
        readFile: async () => await sourceText(),
        writeFile: write,
        chmod: vi.fn(async () => undefined),
        log: vi.fn(),
      },
    );

    expect(write).toHaveBeenCalledOnce();
    expect(written).toContain('"ANDROID_SHA256_CERT_FINGERPRINTS": ""');
  });

  it("writes only the rendered target with mode 0600 and logs only its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a-move-ago-wrangler-"));
    const sourcePath = join(directory, "wrangler.jsonc");
    const targetPath = join(directory, "wrangler.production.jsonc");
    const log = vi.fn();
    try {
      await writeFile(sourcePath, await sourceText());
      await writeFile(targetPath, "old", { mode: 0o644 });
      await chmod(targetPath, 0o644);

      await runRenderWranglerConfig(
        [
          "--source",
          "wrangler.jsonc",
          "--target",
          "wrangler.production.jsonc",
          "--database-id",
          databaseId,
          "--api-origin",
          apiOrigin,
          "--telegram-client-id",
          productionInput.telegramClientId,
          "--rate-limit-namespace-ids",
          productionInput.rateLimitNamespaceIds,
          "--android-fingerprints",
          fingerprint,
        ],
        { cwd: directory, log },
      );

      expect(await readFile(targetPath, "utf8")).toContain(`"API_ORIGIN": "${apiOrigin}"`);
      expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(targetPath);
      expect(JSON.stringify(log.mock.calls)).not.toContain(databaseId);
      expect(JSON.stringify(log.mock.calls)).not.toContain(fingerprint);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
