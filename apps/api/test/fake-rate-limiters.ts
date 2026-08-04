import type { Env, RateLimitBinding } from "../src/env";

const permissiveLimiter: RateLimitBinding = {
  limit: async () => ({ success: true }),
};

export function withFakeRateLimiters(source: Env): Env {
  return Object.assign(Object.create(source) as Env, {
    GUEST_RATE_LIMITER: permissiveLimiter,
    ATTEMPT_RATE_LIMITER: permissiveLimiter,
    HINT_RATE_LIMITER: permissiveLimiter,
  });
}
