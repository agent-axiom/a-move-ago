import type { AcceptedSolution } from "@a-move-ago/api-contract";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RevealPlayer } from "./RevealPlayer";

const solution = {
  retraction: {
    currentSquare: "d5",
    previousSquare: "e4",
    movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" },
    special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5",
  explanation: "The white e-pawn captured the black pawn on d5.",
  historyConstraints: [
    { kind: "previous-castling", value: "KQkq" },
    { kind: "previous-en-passant", value: "d6" },
  ],
} satisfies AcceptedSolution;

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("replays the solution and leaves it readable until the player continues", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  render(<RevealPlayer onComplete={complete} postFen={postFen} solution={solution} />);

  expect(screen.getByRole("status")).toHaveTextContent("Rewinding the last move");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getByRole("status")).toHaveTextContent("Previous position reconstructed");
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByRole("status")).toHaveTextContent("Playing exd5 forward");
  expect(complete).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByRole("status")).toHaveTextContent("Solution replay complete");
  expect(screen.getByText(solution.explanation, { exact: false })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(60_000));
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(complete).toHaveBeenCalledOnce();
});

it("shows a stable solution with reduced motion and waits for Continue", () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const complete = vi.fn();
  render(<RevealPlayer onComplete={complete} postFen={postFen} solution={solution} />);

  expect(complete).not.toHaveBeenCalled();
  act(() => vi.runAllTimers());

  expect(screen.getByRole("status")).toHaveTextContent("Solution replay complete");
  expect(screen.getByText(solution.explanation, { exact: false })).toBeInTheDocument();
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(complete).toHaveBeenCalledOnce();
});

it("restarts from the post position when the solution identity changes", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  const view = render(<RevealPlayer onComplete={complete} postFen={postFen} solution={solution} />);

  act(() => vi.advanceTimersByTime(800));
  expect(screen.getByRole("status")).toHaveTextContent("Playing exd5 forward");

  view.rerender(
    <RevealPlayer
      onComplete={complete}
      postFen={postFen}
      solution={{ ...solution, forwardSan: "dxe4", explanation: "A different solution." }}
    />,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Rewinding the last move");
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  act(() => vi.advanceTimersByTime(50));
  expect(screen.getByRole("status")).toHaveTextContent("Previous position reconstructed");
  act(() => vi.advanceTimersByTime(750));
  expect(screen.getByRole("status")).toHaveTextContent("Playing dxe4 forward");
  expect(complete).not.toHaveBeenCalled();
});

it("cancels the reveal animation when it is unmounted", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  const view = render(<RevealPlayer onComplete={complete} postFen={postFen} solution={solution} />);
  act(() => vi.advanceTimersByTime(50));
  view.unmount();

  act(() => vi.runAllTimers());
  expect(vi.getTimerCount()).toBe(0);
  expect(complete).not.toHaveBeenCalled();
});
