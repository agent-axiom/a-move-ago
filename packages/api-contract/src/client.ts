import type { z } from "zod";
import {
  AttemptRequestSchema,
  AttemptResultSchema,
  DailyCaseResponseSchema,
  ErrorEnvelopeSchema,
  GuestSessionRequestSchema,
  HintRequestSchema,
  HintResponseSchema,
  MeResponseSchema,
  SessionIssuedSchema,
  StatsResponseSchema,
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
}

function throwTransportFailure(error: unknown): never {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  throw new ApiTransportError(error);
}

export function createApiClient(options: ApiClientOptions) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function request<TSchema extends z.ZodType>(input: {
    method: "GET" | "POST";
    path: string;
    responseSchema: TSchema;
    body?: unknown;
    authenticated?: boolean;
    signal?: AbortSignal | undefined;
  }): Promise<z.infer<TSchema>> {
    const headers: Record<string, string> = { accept: "application/json" };
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
    getDaily(date?: string, signal?: AbortSignal) {
      const query = date ? `?date=${encodeURIComponent(date)}` : "";
      return request({
        method: "GET",
        path: `/v1/daily${query}`,
        responseSchema: DailyCaseResponseSchema,
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
