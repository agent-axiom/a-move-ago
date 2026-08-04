import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";

export type ClientFailure =
  | { kind: "offline" }
  | { kind: "auth"; requestId: string }
  | { kind: "rate-limit"; requestId: string; retryAfterSeconds: number | null }
  | { kind: "content"; requestId: string }
  | { kind: "server"; requestId?: string }
  | { kind: "contract" };

export function classifyFailure(error: unknown): ClientFailure {
  if (error instanceof ApiTransportError) return { kind: "offline" };
  if (error instanceof ApiContractError) return { kind: "contract" };
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { kind: "auth", requestId: error.requestId };
    }
    if (error.status === 429) {
      return {
        kind: "rate-limit",
        requestId: error.requestId,
        retryAfterSeconds: error.retryAfterSeconds,
      };
    }
    if (error.code === "DAILY_NOT_FOUND") {
      return { kind: "content", requestId: error.requestId };
    }
    return { kind: "server", requestId: error.requestId };
  }
  return { kind: "server" };
}
