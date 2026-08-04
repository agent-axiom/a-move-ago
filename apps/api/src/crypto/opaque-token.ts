const encoder = new TextEncoder();

export function newOpaqueToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashOpaqueToken(
  token: string,
  pepper: string,
  purpose: "session" | "oidc-state" | "oidc-handoff",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\0${token}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashSessionToken(token: string, pepper: string): Promise<string> {
  return hashOpaqueToken(token, pepper, "session");
}
