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
  await user.click(screen.getByRole("button", { name: "Submit retraction" }));
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
  expect(screen.getByRole("button", { name: "Submit retraction" })).toBeEnabled();

  view.rerender(tree("rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 7 3"));

  expect(screen.getByText("Choose the piece that moved last.")).toBeInTheDocument();
  expect(screen.queryByLabelText("Captured piece")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Submit retraction" })).toBeDisabled();
});
