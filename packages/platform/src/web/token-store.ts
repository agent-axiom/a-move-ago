import type { TokenStore } from "../types";

export const SESSION_TOKEN_KEY = "amoveago.session.v1";

export function createWebTokenStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): TokenStore {
  return {
    async read() {
      return storage.getItem(SESSION_TOKEN_KEY);
    },
    async write(token) {
      storage.setItem(SESSION_TOKEN_KEY, token);
    },
    async clear() {
      storage.removeItem(SESSION_TOKEN_KEY);
    },
  };
}
