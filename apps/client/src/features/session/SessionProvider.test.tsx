import { ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
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

it("handles a fresh denial after a new explicit save attempt", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  let listener: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (next) => {
    listener = next;
    return () => undefined;
  });
  runtime.platform.authReturn.initialUrl = vi.fn(
    async () => `${window.location.origin}/?authError=access_denied`,
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
  expect(runtime.api.getMe).toHaveBeenCalledOnce();
  await user.click(save);
  await waitFor(() => expect(runtime.platform.openAuthorization).toHaveBeenCalledOnce());
  act(() => {
    listener?.(`/?authError=access_denied`);
  });
  await waitFor(() => expect(runtime.api.getMe).toHaveBeenCalledTimes(2));
});

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
