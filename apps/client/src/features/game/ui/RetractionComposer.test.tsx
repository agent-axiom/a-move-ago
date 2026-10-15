import { parseFen } from "@a-move-ago/game-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RetractionComposer } from "./RetractionComposer";

afterEach(cleanup);

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
  await user.selectOptions(screen.getByLabelText("Captured piece"), "p");

  expect(screen.getByRole("gridcell", { name: "d5, white pawn" })).toBeEnabled();
  expect(screen.getByRole("gridcell", { name: "e4, empty" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Before", exact: true }));
  expect(
    screen.getByRole("grid", { name: "Your reconstruction, read-only preview" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "e4, white pawn" })).toBeDisabled();
  expect(screen.getByRole("gridcell", { name: "d5, black pawn" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Now", exact: true }));
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
  expect(screen.getByText("Reverse promotion", { selector: "strong" })).toBeInTheDocument();
  await user.click(screen.getByRole("gridcell", { name: "c8, white knight" }));
  await user.click(screen.getByRole("gridcell", { name: "c7, empty" }));
  await user.selectOptions(screen.getByLabelText("Special move"), "unpromotion");
  await user.click(screen.getByRole("button", { name: "Before", exact: true }));
  expect(screen.getByRole("gridcell", { name: "c7, white pawn" })).toBeInTheDocument();
  expect(screen.getByRole("gridcell", { name: "c8, empty" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check move" }));
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ special: "unpromotion" }));
});
