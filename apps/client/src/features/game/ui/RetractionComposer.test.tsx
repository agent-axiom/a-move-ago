import { parseFen } from "@a-move-ago/game-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearGamePersistence,
  type GamePersistenceScope,
  readGameDraft,
} from "../model/persistence";
import { RetractionComposer } from "./RetractionComposer";

afterEach(() => {
  cleanup();
  clearGamePersistence();
});

it("submits a capture through clicks and native selects", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2")}
      retractingColor="w"
    />,
  );
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(screen.getByText("Capture or special move", { selector: "summary" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      currentSquare: "d5",
      previousSquare: "e4",
      restoredPiece: { color: "b", type: "p", square: "d5" },
    }),
  );
});

it("resets the draft when the puzzle position changes", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const tree = (fen: string) => (
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen(fen)}
      retractingColor="w"
    />
  );
  const view = render(tree("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2"));

  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(screen.getByText("Capture or special move", { selector: "summary" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();

  view.rerender(tree("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 7 3"));

  expect(
    screen.getByText("Choose the piece that moved last.", { selector: ".board-caption" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Captured piece")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
});

it("keeps the current board editable and makes the reconstruction an explicit read-only view", async () => {
  const user = userEvent.setup();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={vi.fn()}
      post={parseFen("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2")}
      retractingColor="w"
    />,
  );
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(screen.getByText("Capture or special move", { selector: "summary" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");

  expect(screen.getByRole("gridcell", { name: "d5, white pawn" })).toBeEnabled();
  expect(screen.getByRole("gridcell", { name: "e4, empty" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Before" }));
  expect(
    screen.getByRole("grid", { name: "Your reconstruction, read-only preview" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "e4, white pawn" })).toBeDisabled();
  expect(screen.getByRole("gridcell", { name: "d5, black pawn" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Now" }));
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  expect(
    screen.getByText("Choose the square it came from.", { selector: ".board-caption" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("gridcell", { name: "c4, empty" }));
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();
});

it("makes reverse promotion discoverable and previews a pawn rather than the promoted piece", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen("2N5/4k3/8/8/8/8/8/K7 b - - 0 40")}
      retractingColor="w"
    />,
  );
  expect(screen.getByText("Capture or special move", { selector: "summary" })).toBeVisible();
  await user.click(screen.getByRole("gridcell", { name: "c8, white knight" }));
  await user.click(screen.getByRole("gridcell", { name: "c7, empty" }));
  await user.click(screen.getByText("Capture or special move", { selector: "summary" }));
  await user.selectOptions(screen.getByLabelText("Special move"), "unpromotion");
  await user.click(screen.getByRole("button", { name: "Before" }));
  expect(screen.getByRole("gridcell", { name: "c7, white pawn" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "c8, empty" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ special: "unpromotion" }));
});

const scope: GamePersistenceScope = {
  actorKey: "opaque-actor",
  caseId: "case-2026-08-03",
  puzzleId: "opening-exd5",
  puzzleVersion: 1,
};
const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

it("shows each selected square in the action dock without enabling an incomplete move", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen(postFen)}
      retractingColor="w"
    />,
  );
  const selectedMove = screen.getByLabelText("Selected retraction");
  const check = screen.getByRole("button", { name: "Check move" });
  expect(selectedMove).toHaveTextContent("—");
  expect(check).toBeDisabled();
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  expect(selectedMove).toHaveTextContent("d5");
  expect(selectedMove).toHaveTextContent("—");
  expect(check).toBeDisabled();
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  expect(selectedMove).toHaveTextContent("e4");
  expect(check).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(selectedMove).not.toHaveTextContent("d5");
  expect(selectedMove).not.toHaveTextContent("e4");
  expect(check).toBeDisabled();
  expect(submit).not.toHaveBeenCalled();
});

it("restores partial selection and configured capture after remount, then clears an explicit reset", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();
  const tree = () => (
    <RetractionComposer
      disabled={false}
      onSubmit={submit}
      post={parseFen(postFen)}
      retractingColor="w"
      persistenceScope={scope}
    />
  );
  const first = render(tree());
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  first.unmount();
  const second = render(tree());
  expect(screen.getByRole("gridcell", { name: "d5, white pawn" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.getByText("Choose the square it came from.", { selector: ".board-caption" }),
  ).toBeVisible();
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(screen.getByText("Capture or special move", { selector: "summary" }));
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  second.unmount();
  const third = render(tree());
  expect(screen.getByLabelText("Captured piece")).toBeVisible();
  expect(screen.getByLabelText("Captured piece")).toHaveValue("p");
  expect(screen.getByText("Captured piece: Pawn")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      currentSquare: "d5",
      previousSquare: "e4",
      restoredPiece: { color: "b", type: "p", square: "d5" },
    }),
  );
  await user.click(screen.getByRole("button", { name: "Reset" }));
  expect(readGameDraft(scope)).toBeNull();
  third.unmount();
  render(tree());
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  expect(screen.getByRole("gridcell", { name: "d5, white pawn" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
});

it("resets the visible draft on an account or version change even when the board is identical", async () => {
  const user = userEvent.setup();
  const tree = (persistenceScope: GamePersistenceScope) => (
    <RetractionComposer
      disabled={false}
      onSubmit={vi.fn()}
      post={parseFen(postFen)}
      retractingColor="w"
      persistenceScope={persistenceScope}
    />
  );
  const view = render(tree(scope));
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();
  view.rerender(tree({ ...scope, actorKey: "another-account" }));
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
  view.rerender(tree({ ...scope, puzzleVersion: 2 }));
  expect(screen.getByRole("button", { name: "Check move" })).toBeDisabled();
});

it("keeps selected capture information visible when its advanced controls are collapsed", async () => {
  const user = userEvent.setup();
  render(
    <RetractionComposer
      disabled={false}
      onSubmit={vi.fn()}
      post={parseFen(postFen)}
      retractingColor="w"
    />,
  );
  const disclosure = screen.getByText("Capture or special move", { selector: "summary" });
  expect(screen.getByLabelText("Captured piece")).not.toBeVisible();
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  await user.click(screen.getByRole("gridcell", { name: "e4, empty" }));
  await user.click(disclosure);
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");
  await user.click(disclosure);
  expect(screen.getByLabelText("Captured piece")).not.toBeVisible();
  expect(screen.getByText("Captured piece: Pawn")).toBeVisible();
  expect(screen.getByRole("button", { name: "Check move" })).toBeEnabled();
});
