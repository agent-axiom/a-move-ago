import type { AppRuntime } from "../../app/runtime";
import { clearGamePersistence } from "../game/model/persistence";
import type { Me } from "./session-state";

const actorGenerations = new WeakMap<AppRuntime, number>();

function nextGeneration(runtime: AppRuntime): number {
  const generation = (actorGenerations.get(runtime) ?? 0) + 1;
  actorGenerations.set(runtime, generation);
  return generation;
}

export function discardGamePersistence(runtime: AppRuntime): void {
  nextGeneration(runtime);
  runtime.setDraftActorKey?.(null);
  clearGamePersistence();
}

/** Draft storage identifies an opaque session without persisting its bearer token. */
export async function prepareDraftActor<T extends Me>(runtime: AppRuntime, me: T): Promise<T> {
  if (!runtime.setDraftActorKey) return me;
  const generation = nextGeneration(runtime);
  const token = runtime.token.get();
  runtime.setDraftActorKey(null);
  if (!token) return me;
  try {
    const owner = me.kind === "telegram" ? `telegram:${me.profile.telegramUserId}` : "guest";
    const bytes = new TextEncoder().encode(`a-move-ago:draft:v1:${owner}:${token}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (runtime.token.get() === token && actorGenerations.get(runtime) === generation) {
      runtime.setDraftActorKey(key);
    }
  } catch {
    // An unavailable crypto or storage capability must not prevent gameplay.
  }
  return me;
}
