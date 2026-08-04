import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  random(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

function retryable(error: unknown): boolean {
  return (
    error instanceof ApiTransportError ||
    (error instanceof ApiError && (error.status === 429 || error.status >= 500))
  );
}

export async function retryGet<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempt = 0;
  while (true) {
    options.signal?.throwIfAborted();
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (!retryable(error) || attempt >= options.maxAttempts) throw error;
      const rawServerDelay =
        error instanceof ApiError && error.retryAfterSeconds !== null
          ? error.retryAfterSeconds * 1_000
          : null;
      const serverDelay =
        rawServerDelay === null ? null : Math.min(Math.max(0, rawServerDelay), MAX_TIMER_DELAY_MS);
      const exponential = options.baseDelayMs * 2 ** (attempt - 1);
      const jittered = Math.round(exponential * (0.5 + options.random()));
      await options.sleep(serverDelay ?? jittered, options.signal);
      options.signal?.throwIfAborted();
    }
  }
}
