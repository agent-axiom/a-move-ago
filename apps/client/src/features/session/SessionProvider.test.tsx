import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useLayoutEffect, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { SaveProgressButton } from "./SaveProgressButton";
import { SessionProvider, useSession } from "./SessionProvider";

const handoffCode = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const profile = {
  telegramUserId: "42",
  displayName: "Ada",
  username: null,
  avatarUrl: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function DoubleSaveButton() {
  const { state, save } = useSession();
  return (
    <button
      type="button"
      disabled={state.tag !== "ready"}
      onClick={() => {
        void save();
        void save();
      }}
    >
      Double save
    </button>
  );
}

function DoubleRetryButton() {
  const { state, retryHandoff } = useSession();
  return (
    <button
      type="button"
      disabled={state.tag !== "handoff-retry"}
      onClick={() => {
        void retryHandoff();
        void retryHandoff();
      }}
    >
      Double retry
    </button>
  );
}

function DeleteProbe({
  twice = false,
  onResult,
}: {
  twice?: boolean;
  onResult?(result: Promise<boolean>): void;
}) {
  const { state, deleteProfile } = useSession();
  return (
    <>
      <output data-testid="session-state">
        {state.tag}:{"me" in state ? state.me.kind : "none"}
      </output>
      <button
        type="button"
        onClick={() => {
          const result = deleteProfile();
          onResult?.(result);
          if (twice) {
            const duplicate = deleteProfile();
            onResult?.(duplicate);
          }
        }}
      >
        Delete through provider
      </button>
    </>
  );
}

function CaptureDeleteAction({ onCapture }: { onCapture(action: () => Promise<boolean>): void }) {
  const { state, deleteProfile } = useSession();
  useEffect(() => {
    if (state.tag === "ready" && state.me.kind === "telegram") {
      onCapture(deleteProfile);
    }
  }, [deleteProfile, onCapture, state]);
  return (
    <output data-testid="session-state">
      {state.tag}:{"me" in state ? state.me.kind : "none"}
    </output>
  );
}

function LayoutDeleteProbe({
  trigger,
  onResult,
}: {
  trigger: boolean;
  onResult(result: Promise<boolean>): void;
}) {
  const { state, deleteProfile } = useSession();
  const invokedRef = useRef(false);
  useLayoutEffect(() => {
    if (!trigger || invokedRef.current) return;
    invokedRef.current = true;
    onResult(deleteProfile());
  }, [deleteProfile, onResult, trigger]);
  return (
    <output data-testid="session-state">
      {state.tag}:{"me" in state ? state.me.kind : "none"}
    </output>
  );
}

function CatchingDeleteProbe({ onError }: { onError(error: unknown): void }) {
  const { state, deleteProfile } = useSession();
  return (
    <>
      <output data-testid="session-state">
        {state.tag}:{"me" in state ? state.me.kind : "none"}
      </output>
      <button
        type="button"
        onClick={() => {
          void deleteProfile().catch(onError);
        }}
      >
        Delete through provider
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("keeps profile deletion single-flight and applies only the confirmed guest result", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const deletion = deferred<{ kind: "guest"; profile: null }>();
  runtime.api.deleteProfile = vi.fn(() => deletion.promise);
  const results: Array<Promise<boolean>> = [];
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe twice onResult={(result) => results.push(result)} />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  await waitFor(() => expect(runtime.api.deleteProfile).toHaveBeenCalledOnce());
  expect(results).toHaveLength(2);
  await expect(results[1]).resolves.toBe(false);
  expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram");

  await act(async () => {
    deletion.resolve({ kind: "guest", profile: null });
    await expect(results[0]).resolves.toBe(true);
  });
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));
});

it("rejects a retained deletion action after the provider runtime changes", async () => {
  const first = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  first.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const second = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const captured: Array<() => Promise<boolean>> = [];
  const onCapture = (action: () => Promise<boolean>) => captured.push(action);
  const tree = (runtime: typeof first) => (
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <CaptureDeleteAction onCapture={onCapture} />
      </SessionProvider>
    </RuntimeProvider>
  );
  const view = render(tree(first));

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  await waitFor(() => expect(captured).not.toHaveLength(0));
  const retainedDelete = captured.at(-1);

  view.rerender(tree(second));
  await waitFor(() => expect(second.api.getMe).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));

  await expect(retainedDelete?.()).resolves.toBe(false);
  expect(first.api.deleteProfile).not.toHaveBeenCalled();
  expect(second.api.deleteProfile).not.toHaveBeenCalled();
  expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest");
});

it("rejects a new runtime deletion action before the replacement effect activates", async () => {
  const first = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  first.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const second = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const results: Array<Promise<boolean>> = [];
  let bootstrapCallsAtInvocation: number | undefined;
  const onResult = (result: Promise<boolean>) => {
    bootstrapCallsAtInvocation = vi.mocked(second.api.getMe).mock.calls.length;
    results.push(result);
  };
  const tree = (runtime: typeof first, trigger: boolean) => (
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <LayoutDeleteProbe trigger={trigger} onResult={onResult} />
      </SessionProvider>
    </RuntimeProvider>
  );
  const view = render(tree(first, false));

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  view.rerender(tree(second, true));

  expect(results).toHaveLength(1);
  expect(bootstrapCallsAtInvocation).toBe(0);
  await expect(results[0]).resolves.toBe(false);
  expect(first.api.deleteProfile).not.toHaveBeenCalled();
  expect(second.api.deleteProfile).not.toHaveBeenCalled();
  await waitFor(() => expect(second.api.getMe).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));
});

it("rejects a retained deletion action after the provider unmounts", async () => {
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const captured: Array<() => Promise<boolean>> = [];
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <CaptureDeleteAction onCapture={(action) => captured.push(action)} />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() => expect(captured).not.toHaveLength(0));
  const retainedDelete = captured.at(-1);
  view.unmount();

  await expect(retainedDelete?.()).resolves.toBe(false);
  expect(runtime.api.deleteProfile).not.toHaveBeenCalled();
});

it("keeps Telegram ready and rejects an unconfirmed profile deletion", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const failure = new ApiError(503, "UNAVAILABLE", "Try again.", "req-delete", null);
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(failure);
  const recordError = vi.fn();
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <CatchingDeleteProbe onError={recordError} />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));

  await waitFor(() => expect(recordError).toHaveBeenCalledWith(failure));
  expect(recordError.mock.calls[0]?.[0]).toBe(failure);
  expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram");
});

it("aborts an in-flight profile deletion when the provider unmounts", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  const deletion = deferred<{ kind: "guest"; profile: null }>();
  let deletionSignal: AbortSignal | undefined;
  runtime.api.deleteProfile = vi.fn((signal) => {
    deletionSignal = signal;
    return deletion.promise;
  });
  const results: Array<Promise<boolean>> = [];
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe onResult={(result) => results.push(result)} />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  await waitFor(() => expect(runtime.api.deleteProfile).toHaveBeenCalledOnce());
  view.unmount();
  expect(deletionSignal?.aborted).toBe(true);

  await act(async () => {
    deletion.resolve({ kind: "guest", profile: null });
    await expect(results[0]).resolves.toBe(false);
  });
});

it("accepts a fresh OIDC handoff after deletion returns the session to guest", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi
    .fn()
    .mockResolvedValueOnce({ kind: "telegram" as const, profile })
    .mockResolvedValueOnce({ kind: "guest" as const, profile: null });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DeleteProbe />
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
  await user.click(screen.getByRole("button", { name: "Delete through provider" }));
  await waitFor(() => expect(screen.getByTestId("session-state")).toHaveTextContent("ready:guest"));
  await user.click(screen.getByRole("button", { name: "Save progress with Telegram" }));
  await waitFor(() => expect(runtime.platform.openAuthorization).toHaveBeenCalledOnce());

  act(() => {
    listener?.(`/?handoff=${"B".repeat(43)}`);
  });
  await waitFor(() =>
    expect(runtime.api.exchangeHandoff).toHaveBeenCalledWith(
      "B".repeat(43),
      expect.any(AbortSignal),
    ),
  );
  await waitFor(() =>
    expect(screen.getByTestId("session-state")).toHaveTextContent("ready:telegram"),
  );
});

it("returns to guest-ready after opening OIDC without an immediate callback", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() =>
    expect(runtime.platform.openAuthorization).toHaveBeenCalledWith(
      "https://oauth.telegram.org/auth?response_type=code",
    ),
  );
  await waitFor(() => expect(save).toBeEnabled());
  expect(save).toHaveTextContent("Save progress with Telegram");
});

it("keeps rapid save actions single-flight", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const started = deferred<never>();
  runtime.api.startOidc = vi.fn(() => started.promise);
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DoubleSaveButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Double save" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() => expect(runtime.api.startOidc).toHaveBeenCalledOnce());
  view.unmount();
});

it("keeps rapid handoff retries single-flight", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.platform.authReturn.initialUrl = vi.fn(
    async () => `${window.location.origin}/?handoff=${handoffCode}`,
  );
  const retry = deferred<never>();
  runtime.api.exchangeHandoff = vi
    .fn()
    .mockRejectedValueOnce(new ApiTransportError(new TypeError("offline")))
    .mockImplementation(() => retry.promise);
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <DoubleRetryButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const button = screen.getByRole("button", { name: "Double retry" });
  await waitFor(() => expect(button).toBeEnabled());
  expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
  await user.click(button);
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledTimes(2));
  view.unmount();
});

it("deduplicates the same semantic handoff across URL representations", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  runtime.platform.authReturn.initialUrl = vi.fn(
    async () => `${window.location.origin}/?case=2026-08-03&handoff=${handoffCode}`,
  );
  runtime.api.getMe = vi.fn(async () => ({ kind: "guest" as const, profile: null }));

  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
  act(() => {
    listener?.(`/?handoff=${handoffCode}&case=2026-08-03`);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
});

it("ignores later distinct handoffs after one return authenticates", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  const firstExchange = deferred<{
    token: string;
    expiresAt: string;
    kind: "telegram";
    profile: typeof profile;
  }>();
  runtime.api.exchangeHandoff = vi
    .fn()
    .mockImplementationOnce(() => firstExchange.promise)
    .mockRejectedValue(
      new ApiError(409, "AUTH_REQUIRES_GUEST", "Guest required.", "req-late", null),
    );
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeEnabled(),
  );
  act(() => {
    listener?.(`/?handoff=${handoffCode}`);
    listener?.(`/?handoff=${"B".repeat(43)}`);
  });
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
  await act(async () => {
    firstExchange.resolve({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram",
      profile,
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save progress with Telegram" }),
  ).not.toBeInTheDocument();

  const lateHandoff = "C".repeat(43);
  act(() => {
    window.history.replaceState(null, "", `/?case=2026-08-03&handoff=${lateHandoff}#kept-fragment`);
    listener?.(window.location.href);
  });
  expect(window.location.search).toBe("?case=2026-08-03");
  expect(window.location.hash).toBe("#kept-fragment");
  expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce();
});

it("does not let an ambiguous denial burn a later valid handoff", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  runtime.platform.authReturn.initialUrl = vi.fn(
    async () => `${window.location.origin}/?handoff=${handoffCode}&authError=access_denied`,
  );
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("Telegram sign-in was cancelled");
  expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
  act(() => {
    listener?.(`/?handoff=${handoffCode}`);
  });
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
});

it("aborts an in-flight save action when the provider unmounts", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  const started = deferred<never>();
  let actionSignal: AbortSignal | undefined;
  runtime.api.startOidc = vi.fn((_channel, signal) => {
    actionSignal = signal;
    return started.promise;
  });
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() => expect(runtime.api.startOidc).toHaveBeenCalledOnce());
  view.unmount();
  expect(actionSignal?.aborted).toBe(true);
});

it("lets an auth return supersede an older foreground save", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  const start = deferred<{
    authorizationUrl: string;
    expiresAt: string;
  }>();
  let saveSignal: AbortSignal | undefined;
  runtime.api.startOidc = vi.fn((_channel, signal) => {
    saveSignal = signal;
    return start.promise;
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  await waitFor(() => expect(runtime.api.startOidc).toHaveBeenCalledOnce());
  act(() => {
    listener?.(`/?handoff=${handoffCode}`);
  });
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
  expect(saveSignal?.aborted).toBe(true);
  await act(async () => {
    start.resolve({
      authorizationUrl: "https://oauth.telegram.org/auth?response_type=code",
      expiresAt: "2026-08-03T12:10:00.000Z",
    });
    await Promise.resolve();
  });
  expect(runtime.platform.openAuthorization).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Save progress with Telegram" }),
  ).not.toBeInTheDocument();
});

it("does not let a newer save supersede an in-flight auth return", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  const exchange = deferred<{
    token: string;
    expiresAt: string;
    kind: "telegram";
    profile: typeof profile;
  }>();
  runtime.api.exchangeHandoff = vi.fn(() => exchange.promise);
  const start = deferred<{
    authorizationUrl: string;
    expiresAt: string;
  }>();
  runtime.api.startOidc = vi.fn(() => start.promise);
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  act(() => {
    listener?.(`/?handoff=${handoffCode}`);
  });
  await waitFor(() => expect(runtime.api.exchangeHandoff).toHaveBeenCalledOnce());
  await user.click(save);
  act(() => {
    exchange.resolve({
      token: "t".repeat(43),
      expiresAt: "2026-11-01T00:00:00.000Z",
      kind: "telegram",
      profile,
    });
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save progress with Telegram" }),
    ).not.toBeInTheDocument(),
  );
  await act(async () => {
    start.resolve({
      authorizationUrl: "https://oauth.telegram.org/auth?response_type=code",
      expiresAt: "2026-08-03T12:10:00.000Z",
    });
    await Promise.resolve();
  });

  expect(runtime.api.startOidc).not.toHaveBeenCalled();
  expect(runtime.platform.openAuthorization).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Save progress with Telegram" }),
  ).not.toBeInTheDocument();
});

it("does not overwrite an early auth return with a later initial bootstrap", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  const initialUrl = deferred<string | null>();
  runtime.platform.authReturn.initialUrl = vi.fn(() => initialUrl.promise);
  runtime.api.exchangeHandoff = vi
    .fn()
    .mockRejectedValue(new ApiTransportError(new TypeError("offline")));
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() => expect(runtime.platform.authReturn.initialUrl).toHaveBeenCalledOnce());
  act(() => {
    listener?.(`/?handoff=${handoffCode}`);
  });
  expect(await screen.findByRole("button", { name: "Retry Telegram return" })).toBeEnabled();

  await act(async () => {
    initialUrl.resolve(null);
    await Promise.resolve();
  });

  expect(runtime.api.getMe).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Retry Telegram return" })).toBeEnabled();
});

it.each([
  { authError: "access_denied", message: "Telegram sign-in was cancelled" },
  { authError: "login_failed", message: "Telegram sign-in did not finish." },
])(
  "handles fresh $authError returns only after explicit save attempts",
  async ({ authError, message }) => {
    const user = userEvent.setup();
    const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
    let listener: ((url: string) => void) | undefined;
    runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
      listener = next;
      return () => undefined;
    });
    const returnUrl = `/?case=2026-08-03&authError=${authError}`;
    runtime.platform.authReturn.initialUrl = vi.fn(
      async () => `${window.location.origin}${returnUrl}`,
    );
    render(
      <RuntimeProvider runtime={runtime}>
        <SessionProvider>
          <SaveProgressButton />
        </SessionProvider>
      </RuntimeProvider>,
    );

    const save = await screen.findByRole("button", { name: "Save progress with Telegram" });
    await waitFor(() => expect(save).toBeEnabled());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(window.location.search).toBe("?case=2026-08-03");
    expect(runtime.api.getMe).toHaveBeenCalledOnce();
    await act(async () => {
      listener?.(returnUrl);
      listener?.(returnUrl);
    });
    expect(runtime.api.getMe).toHaveBeenCalledOnce();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await user.click(save);
      await waitFor(() =>
        expect(runtime.platform.openAuthorization).toHaveBeenCalledTimes(attempt),
      );
      await act(async () => {
        listener?.(returnUrl);
        listener?.(returnUrl);
      });
      await waitFor(() => expect(runtime.api.getMe).toHaveBeenCalledTimes(attempt + 1));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(save).toBeEnabled();
      expect(window.location.search).toBe("?case=2026-08-03");
    }
    expect(runtime.token.get()).toBe("guest-token");
    expect(runtime.api.createGuest).not.toHaveBeenCalled();
    expect(runtime.api.exchangeHandoff).not.toHaveBeenCalled();
    expect(runtime.platform.tokenStore.write).not.toHaveBeenCalled();
    expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
  },
);

it("hides consent after restoring an authenticated Telegram session", async () => {
  const runtime = runtimeFixture({ storedToken: "telegram-token", platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => ({ kind: "telegram" as const, profile }));
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Save progress with Telegram" }),
    ).not.toBeInTheDocument(),
  );
});

it("renders an auth error and request id without losing the guest action", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.startOidc = vi
    .fn()
    .mockRejectedValue(new ApiError(503, "UNAVAILABLE", "Telegram is unavailable.", "req-9", null));
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>,
  );

  const save = screen.getByRole("button", { name: "Save progress with Telegram" });
  await waitFor(() => expect(save).toBeEnabled());
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Telegram is unavailable.");
  expect(screen.getByText("req-9")).toBeInTheDocument();
  expect(save).toBeEnabled();
});

it("blocks foreground auth while a replacement runtime bootstraps", async () => {
  const user = userEvent.setup();
  const first = runtimeFixture({ storedToken: "first-guest", platformKind: "web" });
  const second = runtimeFixture({ storedToken: "second-guest", platformKind: "web" });
  const secondMe = deferred<{ kind: "guest"; profile: null }>();
  second.api.getMe = vi.fn(() => secondMe.promise);
  const tree = (runtime: typeof first) => (
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>
  );
  const view = render(tree(first));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeEnabled(),
  );
  view.rerender(tree(second));
  await waitFor(() => expect(second.api.getMe).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Save progress with Telegram" }));

  expect(second.api.startOidc).not.toHaveBeenCalled();
  act(() => {
    secondMe.resolve({ kind: "guest", profile: null });
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeEnabled(),
  );
});

it("ignores callbacks retained by an obsolete runtime listener", async () => {
  const user = userEvent.setup();
  const first = runtimeFixture({ storedToken: "first-guest", platformKind: "web" });
  const second = runtimeFixture({ storedToken: "second-guest", platformKind: "web" });
  const listeners: Array<(url: string) => void> = [];
  for (const runtime of [first, second]) {
    runtime.platform.authReturn.subscribe = vi.fn(async (listener) => {
      listeners.push(listener);
      return () => undefined;
    });
  }
  const start = deferred<{ authorizationUrl: string; expiresAt: string }>();
  let actionSignal: AbortSignal | undefined;
  second.api.startOidc = vi.fn((_channel, signal) => {
    actionSignal = signal;
    return start.promise;
  });
  const tree = (runtime: typeof first) => (
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>
  );
  const view = render(tree(first));

  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeEnabled(),
  );
  view.rerender(tree(second));
  await waitFor(() => expect(listeners).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save progress with Telegram" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Save progress with Telegram" }));
  await waitFor(() => expect(second.api.startOidc).toHaveBeenCalledOnce());
  act(() => {
    listeners[0]?.(`/?handoff=${handoffCode}`);
  });

  expect(actionSignal?.aborted).toBe(false);
  await act(async () => {
    start.resolve({
      authorizationUrl: "https://oauth.telegram.org/auth?response_type=code",
      expiresAt: "2026-08-03T12:10:00.000Z",
    });
    await Promise.resolve();
  });
  expect(second.platform.openAuthorization).toHaveBeenCalledOnce();
  expect(second.api.exchangeHandoff).not.toHaveBeenCalled();
});

it("bootstraps again when the injected runtime is replaced", async () => {
  const first = runtimeFixture({ storedToken: "first-guest", platformKind: "web" });
  const second = runtimeFixture({ storedToken: "second-guest", platformKind: "web" });
  const tree = (runtime: typeof first) => (
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
      </SessionProvider>
    </RuntimeProvider>
  );
  const view = render(tree(first));

  await waitFor(() => expect(first.api.getMe).toHaveBeenCalledOnce());
  view.rerender(tree(second));
  await waitFor(() => expect(second.api.getMe).toHaveBeenCalledOnce());
});

it("does not duplicate bootstrap during the StrictMode effect replay", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  render(
    <StrictMode>
      <RuntimeProvider runtime={runtime}>
        <SessionProvider>
          <SaveProgressButton />
        </SessionProvider>
      </RuntimeProvider>
    </StrictMode>,
  );

  await waitFor(() => expect(runtime.api.getMe).toHaveBeenCalledOnce());
});
