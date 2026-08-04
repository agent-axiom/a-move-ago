import { bytesToBase64Url, utf8 } from "./encoding";
import { newOpaqueToken } from "./opaque-token";

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function newPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = newOpaqueToken();
  return { verifier, challenge: await pkceChallenge(verifier) };
}
