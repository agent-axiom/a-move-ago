import { ApiError, ApiTransportError, type MeResponseSchema } from "@a-move-ago/api-contract";
import type { z } from "zod";
import { parseEntryQuery, stripAuthReturn } from "../../app/entry-query";
import type { AppRuntime } from "../../app/runtime";

type Me = z.infer<typeof MeResponseSchema>;

export interface PendingHandoff {
  handoffCode: string;
}

export class RetryableHandoffError extends Error {
  constructor(
    readonly pending: PendingHandoff,
    override readonly cause: unknown,
  ) {
    super("Telegram sign-in could not be exchanged. Retry when the connection recovers.");
    this.name = "RetryableHandoffError";
  }
}

export class TelegramAuthDeniedError extends Error {
  constructor(readonly me: Me) {
    super("Telegram sign-in was cancelled. Guest progress is still available.");
    this.name = "TelegramAuthDeniedError";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

async function installServerToken(runtime: AppRuntime, token: string): Promise<void> {
  // The server may already have revoked the prior token. Keep the newly issued
  // credential authoritative for this running app even when persistence is unavailable.
  runtime.token.set(token);
  try {
    await runtime.platform.tokenStore.write(token);
  } catch {
    // A reload may require a new guest, but rolling back here would break this runtime now.
  }
}

async function issueGuest(runtime: AppRuntime, signal: AbortSignal): Promise<Me> {
  const issued = await runtime.api.createGuest(runtime.platform.channel, signal);
  await installServerToken(runtime, issued.token);
  return { kind: "guest", profile: null };
}

function retryableHandoffFailure(error: unknown): boolean {
  return (
    error instanceof ApiTransportError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500))
  );
}

function invalidSession(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401 && error.code === "INVALID_SESSION";
}

async function ensureHandoffSession(runtime: AppRuntime, signal: AbortSignal): Promise<void> {
  if (runtime.token.get()) return;
  const stored = await runtime.platform.tokenStore.read();
  throwIfAborted(signal);
  if (stored) {
    runtime.token.set(stored);
    return;
  }
  await issueGuest(runtime, signal);
}

export async function bootstrapSession(
  runtime: AppRuntime,
  sourceUrl: URL,
  replaceUrl: (relativeUrl: string) => void,
  signal = new AbortController().signal,
): Promise<Me> {
  const { handoff, authError } = parseEntryQuery(sourceUrl);
  if (sourceUrl.searchParams.has("handoff") || sourceUrl.searchParams.has("authError")) {
    replaceUrl(stripAuthReturn(sourceUrl));
  }

  let me: Me;
  try {
    const stored = await runtime.platform.tokenStore.read();
    throwIfAborted(signal);
    if (stored) {
      runtime.token.set(stored);
      try {
        me = await runtime.api.getMe(signal);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          throw error;
        }

        runtime.token.set(null);
        try {
          await runtime.platform.tokenStore.clear();
        } catch {
          // The invalid credential will be overwritten when the fresh guest is persisted.
        }
        me = await issueGuest(runtime, signal);
      }
    } else {
      me = await issueGuest(runtime, signal);
    }
  } catch (error) {
    if (handoff && retryableHandoffFailure(error)) {
      throw new RetryableHandoffError({ handoffCode: handoff }, error);
    }
    throw error;
  }
  if (me.kind === "telegram") return me;
  if (authError) throw new TelegramAuthDeniedError(me);
  return handoff ? retryHandoff(runtime, { handoffCode: handoff }, signal) : me;
}

export async function retryHandoff(
  runtime: AppRuntime,
  pending: PendingHandoff,
  signal = new AbortController().signal,
): Promise<Me> {
  try {
    await ensureHandoffSession(runtime, signal);
    const issued = await runtime.api.exchangeHandoff(pending.handoffCode, signal);
    await installServerToken(runtime, issued.token);
    return { kind: "telegram", profile: issued.profile };
  } catch (error) {
    if (retryableHandoffFailure(error)) {
      throw new RetryableHandoffError(pending, error);
    }
    if (invalidSession(error)) {
      await issueGuest(runtime, signal);
    }
    throw error;
  }
}

function telegramAuthorizationUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API returned an unexpected Telegram authorization URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "oauth.telegram.org" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/auth" ||
    url.hash !== ""
  ) {
    throw new Error("API returned an unexpected Telegram authorization URL.");
  }
  return url;
}

export async function saveProgress(
  runtime: AppRuntime,
  signal = new AbortController().signal,
): Promise<Me | null> {
  if (runtime.platform.authMode === "mini-app") {
    const proof = await runtime.platform.requestTelegramProof({
      reason: "save-progress",
      userInitiatedAt: runtime.now(),
    });
    throwIfAborted(signal);
    if (!proof) throw new Error("Telegram did not provide Mini App initData.");
    const issued = await runtime.api.loginMiniApp(proof.initData, signal);
    await installServerToken(runtime, issued.token);
    return { kind: "telegram", profile: issued.profile };
  }

  const channel = runtime.platform.authMode === "oidc-android" ? "android" : "web";
  const started = await runtime.api.startOidc(channel, signal);
  throwIfAborted(signal);
  const authorizationUrl = telegramAuthorizationUrl(started.authorizationUrl);
  await runtime.platform.openAuthorization(authorizationUrl.toString());
  return null;
}
