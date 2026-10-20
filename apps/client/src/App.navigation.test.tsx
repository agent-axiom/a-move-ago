import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { RuntimeProvider } from "./app/runtime";
import { localeStorageKey } from "./i18n";
import { runtimeFixture } from "./test/runtime-fixture";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeEach(() => {
  localStorage.removeItem(localeStorageKey);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  localStorage.removeItem(localeStorageKey);
  window.history.replaceState(null, "", "/");
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

it("changes language inside the menu without resetting a historical move, and native Back closes only the menu", async () => {
  window.history.replaceState(null, "", "/?case=2026-08-03");
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "android" });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>,
  );
  await user.click(await screen.findByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  expect(screen.queryByLabelText("Language")).not.toBeInTheDocument();
  const opener = screen.getByRole("button", { name: "Menu", exact: true });
  await user.click(opener);
  await user.selectOptions(screen.getByLabelText("Language"), "ru");
  expect(screen.getByRole("dialog", { name: "Меню" })).toBeVisible();

  const back = vi.mocked(runtime.platform.setBackHandler).mock.calls.at(-1)?.[0];
  expect(back).toBeTypeOf("function");
  act(() => back?.());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
  expect(screen.getByRole("gridcell", { name: "d5, белая пешка" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("Выбранный возврат хода")).toHaveTextContent("d5");
  expect(screen.getByLabelText("Выбранный возврат хода")).toHaveTextContent("e4");
  expect(window.location.search).toBe("?case=2026-08-03");
  expect(runtime.api.getDaily).toHaveBeenCalledOnce();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
});

it("keeps the three destinations available and restores native Back after closing an overlay", async () => {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "android" });
  const user = userEvent.setup();
  render(
    <RuntimeProvider runtime={runtime}>
      <App />
    </RuntimeProvider>,
  );
  await screen.findByRole("heading", { name: "The missing pawn", level: 1 });
  const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
  expect(navigation.getAllByRole("button")).toHaveLength(3);
  expect(navigation.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await user.click(navigation.getByRole("button", { name: "Archive" }));
  await screen.findByRole("heading", { name: "The archive" });
  expect(navigation.getByRole("button", { name: "Archive" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await user.click(screen.getByRole("button", { name: "Menu", exact: true }));
  act(() => vi.mocked(runtime.platform.setBackHandler).mock.calls.at(-1)?.[0]?.());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(window.location.search).toBe("?view=archive");
  act(() => vi.mocked(runtime.platform.setBackHandler).mock.calls.at(-1)?.[0]?.());
  await waitFor(() => expect(window.location.search).toBe(""));
  expect(navigation.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
});
