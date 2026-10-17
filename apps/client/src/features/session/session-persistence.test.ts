import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeFixture } from "../../test/runtime-fixture";
import { gamePersistenceKey, readGameDraft, writeGameDraft } from "../game/model/persistence";
import { discardGamePersistence, prepareDraftActor } from "./session-persistence";
import { bootstrapSession, deleteProfile, saveProgress } from "./session-service";

const guest = { kind: "guest", profile: null } as const;
const telegram = {
  kind: "telegram",
  profile: { telegramUserId: "42", displayName: "Ada", username: null, avatarUrl: null },
} as const;
const scope = (actorKey: string) => ({
  actorKey,
  caseId: "case",
  puzzleId: "puzzle",
  puzzleVersion: 1,
});

function fixture() {
  const runtime = runtimeFixture({ storedToken: "s".repeat(43), platformKind: "telegram" });
  let key: string | null = null;
  runtime.draftActorKey = () => key;
  runtime.setDraftActorKey = (next) => {
    key = next;
  };
  return runtime;
}

describe("session-scoped game drafts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores the same guest after restart without putting its bearer token in storage", async () => {
    const first = fixture();
    await bootstrapSession(first, new URL("https://game.test/"), vi.fn());
    const key = first.draftActorKey?.();
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    writeGameDraft(scope(key!), { tag: "select-previous", currentSquare: "e4" });
    const restarted = fixture();
    await bootstrapSession(restarted, new URL("https://game.test/"), vi.fn());
    expect(restarted.draftActorKey?.()).toBe(key);
    expect(readGameDraft(scope(key!))).toEqual({ tag: "select-previous", currentSquare: "e4" });
    expect(JSON.stringify(localStorage)).not.toContain(first.token.get());
  });

  it("clears the old actor on confirmed login and keeps language preferences", async () => {
    const runtime = fixture();
    await prepareDraftActor(runtime, guest);
    const oldKey = runtime.draftActorKey?.()!;
    writeGameDraft(scope(oldKey), { tag: "select-previous", currentSquare: "e4" });
    localStorage.setItem("a-move-ago.locale", "ru");
    vi.mocked(runtime.platform.requestTelegramProof).mockResolvedValue({
      kind: "telegram-mini-app",
      initData: "proof",
    });
    await saveProgress(runtime);
    expect(runtime.draftActorKey?.()).not.toBe(oldKey);
    expect(localStorage.getItem(gamePersistenceKey(scope(oldKey))!)).toBeNull();
    expect(localStorage.getItem("a-move-ago.locale")).toBe("ru");
  });

  it("preserves a draft on failed deletion and clears it only after confirmation", async () => {
    const runtime = fixture();
    await prepareDraftActor(runtime, telegram);
    const oldKey = runtime.draftActorKey?.()!;
    writeGameDraft(scope(oldKey), { tag: "select-previous", currentSquare: "e4" });
    vi.mocked(runtime.api.deleteProfile).mockRejectedValueOnce(new Error("offline"));
    await expect(deleteProfile(runtime)).rejects.toThrow("offline");
    expect(readGameDraft(scope(oldKey))).not.toBeNull();
    await deleteProfile(runtime);
    expect(readGameDraft(scope(oldKey))).toBeNull();
    expect(runtime.draftActorKey?.()).not.toBe(oldKey);
  });

  it("does not reinstall an old actor after an asynchronous ownership reset", async () => {
    const runtime = fixture();
    let finish!: (value: ArrayBuffer) => void;
    vi.stubGlobal("crypto", {
      subtle: {
        digest: () =>
          new Promise<ArrayBuffer>((resolve) => {
            finish = resolve;
          }),
      },
    });
    const pending = prepareDraftActor(runtime, telegram);
    discardGamePersistence(runtime);
    finish(new ArrayBuffer(32));
    await pending;
    expect(runtime.draftActorKey?.()).toBeNull();
  });

  it("keeps gameplay available when hashing is unavailable", async () => {
    const runtime = fixture();
    vi.stubGlobal("crypto", {});
    await expect(prepareDraftActor(runtime, guest)).resolves.toEqual(guest);
    expect(runtime.draftActorKey?.()).toBeNull();
  });
});
