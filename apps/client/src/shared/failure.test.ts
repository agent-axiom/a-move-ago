import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { expect, it } from "vitest";
import { classifyFailure } from "./failure";

it("classifies transport, auth, rate, content and server failures", () => {
  expect(classifyFailure(new ApiTransportError("offline"))).toEqual({ kind: "offline" });
  expect(classifyFailure(new ApiError(401, "INVALID_SESSION", "Expired.", "r1", null))).toEqual({
    kind: "auth",
    requestId: "r1",
  });
  expect(classifyFailure(new ApiError(429, "RATE_LIMITED", "Wait.", "r2", 8))).toEqual({
    kind: "rate-limit",
    requestId: "r2",
    retryAfterSeconds: 8,
  });
  expect(classifyFailure(new ApiError(404, "DAILY_NOT_FOUND", "Missing.", "r3", null))).toEqual({
    kind: "content",
    requestId: "r3",
  });
  expect(classifyFailure(new ApiError(503, "UNAVAILABLE", "Down.", "r4", null))).toEqual({
    kind: "server",
    requestId: "r4",
  });
  expect(classifyFailure(new ApiContractError("invalid"))).toEqual({ kind: "contract" });
});
