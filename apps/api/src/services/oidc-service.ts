import { type OidcStartResponse, OidcStartResponseSchema } from "@a-move-ago/api-contract";
import { type OidcChannel, resolveAuthReturnTarget } from "../auth/return-target";
import { OidcProviderError, type TelegramOidcProvider } from "../auth/telegram-oidc";
import { hashOpaqueToken, newOpaqueToken } from "../crypto/opaque-token";
import { newPkcePair } from "../crypto/pkce";
import { type AuthFlowChannel, claimAuthFlow, insertAuthFlow } from "../db/auth-flows";
import { completeOidcPlayerAndAuthFlow } from "../db/players";
import type { Env, SessionActor } from "../env";
import { ApiError } from "../http/api-error";
import { exchangeHandoffAndLinkGuest } from "./account-link-service";

const maxIsoDateSeconds = 253_402_300_799;
const telegramAuthorizationEndpoint = "https://oauth.telegram.org/auth";

function flowExpiry(env: Env, now: number): number {
  const ttl = Number(env.OIDC_FLOW_TTL_SECONDS);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("OIDC flow time must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("OIDC_FLOW_TTL_SECONDS must be a positive integer.");
  }
  const expiresAt = now + ttl;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > maxIsoDateSeconds) {
    throw new Error("OIDC_FLOW_TTL_SECONDS produces an unrepresentable expiry.");
  }
  return expiresAt;
}

function handoffExpiry(env: Env, now: number): number {
  const ttl = Number(env.HANDOFF_TTL_SECONDS);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("OIDC callback time must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new Error("HANDOFF_TTL_SECONDS must be a positive integer.");
  }
  const expiresAt = now + ttl;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > maxIsoDateSeconds) {
    throw new Error("HANDOFF_TTL_SECONDS produces an unrepresentable expiry.");
  }
  return expiresAt;
}

function oidcConfiguration(env: Env): { clientId: string; callbackUrl: string } {
  const clientId = env.TELEGRAM_OIDC_CLIENT_ID;
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    clientId.length > 256 ||
    clientId !== clientId.trim() ||
    /[^\x21-\x7e]/.test(clientId)
  ) {
    throw new Error("TELEGRAM_OIDC_CLIENT_ID is invalid.");
  }

  const callbackUrl = env.TELEGRAM_OIDC_CALLBACK_URL;
  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    throw new Error("TELEGRAM_OIDC_CALLBACK_URL is invalid.");
  }
  if (
    parsedCallback.protocol !== "https:" ||
    parsedCallback.username !== "" ||
    parsedCallback.password !== "" ||
    parsedCallback.search !== "" ||
    parsedCallback.hash !== "" ||
    parsedCallback.toString() !== callbackUrl
  ) {
    throw new Error("TELEGRAM_OIDC_CALLBACK_URL is invalid.");
  }
  return { clientId, callbackUrl };
}

function invalidSession(): ApiError {
  return new ApiError(401, "INVALID_SESSION", "The guest session is no longer active.");
}

export async function startOidcFlow(
  env: Env,
  guest: SessionActor,
  channel: AuthFlowChannel,
  now: number,
): Promise<OidcStartResponse> {
  if (
    guest.kind !== "guest" ||
    guest.playerId !== null ||
    guest.channel === "telegram" ||
    guest.channel !== channel
  ) {
    throw new ApiError(
      409,
      "AUTH_CHANNEL_MISMATCH",
      "OIDC channel does not match the guest session.",
    );
  }

  resolveAuthReturnTarget(env, channel);
  const expiresAt = flowExpiry(env, now);
  const { clientId, callbackUrl } = oidcConfiguration(env);
  const state = newOpaqueToken();
  const nonce = newOpaqueToken();
  const pkce = await newPkcePair();
  const authorizationUrl = new URL(telegramAuthorizationEndpoint);
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid profile",
    state,
    nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  }).toString();
  const response = OidcStartResponseSchema.parse({
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  });

  const inserted = await insertAuthFlow(env.DB, {
    id: crypto.randomUUID(),
    stateHash: await hashOpaqueToken(state, env.SESSION_PEPPER, "oidc-state"),
    guestSessionId: guest.sessionId,
    channel,
    nonce,
    pkceVerifier: pkce.verifier,
    now,
    expiresAt,
  });
  if (!inserted) throw invalidSession();
  return response;
}

export function fixedReturnUrl(
  env: Env,
  channel: OidcChannel,
  query: Record<string, string>,
): string {
  const url = resolveAuthReturnTarget(env, channel);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export async function completeOidcCallback(input: {
  env: Env;
  provider: TelegramOidcProvider;
  state: string;
  code: string;
  now: number;
}): Promise<string> {
  const expiresAt = handoffExpiry(input.env, input.now);
  resolveAuthReturnTarget(input.env, "web");
  resolveAuthReturnTarget(input.env, "android");
  const configuration = oidcConfiguration(input.env);
  const stateHash = await hashOpaqueToken(input.state, input.env.SESSION_PEPPER, "oidc-state");
  const flow = await claimAuthFlow(input.env.DB, stateHash, input.now);
  if (!flow) {
    throw new ApiError(400, "OIDC_STATE_INVALID", "OIDC state is invalid or expired.");
  }

  try {
    const identity = await input.provider.exchangeAndVerify({
      code: input.code,
      verifier: flow.pkce_verifier,
      expectedNonce: flow.nonce,
      clientId: configuration.clientId,
      clientSecret: input.env.TELEGRAM_OIDC_CLIENT_SECRET,
      redirectUri: configuration.callbackUrl,
    });
    if (!identity.oidc) {
      throw new ApiError(401, "OIDC_TOKEN_INVALID", "OIDC token is invalid.");
    }
    const handoffCode = newOpaqueToken();
    const handoffHash = await hashOpaqueToken(
      handoffCode,
      input.env.SESSION_PEPPER,
      "oidc-handoff",
    );
    await completeOidcPlayerAndAuthFlow(
      input.env.DB,
      { ...identity, oidc: identity.oidc },
      input.now,
      {
        flowId: flow.id,
        handoffHash,
        handoffExpiresAt: expiresAt,
      },
    );
    return fixedReturnUrl(input.env, flow.channel, { handoff: handoffCode });
  } catch (error) {
    if (error instanceof OidcProviderError) {
      throw new ApiError(
        error.code === "OIDC_PROVIDER_ERROR" ? 503 : 401,
        error.code,
        "Telegram login could not be verified.",
      );
    }
    throw error;
  }
}

export async function exchangeOidcHandoff(
  env: Env,
  guest: SessionActor,
  handoffCode: string,
  now: number,
) {
  if (guest.kind !== "guest" || guest.playerId !== null || guest.channel === "telegram") {
    throw new ApiError(409, "AUTH_REQUIRES_GUEST", "Exchange requires the original guest session.");
  }
  return await exchangeHandoffAndLinkGuest(
    env,
    guest,
    {
      handoffHash: await hashOpaqueToken(handoffCode, env.SESSION_PEPPER, "oidc-handoff"),
      channel: guest.channel,
    },
    now,
  );
}
