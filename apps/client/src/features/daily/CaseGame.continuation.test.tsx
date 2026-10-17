import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeProvider } from "../../app/runtime";
import { I18nProvider, localeStorageKey } from "../../i18n";
import { runtimeFixture } from "../../test/runtime-fixture";
import { readGameDraft, readPendingAttempt, writePendingAttempt } from "../game/model/persistence";
import { CaseGame } from "./CaseGame";

const solution: AcceptedSolution = {
  retraction: {
    currentSquare: "d5", previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" }, special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5",
  explanation: "The white e-pawn captured the pawn on d5.",
  historyConstraints: [],
  localizations: {
    ru: { explanation: "Белая пешка с e4 взяла пешку на d5." },
    zh: { explanation: "白方 e 兵吃掉了 d5 上的兵。" },
  },
};

async function fixture() {
  const runtime = runtimeFixture({ storedToken: "guest-token", platformKind: "web" });
  runtime.api.getStats = vi.fn().mockResolvedValue({ attempts: 1, hintsUsed: 0, solvedPuzzles: 1,
    completedCases: 1, currentStreak: 1, bestStreak: 1, lastCompletedDate: "2026-08-03", points: 100 });
  runtime.api.getPuzzleReveal = vi.fn().mockResolvedValue({ reveal: solution });
  const daily = await runtime.api.getDaily();
  const puzzleId = daily.puzzles[0]?.id;
  if (!puzzleId) throw new Error("Missing fixture puzzle");
  return { runtime, daily: { ...daily, solvedPuzzleIds: [puzzleId] } };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([
  ["en", "Review solution", "Solution review", "Back to case", solution.explanation],
  ["ru", "Посмотреть разбор", "Разбор решения", "Вернуться к задаче", solution.localizations?.ru?.explanation],
  ["zh", "查看讲解", "解题回顾", "返回棋题", solution.localizations?.zh?.explanation],
] as const)("reopens an earned solution in %s with no scoring or attempts", async (locale, review, heading, back, explanation) => {
  window.localStorage.setItem(localeStorageKey, locale);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const { runtime, daily } = await fixture();
  render(<RuntimeProvider runtime={runtime}><I18nProvider><CaseGame daily={daily} /></I18nProvider></RuntimeProvider>);
  expect(runtime.api.getPuzzleReveal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: review }));
  await screen.findByRole("heading", { name: heading });
  expect(screen.getByText(explanation ?? "missing translation")).toBeInTheDocument();
  expect(runtime.api.getPuzzleReveal).toHaveBeenCalledWith(daily.id, daily.puzzles[0]?.id, expect.any(AbortSignal));
  expect(document.querySelector(".solution-reward")).toBeNull();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
  expect(runtime.api.requestHint).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: back })[0] as HTMLButtonElement);
  expect(screen.getByRole("button", { name: review })).toBeInTheDocument();
});

it("cancels a pending review when leaving it and can retry a failed read", async () => {
  const { runtime, daily } = await fixture();
  let observedSignal: AbortSignal | undefined;
  runtime.api.getPuzzleReveal = vi.fn((_caseId, _puzzleId, signal) => {
    observedSignal = signal;
    return new Promise<{ reveal: AcceptedSolution }>(() => undefined);
  });
  render(<RuntimeProvider runtime={runtime}><CaseGame daily={daily} /></RuntimeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Review solution" }));
  expect(await screen.findByRole("status", { name: "" })).toHaveTextContent("Loading your solution");
  fireEvent.click(screen.getByRole("button", { name: "Back to case" }));
  expect(observedSignal?.aborted).toBe(true);
  runtime.api.getPuzzleReveal = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ reveal: solution });
  fireEvent.click(screen.getByRole("button", { name: "Review solution" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The solution could not be loaded");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Solution review" });
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
});

it("offers reviews only for completed acts while the next act remains playable", async () => {
  const { runtime, daily } = await fixture();
  const first = daily.puzzles[0];
  if (!first) throw new Error("Missing fixture puzzle");
  daily.puzzles.push({ ...first, id: "second-puzzle" });
  render(<RuntimeProvider runtime={runtime}><CaseGame daily={daily} /></RuntimeProvider>);
  expect(screen.getAllByRole("button", { name: /Review solution/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /Review solution/ }));
  await screen.findByRole("heading", { name: "Solution review" });
  expect(runtime.api.getPuzzleReveal).toHaveBeenCalledWith(daily.id, first.id, expect.any(AbortSignal));
  fireEvent.click(screen.getAllByRole("button", { name: "Back to case" })[0] as HTMLButtonElement);
  expect(screen.getByText("Act 2 of 2")).toBeInTheDocument();
});

it("clears a crash-interrupted submission only after the server confirms an earned review", async () => {
  const { runtime, daily } = await fixture();
  const puzzle = daily.puzzles[0];
  if (!puzzle) throw new Error("Missing fixture puzzle");
  runtime.draftActorKey = () => "synthetic-player";
  const scope = { actorKey: "synthetic-player", caseId: daily.id, puzzleId: puzzle.id, puzzleVersion: puzzle.version };
  writePendingAttempt(scope, { attemptUuid: "22222222-2222-4222-8222-222222222222",
    caseId: daily.id, puzzleId: puzzle.id, retraction: solution.retraction });
  runtime.api.getPuzzleReveal = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ reveal: solution });
  render(<RuntimeProvider runtime={runtime}><CaseGame daily={daily} /></RuntimeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Review solution" }));
  await screen.findByRole("alert");
  expect(readPendingAttempt(scope)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Solution review" });
  expect(readPendingAttempt(scope)).toBeNull();
  expect(readGameDraft(scope)).toBeNull();
  expect(runtime.api.submitAttempt).not.toHaveBeenCalled();
});

it("makes next-puzzle navigation retryable and explains when the published archive is completed", async () => {
  const { runtime, daily } = await fixture();
  const next = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(false);
  render(<RuntimeProvider runtime={runtime}><CaseGame daily={daily} onNextUnsolved={next} /></RuntimeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Next unsolved puzzle" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The archive could not be loaded"));
  fireEvent.click(screen.getByRole("button", { name: "Next unsolved puzzle" }));
  await screen.findByText("You’ve solved every available case. Come back tomorrow.");
  expect(screen.queryByRole("button", { name: "Next unsolved puzzle" })).not.toBeInTheDocument();
  expect(next).toHaveBeenCalledTimes(2);
});
