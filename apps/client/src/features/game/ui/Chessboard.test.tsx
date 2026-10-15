import { parseFen } from "@a-move-ago/game-core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Chessboard } from "./Chessboard";

afterEach(cleanup);

it("exposes 64 named buttons, roving focus and a non-drag selection path", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const board = parseFen("4k3/8/8/3P4/8/8/8/4K3 b - - 0 1").board;
  render(
    <Chessboard
      board={board}
      orientation="white"
      selectedSquare={null}
      onSelect={select}
      label="Position after the unknown move"
    />,
  );

  expect(screen.getAllByRole("row")).toHaveLength(8);
  expect(screen.getAllByRole("gridcell")).toHaveLength(64);
  const a8 = screen.getByRole("gridcell", { name: "a8, empty" });
  a8.focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("gridcell", { name: "b8, empty" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledWith("b8");
  await user.click(screen.getByRole("gridcell", { name: "d5, white pawn" }));
  expect(select).toHaveBeenLastCalledWith("d5");
});

it("keeps keyboard directions visual when the board is oriented for Black", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <Chessboard
      board={parseFen("4k3/8/8/3p4/8/8/8/4K3 w - - 0 1").board}
      orientation="black"
      selectedSquare="d5"
      destinationSquare="e6"
      onSelect={select}
      label="Black's reconstruction"
    />,
  );
  screen.getByRole("gridcell", { name: "h1, empty" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("gridcell", { name: "g1, empty" })).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(select).toHaveBeenCalledWith("g2");
  expect(screen.getByRole("gridcell", { name: "d5, black pawn" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
