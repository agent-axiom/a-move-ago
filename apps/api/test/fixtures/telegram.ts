const encoder = new TextEncoder();

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
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export const defaultWebAppUser = {
  id: 987654321,
  first_name: "Ada",
  last_name: "Lovelace",
  username: "ada",
  photo_url: "https://cdn.example/avatar.jpg",
};

export async function signedMiniAppData(input: {
  botToken: string;
  authDate: number;
  user?: Record<string, unknown>;
  extra?: Record<string, string>;
}): Promise<string> {
  const fields = new URLSearchParams({
    auth_date: String(input.authDate),
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify(input.user ?? defaultWebAppUser),
    ...input.extra,
  });
  const checkString = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), input.botToken);
  const signature = await hmac(secret, checkString);
  fields.set("hash", Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  return fields.toString();
}
