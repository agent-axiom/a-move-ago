import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider, localeStorageKey } from "../../i18n";
import { FirstMoveTutorial } from "./FirstMoveTutorial";
import { shouldOfferTutorial, tutorialPreferenceKey } from "./tutorial-preference";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;

beforeAll(() => {
  // jsdom has no dialog top layer. Browser tests cover the native focus trap.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterAll(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  HTMLDialogElement.prototype.close = originalClose;
});

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("teaches an actual backward move with free retries and no gameplay requests", async () => {
  const user = userEvent.setup();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const close = vi.fn();
  render(<FirstMoveTutorial locale="en" onClose={close} />);

  expect(screen.getByRole("heading", { name: "Your first move back" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  await user.click(screen.getByRole("gridcell", { name: "e2, empty" }));
  expect(screen.getByText("Select the white pawn on e4.")).toBeVisible();
  await user.click(screen.getByRole("gridcell", { name: "e4, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e3, empty" }));
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(screen.getByText(/Select e2 and try again — practice is free/)).toBeVisible();
  expect(shouldOfferTutorial()).toBe(true);

  await user.click(screen.getByRole("gridcell", { name: "e2, empty" }));
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(screen.getByRole("heading", { name: "You’ve gone one move back." })).toBeVisible();
  expect(screen.getByRole("gridcell", { name: "e2, white pawn" })).toBeDisabled();
  expect(screen.getByRole("gridcell", { name: "e4, empty" })).toBeDisabled();
  expect(window.localStorage.getItem(tutorialPreferenceKey)).toBe("completed");
  expect(shouldOfferTutorial()).toBe(false);
  await user.click(screen.getByRole("button", { name: "Start solving" }));
  expect(close).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
  expect(window.localStorage.length).toBe(1);
});

it("supports keyboard selection and restores focus to the lesson launcher", async () => {
  const user = userEvent.setup();
  const launcher = document.createElement("button");
  launcher.textContent = "Learn";
  document.body.append(launcher);
  launcher.focus();
  const view = render(<FirstMoveTutorial locale="en" onClose={vi.fn()} />);

  screen.getByRole("gridcell", { name: "e4, white pawn" }).focus();
  await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");
  expect(screen.getByRole("gridcell", { name: "e2, empty" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(screen.getByRole("heading", { name: "You’ve gone one move back." })).toBeVisible();
  view.unmount();
  expect(launcher).toHaveFocus();
  launcher.remove();
});

it("lets players skip or press Escape without repeating the invitation", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  const view = render(<FirstMoveTutorial locale="en" onClose={close} />);
  await user.click(screen.getByRole("button", { name: "Skip lesson" }));
  expect(close).toHaveBeenCalledOnce();
  expect(shouldOfferTutorial()).toBe(false);
  view.unmount();

  window.localStorage.clear();
  render(<FirstMoveTutorial locale="en" onClose={close} />);
  fireEvent(
    screen.getByRole("dialog", { name: "Your first move back" }),
    new Event("cancel", { cancelable: true }),
  );
  expect(close).toHaveBeenCalledTimes(2);
  expect(window.localStorage.getItem(tutorialPreferenceKey)).toBe("dismissed");
});

it("replays the lesson without erasing completion", async () => {
  const user = userEvent.setup();
  render(<FirstMoveTutorial locale="en" onClose={vi.fn()} />);
  await user.click(screen.getByRole("gridcell", { name: "e4, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e2, empty" }));
  await user.click(screen.getByRole("button", { name: "Check move" }));
  await user.click(screen.getByRole("button", { name: "Try once more" }));
  expect(screen.getByRole("gridcell", { name: "e4, white pawn" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Close lesson" }));
  expect(window.localStorage.getItem(tutorialPreferenceKey)).toBe("completed");
});

it.each([
  ["ru", "Ваш первый ход назад", "Проверить ход", "Вы вернулись на ход назад."],
  ["zh", "第一次退回走法", "检查走法", "你已经退回了一步。"],
] as const)("teaches the same move in %s", async (locale, title, check, success) => {
  const user = userEvent.setup();
  window.localStorage.setItem(localeStorageKey, locale);
  render(
    <I18nProvider>
      <FirstMoveTutorial locale={locale} onClose={vi.fn()} />
    </I18nProvider>,
  );
  expect(screen.getByRole("dialog", { name: title })).toBeVisible();
  await user.click(screen.getByRole("gridcell", { name: /^e4,/ }));
  await user.click(screen.getByRole("gridcell", { name: /^e2,/ }));
  await user.click(screen.getByRole("button", { name: check }));
  expect(screen.getByRole("heading", { name: success })).toBeVisible();
});
