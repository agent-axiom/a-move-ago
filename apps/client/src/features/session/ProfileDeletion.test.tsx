import { ApiContractError, ApiError, ApiTransportError } from "@a-move-ago/api-contract";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { runtimeFixture } from "../../test/runtime-fixture";
import { ProfileDeletion } from "./ProfileDeletion";
import { SaveProgressButton } from "./SaveProgressButton";
import { SessionProvider, useSession } from "./SessionProvider";

const telegramMe = {
  kind: "telegram" as const,
  profile: {
    telegramUserId: "42",
    displayName: "Ada",
    username: null,
    avatarUrl: null,
  },
};

const guestMe = { kind: "guest" as const, profile: null };

const deletionWarning =
  "This permanently deletes your A MOVE AGO Telegram profile and all saved attempts, hints, and statistics on every device. It does not delete your Telegram account. This cannot be undone.";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function renderDeletion(identity: "guest" | "telegram") {
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => (identity === "telegram" ? telegramMe : guestMe));
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <ProfileDeletion />
      </SessionProvider>
    </RuntimeProvider>,
  );
  return { runtime, view };
}

function ProviderProbe() {
  const { state } = useSession();
  const kind = "me" in state ? state.me.kind : state.tag;
  return <output aria-label="Session kind">{kind}</output>;
}

function ToggleDeletion() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>
        Hide deletion
      </button>
      {visible ? <ProfileDeletion /> : null}
      <ProviderProbe />
    </>
  );
}

afterEach(cleanup);

it("renders the destructive disclosure only for a ready Telegram session", async () => {
  const guest = renderDeletion("guest");
  await waitFor(() => expect(guest.runtime.api.getMe).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Delete Telegram profile" })).not.toBeInTheDocument();

  guest.view.unmount();
  const telegram = renderDeletion("telegram");
  const opener = await screen.findByRole("button", { name: "Delete Telegram profile" });

  expect(telegram.runtime.api.getMe).toHaveBeenCalledOnce();
  expect(opener).toHaveAttribute("aria-expanded", "false");
});

it("opens a named inline confirmation and Cancel returns focus without a request", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  const opener = await screen.findByRole("button", { name: "Delete Telegram profile" });

  await user.click(opener);

  expect(opener).toHaveAttribute("aria-expanded", "true");
  expect(opener).toHaveAttribute("aria-controls", "profile-deletion-confirmation");
  const confirmation = screen.getByRole("region", { name: "Delete Telegram profile?" });
  expect(confirmation).toHaveAccessibleDescription(deletionWarning);
  const heading = screen.getByRole("heading", { name: "Delete Telegram profile?" });
  expect(heading).toHaveAttribute("tabindex", "-1");
  expect(heading).toHaveFocus();

  await user.tab();
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Delete permanently" })).toHaveFocus();

  await user.click(cancel);

  expect(runtime.api.deleteProfile).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Delete Telegram profile?" }),
  ).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("disables both actions, blocks a same-tick double click, and announces pending", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  const deletion = deferred<typeof guestMe>();
  runtime.api.deleteProfile = vi.fn(() => deletion.promise);
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));

  await user.dblClick(screen.getByRole("button", { name: "Delete permanently" }));

  expect(runtime.api.deleteProfile).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Deleting Telegram profile…");

  await act(async () => {
    deletion.resolve(guestMe);
    await deletion.promise;
  });
  expect(
    await screen.findByText("Telegram profile deleted. You are now playing as a guest."),
  ).toBeInTheDocument();
});

it("shows an API request ID without losing the Telegram profile and retries", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(503, "UNAVAILABLE", "Deletion is unavailable.", "req-delete-9", null),
    )
    .mockResolvedValueOnce(guestMe);
  const opener = await screen.findByRole("button", { name: "Delete Telegram profile" });
  await user.click(opener);

  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Deletion is unavailable. Request ID: req-delete-9");
  expect(opener).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  const success = await screen.findByRole("status");
  expect(success).toHaveTextContent("Telegram profile deleted. You are now playing as a guest.");
  expect(success).toHaveFocus();
  expect(runtime.api.deleteProfile).toHaveBeenCalledTimes(2);
});

it("keeps a 401 unconfirmed and offers a reload before Telegram re-login", async () => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi
    .fn()
    .mockRejectedValue(
      new ApiError(401, "INVALID_SESSION", "The session expired.", "req-invalid-delete", null),
    );
  const opener = await screen.findByRole("button", { name: "Delete Telegram profile" });
  const originalToken = runtime.token.get();
  await user.click(opener);

  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Profile deletion could not be confirmed because this app session is no longer active. Reload, then choose Save progress with Telegram to verify the profile. Request ID: req-invalid-delete",
  );
  expect(screen.getByRole("button", { name: "Reload to sign in again" })).toBeEnabled();
  expect(opener).toHaveAttribute("aria-expanded", "true");
  expect(
    screen.queryByText("Telegram profile deleted. You are now playing as a guest."),
  ).not.toBeInTheDocument();
  expect(runtime.token.get()).toBe(originalToken);
  expect(runtime.platform.tokenStore.clear).not.toHaveBeenCalled();
});

it.each([
  ["ApiContractError", new ApiContractError(new Error("invalid response"))],
  ["ApiTransportError", new ApiTransportError(new TypeError("offline"))],
])("treats %s as unconfirmed and keeps retry available", async (_name, failure) => {
  const user = userEvent.setup();
  const { runtime } = renderDeletion("telegram");
  runtime.api.deleteProfile = vi.fn().mockRejectedValue(failure);
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));

  await user.click(screen.getByRole("button", { name: "Delete permanently" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Telegram profile deletion could not be confirmed. Retry to check the current profile state.",
  );
  expect(screen.getByRole("button", { name: "Delete permanently" })).toBeEnabled();
  expect(
    screen.queryByText("Telegram profile deleted. You are now playing as a guest."),
  ).not.toBeInTheDocument();
});

it("lets provider-owned deletion finish after only the child unmounts", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn(async () => telegramMe);
  const deletion = deferred<typeof guestMe>();
  let deletionSignal: AbortSignal | undefined;
  runtime.api.deleteProfile = vi.fn((signal) => {
    deletionSignal = signal;
    return deletion.promise;
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <ToggleDeletion />
      </SessionProvider>
    </RuntimeProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  await waitFor(() => expect(runtime.api.deleteProfile).toHaveBeenCalledOnce());

  await user.click(screen.getByRole("button", { name: "Hide deletion" }));

  expect(deletionSignal?.aborted).toBe(false);
  await act(async () => {
    deletion.resolve(guestMe);
    await deletion.promise;
  });
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "Session kind" })).toHaveTextContent("guest"),
  );
  expect(
    screen.queryByText("Telegram profile deleted. You are now playing as a guest."),
  ).not.toBeInTheDocument();
});

it("returns to a closed disclosure when a later explicit login restores Telegram", async () => {
  const user = userEvent.setup();
  const runtime = runtimeFixture({ storedToken: "t".repeat(43), platformKind: "web" });
  runtime.api.getMe = vi.fn().mockResolvedValueOnce(telegramMe).mockResolvedValueOnce(guestMe);
  let authReturn: ((url: string) => void) | undefined;
  runtime.platform.authReturn.subscribe = vi.fn(async (listener) => {
    authReturn = listener;
    return () => undefined;
  });
  render(
    <RuntimeProvider runtime={runtime}>
      <SessionProvider>
        <SaveProgressButton />
        <ProfileDeletion />
      </SessionProvider>
    </RuntimeProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Delete Telegram profile" }));
  await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  expect(
    await screen.findByText("Telegram profile deleted. You are now playing as a guest."),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Save progress with Telegram" }));
  await waitFor(() => expect(runtime.platform.openAuthorization).toHaveBeenCalledOnce());
  act(() => {
    authReturn?.(`/?handoff=${"A".repeat(43)}`);
  });

  const reopened = await screen.findByRole("button", { name: "Delete Telegram profile" });
  expect(reopened).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByText("Telegram profile deleted. You are now playing as a guest."),
  ).not.toBeInTheDocument();
});
