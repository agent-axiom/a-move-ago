import { ApiError } from "@a-move-ago/api-contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { OverlayProvider, useActiveOverlayDismiss } from "../../app/overlays";
import { RuntimeProvider } from "../../app/runtime";
import { I18nProvider, localeStorageKey } from "../../i18n";
import { runtimeFixture } from "../../test/runtime-fixture";
import { PuzzleFeedback } from "./PuzzleFeedback";

const originalShowModal = HTMLDialogElement.prototype.showModal;
const originalClose = HTMLDialogElement.prototype.close;
const reportUuid = "33333333-3333-4333-8333-333333333333";
const nextReportUuid = "44444444-4444-4444-8444-444444444444";

beforeAll(() => {
  // jsdom has no dialog top layer. Browser tests exercise the actual focus trap.
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

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function HostBack() {
  const dismiss = useActiveOverlayDismiss();
  return <button onClick={dismiss} type="button">Host back</button>;
}

function setup(locale: "en" | "ru" | "zh" = "en") {
  window.localStorage.setItem(localeStorageKey, locale);
  const runtime = runtimeFixture({ storedToken: "private-session-token", platformKind: "android" });
  runtime.attemptUuid = vi.fn().mockReturnValueOnce(reportUuid).mockReturnValue(nextReportUuid);
  runtime.api.submitPuzzleFeedback = vi.fn().mockResolvedValue({ reportUuid, received: true });
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <I18nProvider>
        <OverlayProvider>
          <HostBack />
          <PuzzleFeedback
            caseId="case-2026-08-03"
            caseDate="2026-08-03"
            puzzleId="p-case-2026-08-03-1-v2"
            puzzleVersion={2}
          />
        </OverlayProvider>
      </I18nProvider>
    </RuntimeProvider>,
  );
  return { runtime, view, user: userEvent.setup() };
}

it("sends only explicitly entered feedback and the puzzle reference, without scoring or session data", async () => {
  const { runtime, user } = setup();
  const opener = screen.getByRole("button", { name: "Report a problem" });
  await user.click(opener);
  expect(screen.getByRole("heading", { name: "Help improve this puzzle" })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
  expect(runtime.api.submitPuzzleFeedback).not.toHaveBeenCalled();
  await user.click(screen.getByRole("radio", { name: "Another answer may be valid" }));
  await user.type(screen.getByRole("textbox", { name: "Tell us more (optional)" }), "  Please check this line.  ");
  await user.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByRole("heading", { name: "Report received" });
  expect(runtime.api.submitPuzzleFeedback).toHaveBeenCalledWith(
    {
      reportUuid,
      caseId: "case-2026-08-03",
      puzzleId: "p-case-2026-08-03-1-v2",
      puzzleVersion: 2,
      locale: "en",
      reason: "alternative_answer",
      comment: "Please check this line.",
    },
    expect.any(AbortSignal),
  );
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
  expect(runtime.api.requestHint).not.toHaveBeenCalled();
  expect(runtime.api.getPuzzleReveal).not.toHaveBeenCalled();
  expect(runtime.platform.openExternal).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Back to the puzzle" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("keeps the same report identity through a failed request, close, reopen and retry", async () => {
  const { runtime, user } = setup();
  runtime.api.submitPuzzleFeedback = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValueOnce({ reportUuid, received: true });
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("radio", { name: "The instructions are unclear" }));
  await user.click(screen.getByRole("button", { name: "Send report" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Delivery could not be confirmed");
  expect(screen.queryByRole("heading", { name: "Report received" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Report received" });
  const calls = vi.mocked(runtime.api.submitPuzzleFeedback).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
  expect(runtime.attemptUuid).toHaveBeenCalledOnce();
});

it("uses a new report identity when the player changes an uncertain report", async () => {
  const { runtime, user } = setup();
  runtime.api.submitPuzzleFeedback = vi.fn().mockRejectedValue(new Error("offline"));
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("radio", { name: "Something else" }));
  await user.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByRole("alert");
  await user.type(screen.getByRole("textbox"), "Additional context");
  await user.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByRole("alert");
  const calls = vi.mocked(runtime.api.submitPuzzleFeedback).mock.calls;
  expect(calls[0]?.[0].reportUuid).toBe(reportUuid);
  expect(calls[1]?.[0].reportUuid).toBe(nextReportUuid);
  expect(calls[1]?.[0].comment).toBe("Additional context");
});

it("blocks double sends and lets native Back close an uncertain request without losing its retry identity", async () => {
  const { runtime, user } = setup();
  let signal: AbortSignal | undefined;
  runtime.api.submitPuzzleFeedback = vi.fn<typeof runtime.api.submitPuzzleFeedback>((_request, observedSignal) => {
    signal = observedSignal;
    return new Promise(() => undefined);
  });
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("radio", { name: "Something else" }));
  await user.click(screen.getByRole("button", { name: "Send report" }));
  expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
  expect(screen.getByRole("textbox")).toBeDisabled();
  const form = document.querySelector(".feedback-dialog form");
  if (!form) throw new Error("Missing feedback form");
  fireEvent.submit(form);
  expect(runtime.api.submitPuzzleFeedback).toHaveBeenCalledOnce();
  // Native host events are independent of the browser's modal focus trap.
  fireEvent.click(screen.getByRole("button", { name: "Host back" }));
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Delivery could not be confirmed");
  runtime.api.submitPuzzleFeedback = vi.fn().mockResolvedValue({ reportUuid, received: true });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Report received" });
  expect(runtime.attemptUuid).toHaveBeenCalledOnce();
});

it("cancels with Escape and aborts requests on unmount", async () => {
  const { runtime, user, view } = setup();
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(runtime.api.submitPuzzleFeedback).not.toHaveBeenCalled();
  let observedSignal: AbortSignal | undefined;
  runtime.api.submitPuzzleFeedback = vi.fn<typeof runtime.api.submitPuzzleFeedback>((_request, signal) => {
    observedSignal = signal;
    return new Promise(() => undefined);
  });
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("radio", { name: "Something else" }));
  await user.click(screen.getByRole("button", { name: "Send report" }));
  view.unmount();
  expect(observedSignal?.aborted).toBe(true);
});

it.each([
  ["ru", "Сообщить о проблеме", "Ошибка в объяснении", "Отправить отчёт", "Отчёт получен"],
  ["zh", "报告问题", "讲解可能有误", "发送报告", "已收到报告"],
] as const)("localizes the complete feedback flow in %s", async (locale, trigger, reason, send, received) => {
  const { runtime, user } = setup(locale);
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(screen.getByRole("radio", { name: reason }));
  await user.click(screen.getByRole("button", { name: send }));
  await screen.findByRole("heading", { name: received });
  expect(runtime.api.submitPuzzleFeedback).toHaveBeenCalledWith(
    expect.objectContaining({ locale, reason: "explanation_error" }),
    expect.any(AbortSignal),
  );
});

it.each([
  [401, "Your session has expired"],
  [404, "This version of the puzzle is no longer available"],
  [429, "Too many reports were sent recently"],
])("explains API failure %s without claiming delivery", async (status, message) => {
  const { runtime, user } = setup();
  runtime.api.submitPuzzleFeedback = vi.fn().mockRejectedValue(new ApiError(Number(status), "ERROR", "Server error", "synthetic-request", null));
  await user.click(screen.getByRole("button", { name: "Report a problem" }));
  await user.click(screen.getByRole("radio", { name: "Something else" }));
  await user.click(screen.getByRole("button", { name: "Send report" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(String(message)));
  expect(screen.queryByRole("heading", { name: "Report received" })).not.toBeInTheDocument();
});
