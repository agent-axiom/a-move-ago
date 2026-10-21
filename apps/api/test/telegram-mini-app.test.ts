import { describe, expect, it } from "vitest";
import { TelegramProofError, verifyMiniAppInitData } from "../src/auth/telegram-mini-app";
import { bytesToBase64Url, hexToBytes } from "../src/crypto/encoding";
import { hashOpaqueToken, hashSessionToken } from "../src/crypto/opaque-token";
import { defaultWebAppUser, signedMiniAppData } from "./fixtures/telegram";

const botToken = "123456:test-bot-secret";
const now = 1_785_758_400;
const options = {
  botToken,
  nowSeconds: now,
  maxAgeSeconds: 3600,
  futureSkewSeconds: 30,
};

type RawCase = readonly [name: string, makeRaw: () => Promise<string>];
type InvalidOptionOverride = Partial<Record<keyof typeof options, unknown>>;

function withHash(raw: string, hash: string): string {
  const params = new URLSearchParams(raw);
  params.set("hash", hash);
  return params.toString();
}

function reordered(raw: string): string {
  return [...new URLSearchParams(raw).entries()]
    .reverse()
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function expectProofCode(
  promise: Promise<unknown>,
  code: "TELEGRAM_PROOF_INVALID" | "TELEGRAM_PROOF_EXPIRED",
  stage?: TelegramProofError["stage"],
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected Telegram proof rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramProofError);
    expect(error).toMatchObject({ code, message: code, name: "TelegramProofError" });
    if (stage !== undefined) expect(error).toMatchObject({ stage });
  }
}

describe("Telegram Mini App proof", () => {
  it("pins an independently precomputed bot-token HMAC vector", async () => {
    const raw = await signedMiniAppData({ botToken, authDate: now });

    expect(new URLSearchParams(raw).get("hash")).toBe(
      "ef9d253ad037503b40c89d241352a9f82a601ace89e7704e4d97c6f284c2edba",
    );
  });

  it("verifies HMAC, auth_date and selected profile fields regardless of query order", async () => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now - 300,
      user: { ...defaultWebAppUser, is_premium: true, language_code: "en" },
      extra: { start_param: "retro &= + unicode Конь" },
    });

    await expect(verifyMiniAppInitData(reordered(raw), options)).resolves.toEqual({
      telegramUserId: "987654321",
      displayName: "Ada Lovelace",
      username: "ada",
      avatarUrl: "https://cdn.example/avatar.jpg",
    });
  });

  it("includes the modern signature and unknown signed fields in bot-token HMAC input", async () => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now,
      extra: { signature: "third-party-signature", future_field: "signed-value" },
    });
    await expect(verifyMiniAppInitData(raw, options)).resolves.toMatchObject({
      telegramUserId: "987654321",
    });

    const params = new URLSearchParams(raw);
    params.set("signature", "tampered-third-party-signature");
    await expectProofCode(
      verifyMiniAppInitData(params.toString(), options),
      "TELEGRAM_PROOF_INVALID",
    );
  });

  it.each([
    { id: 987654321, first_name: "Ada" },
    { id: 987654321, first_name: "Ada", last_name: "" },
    { id: 987654321, first_name: "Ada", last_name: "", username: "", photo_url: "" },
  ])("normalizes absent or empty optional Telegram profile fields", async (user) => {
    const raw = await signedMiniAppData({ botToken, authDate: now, user });

    await expect(verifyMiniAppInitData(raw, options)).resolves.toEqual({
      telegramUserId: "987654321",
      displayName: "Ada",
      username: null,
      avatarUrl: null,
    });
  });

  it("still authenticates empty optional fields as part of the original signed user", async () => {
    const raw = await signedMiniAppData({ botToken, authDate: now });
    const params = new URLSearchParams(raw);
    params.set("user", JSON.stringify({ ...defaultWebAppUser, last_name: "" }));

    await expectProofCode(
      verifyMiniAppInitData(params.toString(), options),
      "TELEGRAM_PROOF_INVALID",
    );
  });

  it.each([
    { first_name: "" },
    { last_name: null },
    { last_name: 123 },
    { username: null },
    { username: false },
    { photo_url: null },
    { photo_url: 123 },
  ])("rejects missing required names and invalid optional field types", async (overrides) => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now,
      user: { ...defaultWebAppUser, ...overrides },
    });

    await expectProofCode(verifyMiniAppInitData(raw, options), "TELEGRAM_PROOF_INVALID", "profile");
  });

  const invalidRawCases: RawCase[] = [
    [
      "valid-length wrong MAC",
      async () => withHash(await signedMiniAppData({ botToken, authDate: now }), "0".repeat(64)),
    ],
    ["bad hash length", async () => `auth_date=${now}&user=%7B%7D&hash=aa`],
    [
      "duplicate auth_date",
      async () => `${await signedMiniAppData({ botToken, authDate: now })}&auth_date=${now}`,
    ],
    [
      "encoded duplicate auth_date",
      async () => `${await signedMiniAppData({ botToken, authDate: now })}&%61uth_date=${now}`,
    ],
    [
      "duplicate user",
      async () => `${await signedMiniAppData({ botToken, authDate: now })}&user=%7B%7D`,
    ],
    [
      "encoded duplicate hash",
      async () => {
        const raw = await signedMiniAppData({ botToken, authDate: now });
        return `${raw}&%68ash=${new URLSearchParams(raw).get("hash") ?? ""}`;
      },
    ],
    [
      "malformed percent encoding",
      async () => `${await signedMiniAppData({ botToken, authDate: now })}&broken=%ZZ`,
    ],
    [
      "non-decimal auth_date",
      async () => signedMiniAppData({ botToken, authDate: now, extra: { auth_date: "1e3" } }),
    ],
    [
      "oversize auth_date",
      async () =>
        signedMiniAppData({ botToken, authDate: now, extra: { auth_date: "9".repeat(32) } }),
    ],
    [
      "missing user id",
      async () => signedMiniAppData({ botToken, authDate: now, user: { first_name: "Ada" } }),
    ],
    [
      "missing first name",
      async () => signedMiniAppData({ botToken, authDate: now, user: { id: 987654321 } }),
    ],
    [
      "malformed user JSON",
      async () => signedMiniAppData({ botToken, authDate: now, extra: { user: "{" } }),
    ],
  ];

  it.each(invalidRawCases)("rejects %s", async (_name, makeRaw) => {
    await expectProofCode(
      verifyMiniAppInitData(await makeRaw(), options),
      "TELEGRAM_PROOF_INVALID",
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["string", "987654321"],
  ] as const)("rejects a %s Telegram user id", async (_name, id) => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now,
      user: { ...defaultWebAppUser, id },
    });
    await expectProofCode(verifyMiniAppInitData(raw, options), "TELEGRAM_PROOF_INVALID");
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "ftp://example.test/a",
    "not-a-url",
    " ",
  ])("rejects a non-HTTP profile URL: %s", async (photoUrl) => {
    const raw = await signedMiniAppData({
      botToken,
      authDate: now,
      user: { ...defaultWebAppUser, photo_url: photoUrl },
    });
    await expectProofCode(verifyMiniAppInitData(raw, options), "TELEGRAM_PROOF_INVALID");
  });

  it("accepts exact age and future-skew boundaries and rejects one second beyond them", async () => {
    const ageBoundary = await signedMiniAppData({ botToken, authDate: now - 3600 });
    const futureBoundary = await signedMiniAppData({ botToken, authDate: now + 30 });
    const expired = await signedMiniAppData({ botToken, authDate: now - 3601 });
    const future = await signedMiniAppData({ botToken, authDate: now + 31 });

    await expect(verifyMiniAppInitData(ageBoundary, options)).resolves.toBeDefined();
    await expect(verifyMiniAppInitData(futureBoundary, options)).resolves.toBeDefined();
    await expectProofCode(
      verifyMiniAppInitData(expired, options),
      "TELEGRAM_PROOF_EXPIRED",
      "expired",
    );
    await expectProofCode(
      verifyMiniAppInitData(future, options),
      "TELEGRAM_PROOF_INVALID",
      "future",
    );

    await expectProofCode(
      verifyMiniAppInitData(withHash(expired, "f".repeat(64)), options),
      "TELEGRAM_PROOF_INVALID",
      "signature",
    );
  });

  const invalidOptionCases: Array<readonly [string, InvalidOptionOverride]> = [
    ["empty token", { botToken: "" }],
    ["missing token", { botToken: undefined }],
    ["NaN now", { nowSeconds: Number.NaN }],
    ["infinite now", { nowSeconds: Number.POSITIVE_INFINITY }],
    ["fractional now", { nowSeconds: now + 0.5 }],
    ["clock sum overflow", { nowSeconds: Number.MAX_SAFE_INTEGER }],
    ["zero max age", { maxAgeSeconds: 0 }],
    ["negative max age", { maxAgeSeconds: -1 }],
    ["NaN max age", { maxAgeSeconds: Number.NaN }],
    ["infinite max age", { maxAgeSeconds: Number.POSITIVE_INFINITY }],
    ["negative skew", { futureSkewSeconds: -1 }],
    ["NaN skew", { futureSkewSeconds: Number.NaN }],
    ["infinite skew", { futureSkewSeconds: Number.POSITIVE_INFINITY }],
  ];

  it.each(invalidOptionCases)(
    "fails closed for invalid verifier options: %s",
    async (_name, override) => {
      const forged = await signedMiniAppData({
        botToken: typeof override.botToken === "string" ? override.botToken : botToken,
        authDate: now,
      });
      await expectProofCode(
        verifyMiniAppInitData(forged, { ...options, ...override } as typeof options),
        "TELEGRAM_PROOF_INVALID",
        "configuration",
      );
    },
  );

  it("rejects oversized raw data and exposes no proof or secret material in errors", async () => {
    const raw = `${await signedMiniAppData({ botToken, authDate: now })}&padding=${"x".repeat(8192)}`;

    try {
      await verifyMiniAppInitData(raw, options);
      throw new Error("Expected Telegram proof rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramProofError);
      const serialized = `${String(error)} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(botToken);
      expect(serialized).not.toContain(raw);
      expect(serialized).not.toContain("987654321");
      expect(serialized).toBe(
        'TelegramProofError: TELEGRAM_PROOF_INVALID {"code":"TELEGRAM_PROOF_INVALID","stage":"input","name":"TelegramProofError"}',
      );
    }
  });
});

describe("auth crypto primitives", () => {
  it("keeps base64url and exact hex decoding deterministic", () => {
    expect(bytesToBase64Url(Uint8Array.of(251, 255, 239))).toBe("-__v");
    expect(hexToBytes("AA".repeat(32))).toEqual(Uint8Array.from({ length: 32 }, () => 0xaa));
    expect(hexToBytes("a".repeat(63))).toBeNull();
    expect(hexToBytes("g".repeat(64))).toBeNull();
  });

  it("keeps the session vector while separating every opaque-token purpose", async () => {
    const pepper = "test-session-pepper-at-least-32-bytes";
    await expect(hashSessionToken("token", pepper)).resolves.toBe(
      "09b878d09b6d9b75b27dcaf5a8230d7985fe102b4b9d505fa68faff475a1591c",
    );
    await expect(hashOpaqueToken("token", pepper, "oidc-state")).resolves.toBe(
      "2f9fb330d18df7026ccad45c46db84c711dd8dfce86f9d74c85767b9fa994401",
    );
    await expect(hashOpaqueToken("token", pepper, "oidc-handoff")).resolves.toBe(
      "81f0b8ae12277fe317f2acf2d4feca41564f5a50dc5dd3f02a525c8ef34ee7f9",
    );
  });
});
