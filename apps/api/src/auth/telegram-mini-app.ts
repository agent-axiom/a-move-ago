import { z } from "zod";
import { hexToBytes, utf8 } from "../crypto/encoding";
import type { VerifiedTelegramIdentity } from "./types";

const WebAppUserSchema = z
  .object({
    id: z.number().int().safe().positive(),
    first_name: z.string().min(1),
    last_name: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    photo_url: z.httpUrl().optional(),
  })
  .passthrough();

type WorkerdSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBufferView<ArrayBuffer>, right: ArrayBufferView<ArrayBuffer>): boolean;
};

export class TelegramProofError extends Error {
  constructor(readonly code: "TELEGRAM_PROOF_INVALID" | "TELEGRAM_PROOF_EXPIRED") {
    super(code);
    this.name = "TelegramProofError";
  }
}

async function hmac(
  keyBytes: Uint8Array<ArrayBuffer>,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(value)));
}

function invalid(): TelegramProofError {
  return new TelegramProofError("TELEGRAM_PROOF_INVALID");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = value.indexOf("%"); index !== -1; index = value.indexOf("%", index + 3)) {
    if (!/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) return true;
  }
  return false;
}

export async function verifyMiniAppInitData(
  raw: string,
  options: {
    botToken: string;
    nowSeconds: number;
    maxAgeSeconds: number;
    futureSkewSeconds: number;
  },
): Promise<VerifiedTelegramIdentity> {
  if (
    typeof options.botToken !== "string" ||
    options.botToken.trim().length === 0 ||
    !isNonNegativeSafeInteger(options.nowSeconds) ||
    !Number.isSafeInteger(options.maxAgeSeconds) ||
    options.maxAgeSeconds <= 0 ||
    !isNonNegativeSafeInteger(options.futureSkewSeconds) ||
    !Number.isSafeInteger(options.nowSeconds + options.futureSkewSeconds)
  ) {
    throw invalid();
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 8192 ||
    utf8.encode(raw).byteLength > 8192 ||
    hasMalformedPercentEncoding(raw)
  ) {
    throw invalid();
  }

  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size) throw invalid();

  const received = hexToBytes(params.get("hash") ?? "");
  const rawAuthDate = params.get("auth_date");
  const authDate = Number(rawAuthDate);
  const rawUser = params.get("user");
  if (
    !received ||
    !rawAuthDate ||
    !/^\d+$/.test(rawAuthDate) ||
    !Number.isSafeInteger(authDate) ||
    authDate <= 0 ||
    !rawUser
  ) {
    throw invalid();
  }

  const checkString = keys
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${params.get(key) ?? ""}`)
    .join("\n");
  const secret = await hmac(utf8.encode("WebAppData"), options.botToken);
  const expected = await hmac(secret, checkString);
  if (
    received.byteLength !== expected.byteLength ||
    !(crypto.subtle as WorkerdSubtleCrypto).timingSafeEqual(received, expected)
  ) {
    throw invalid();
  }
  if (authDate > options.nowSeconds + options.futureSkewSeconds) throw invalid();
  if (options.nowSeconds - authDate > options.maxAgeSeconds) {
    throw new TelegramProofError("TELEGRAM_PROOF_EXPIRED");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawUser);
  } catch {
    throw invalid();
  }
  const parsed = WebAppUserSchema.safeParse(decoded);
  if (!parsed.success) throw invalid();

  return {
    telegramUserId: String(parsed.data.id),
    displayName: [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" "),
    username: parsed.data.username ?? null,
    avatarUrl: parsed.data.photo_url ?? null,
  };
}
