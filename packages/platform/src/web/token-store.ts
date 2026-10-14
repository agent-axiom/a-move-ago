import type { TokenStore } from "../types";

export const SESSION_TOKEN_KEY = "amoveago.session.v1";

export function isStorageSecurityError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "SecurityError"
  );
}

export function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

export function createWebTokenStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): TokenStore {
  let currentToken: string | null = null;
  let storageAvailable = true;
  return {
    async read() {
      if (storageAvailable) {
        try {
          currentToken = storage.getItem(SESSION_TOKEN_KEY);
        } catch (error) {
          if (!isStorageSecurityError(error)) throw error;
          storageAvailable = false;
        }
      }
      return currentToken;
    },
    async write(token) {
      if (storageAvailable) {
        try {
          storage.setItem(SESSION_TOKEN_KEY, token);
        } catch (error) {
          if (!isStorageSecurityError(error)) throw error;
          storageAvailable = false;
        }
      }
      currentToken = token;
    },
    async clear() {
      if (storageAvailable) {
        try {
          storage.removeItem(SESSION_TOKEN_KEY);
        } catch (error) {
          if (!isStorageSecurityError(error)) throw error;
          storageAvailable = false;
        }
      }
      currentToken = null;
    },
  };
}
