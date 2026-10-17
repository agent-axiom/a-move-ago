import type { z } from "zod";
import {
  ArchiveResponseSchema,
  AttemptRequestSchema,
  AttemptResultSchema,
  ClueResponseSchema,
  DailyCaseResponseSchema,
  ErrorEnvelopeSchema,
  GuestMeResponseSchema,
  GuestSessionRequestSchema,
  HandoffExchangeRequestSchema,
  HintRequestSchema,
  HintResponseSchema,
  MeResponseSchema,
  OidcStartRequestSchema,
  OidcStartResponseSchema,
  PuzzleRevealResponseSchema,
  SessionIssuedSchema,
  StatsResponseSchema,
  TelegramMiniAppAuthRequestSchema,
  TelegramSessionIssuedSchema,
} from "./api";

type AttemptRequest = z.infer<typeof AttemptRequestSchema>;
type ClientChannel = z.infer<typeof GuestSessionRequestSchema>["channel"];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiTransportError extends Error {
  constructor(override readonly cause: unknown) {
    super("The API could not be reached.");
    this.name = "ApiTransportError";
  }
}

export class ApiContractError extends Error {
  constructor(override readonly cause: unknown) {
    super("The API returned an invalid response.");
    this.name = "ApiContractError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getToken: () => string | null;
  includeLocalizations?: boolean;
  includeGameProgress?: boolean;
}

function throwTransportFailure(error: unknown): never {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  throw new ApiTransportError(error);
}

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function request<TSchema extends z.ZodType>(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    responseSchema: TSchema;
    body?: unknown;
    authenticated?: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<z.infer<TSchema>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.includeLocalizations === true) headers["x-content-locales"] = "1";
    if (options.includeGameProgress === true) headers["x-game-progress"] = "1";
    if (input.body !== undefined) headers["content-type"] = "application/json";
    if (input.authenticated !== false) {
      const token = options.getToken();
      if (!token) {
        throw new ApiError(401, "MISSING_SESSION", "No app session is available.", "client", null);
      }
      headers.authorization = `Bearer ${token}`;
    }

    const init: RequestInit = {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}${input.path}`, init);
    } catch (error) {
      throwTransportFailure(error);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) payload = null;
      else throwTransportFailure(error);
    }
    if (!response.ok) {
      const envelope = ErrorEnvelopeSchema.safeParse(payload);
      if (!envelope.success) throw new ApiContractError(envelope.error);
      const retryAfter = response.headers.get("retry-after");
      throw new ApiError(
        response.status,
        envelope.data.error.code,
        envelope.data.error.message,
        envelope.data.error.requestId,
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null,
      );
    }

    const parsed = input.responseSchema.safeParse(payload);
    if (!parsed.success) throw new ApiContractError(parsed.error);
    return parsed.data;
  }

  return {
    createGuest(channel: ClientChannel, signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/sessions/guest",
        body: GuestSessionRequestSchema.parse({ channel }),
        responseSchema: SessionIssuedSchema,
        authenticated: false,
        signal,
      });
    },
    getMe(signal?: AbortSignal) {
      return request({ method: "GET", path: "/v1/me", responseSchema: MeResponseSchema, signal });
    },
    deleteProfile(signal?: AbortSignal) {
      return request({
        method: "DELETE",
        path: "/v1/me",
        responseSchema: GuestMeResponseSchema,
        signal,
      });
    },
    getDaily(date?: string, signal?: AbortSignal) {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      return request({
        method: "GET",
        path: `/v1/daily${query}`,
        responseSchema: DailyCaseResponseSchema,
        signal,
      });
    },
    getArchive(signal?: AbortSignal) {
      return request({
        method: "GET",
        path: "/v1/archive",
        responseSchema: ArchiveResponseSchema,
        signal,
      });
    },
    requestClue(caseId: string, puzzleId: string, signal?: AbortSignal) {
      return request({
        method: "POST",
        path: `/v1/cases/${encodeURIComponent(caseId)}/puzzles/${encodeURIComponent(puzzleId)}/clue`,
        body: {},
        responseSchema: ClueResponseSchema,
        signal,
      });
    },
    getPuzzleReveal(caseId: string, puzzleId: string, signal?: AbortSignal) {
      return request({
        method: "GET",
        path: `/v1/cases/${encodeURIComponent(caseId)}/puzzles/${encodeURIComponent(puzzleId)}/reveal`,
        responseSchema: PuzzleRevealResponseSchema,
        signal,
      });
    },
    submitAttempt(body: AttemptRequest, signal?: AbortSignal) {
      const parsed = AttemptRequestSchema.parse(body);
      return request({
        method: "POST",
        path: "/v1/attempts",
        body: parsed,
        responseSchema: AttemptResultSchema,
        signal,
      }).then((result) => {
        if (result.attemptUuid !== parsed.attemptUuid) {
          throw new ApiContractError("Attempt response UUID did not match the request.");
        }
        return result;
      });
    },
    requestHint(attemptId: string, level: number, signal?: AbortSignal) {
      const parsed = HintRequestSchema.parse({ level });
      return request({
        method: "POST",
        path: `/v1/attempts/${encodeURIComponent(attemptId)}/hints`,
        body: parsed,
        responseSchema: HintResponseSchema,
        signal,
      }).then((result) => {
        if (result.level !== parsed.level) {
          throw new ApiContractError("Hint response level did not match the request.");
        }
        return result;
      });
    },
    getStats(signal?: AbortSignal) {
      return request({
        method: "GET",
        path: "/v1/me/stats",
        responseSchema: StatsResponseSchema,
        signal,
      });
    },
    loginMiniApp(initData: string, signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/auth/telegram/mini-app",
        body: TelegramMiniAppAuthRequestSchema.parse({ initData }),
        responseSchema: TelegramSessionIssuedSchema,
        signal,
      });
    },
    startOidc(channel: "web" | "android", signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/auth/telegram/oidc/start",
        body: OidcStartRequestSchema.parse({ channel }),
        responseSchema: OidcStartResponseSchema,
        signal,
      });
    },
    exchangeHandoff(handoffCode: string, signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/auth/session/exchange",
        body: HandoffExchangeRequestSchema.parse({ handoffCode }),
        responseSchema: TelegramSessionIssuedSchema,
        signal,
      });
    },
    logout(signal?: AbortSignal) {
      return request({
        method: "POST",
        path: "/v1/auth/logout",
        responseSchema: SessionIssuedSchema,
        signal,
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
