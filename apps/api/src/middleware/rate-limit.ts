import { ApiError } from "../http/api-error";

const encoder = new TextEncoder();

export interface Limiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export async function enforceLimit(limiter: Limiter, key: string): Promise<void> {
  const result = await limiter.limit({ key });
  if (result.success !== true) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
  }
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  if (octets.length !== 4) return null;
  return octets as [number, number, number, number];
}

function parseIpv6(value: string): number[] | null {
  if (value.includes("%") || value.includes("[")) return null;
  let source = value.toLowerCase();
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = parseIpv4(source.slice(separator + 1));
    if (!ipv4) return null;
    source = `${source.slice(0, separator)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${(
      (ipv4[2] << 8) | ipv4[3]
    ).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  let expanded: string[];
  if (halves.length === 2) {
    const missing = 8 - groups.length;
    if (missing < 1) return null;
    expanded = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  } else {
    if (groups.length !== 8) return null;
    expanded = groups;
  }
  return expanded.map((group) => Number.parseInt(group, 16));
}

function coarseClientIp(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "unknown";
  const ipv4 = parseIpv4(candidate);
  if (ipv4) return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;

  const ipv6 = parseIpv6(candidate);
  if (!ipv6) return "unknown";
  const ipv4Mapped = ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff;
  if (ipv4Mapped) {
    const high = ipv6[6] ?? 0;
    const low = ipv6[7] ?? 0;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.0/24`;
  }
  return `${ipv6
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

export async function guestLimitKey(
  cfConnectingIp: string | undefined,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`rate-limit-ip\0${coarseClientIp(cfConnectingIp)}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `guest:${hex}`;
}
