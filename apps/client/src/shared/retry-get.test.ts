import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { expect, it, vi } from "vitest";
import { retryGet } from "./retry-get";

it("retries transport and server failures with bounded jitter", async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockRejectedValueOnce(new ApiError(503, "UNAVAILABLE", "Retry.", "req-1", null))
    .mockResolvedValue("daily");
  const sleep = vi.fn().mockResolvedValue(undefined);

  await expect(
    retryGet(operation, {
      maxAttempts: 3,
      baseDelayMs: 200,
      random: () => 0.5,
      sleep,
    }),
  ).resolves.toBe("daily");

  expect(operation).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenNthCalledWith(1, 200, undefined);
  expect(sleep).toHaveBeenNthCalledWith(2, 400, undefined);
});

it("uses Retry-After instead of client jitter", async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(429, "RATE_LIMITED", "Wait.", "req-2", 8))
    .mockResolvedValue("daily");
  const sleep = vi.fn().mockResolvedValue(undefined);
  const controller = new AbortController();

  await expect(
    retryGet(operation, {
      maxAttempts: 2,
      baseDelayMs: 200,
      random: () => 0,
      sleep,
      signal: controller.signal,
    }),
  ).resolves.toBe("daily");

  expect(sleep).toHaveBeenCalledOnce();
  expect(sleep).toHaveBeenCalledWith(8_000, controller.signal);
});

it("caps an unbounded Retry-After at the browser timer limit", async () => {
  const operation = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(429, "RATE_LIMITED", "Wait.", "req-long", Number.POSITIVE_INFINITY),
    )
    .mockResolvedValue("daily");
  const sleep = vi.fn().mockResolvedValue(undefined);

  await expect(
    retryGet(operation, {
      maxAttempts: 2,
      baseDelayMs: 200,
      random: () => 0,
      sleep,
    }),
  ).resolves.toBe("daily");

  expect(sleep).toHaveBeenCalledWith(2_147_483_647, undefined);
});

it("does not retry auth or content errors", async () => {
  const operation = vi
    .fn()
    .mockRejectedValue(new ApiError(404, "DAILY_NOT_FOUND", "Missing.", "req-3", null));
  await expect(
    retryGet(operation, {
      maxAttempts: 3,
      baseDelayMs: 200,
      random: () => 0.5,
      sleep: vi.fn(),
    }),
  ).rejects.toMatchObject({ code: "DAILY_NOT_FOUND" });
  expect(operation).toHaveBeenCalledOnce();
});

it("does not retry an aborted GET", async () => {
  const abort = new DOMException("Aborted", "AbortError");
  const operation = vi.fn().mockRejectedValue(abort);
  const sleep = vi.fn();

  await expect(
    retryGet(operation, {
      maxAttempts: 3,
      baseDelayMs: 200,
      random: () => 0.5,
      sleep,
    }),
  ).rejects.toBe(abort);
  expect(operation).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

it("does not start an operation when its signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const operation = vi.fn().mockResolvedValue("daily");
  const sleep = vi.fn();

  await expect(
    retryGet(operation, {
      maxAttempts: 3,
      baseDelayMs: 200,
      random: () => 0.5,
      sleep,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(operation).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});
