import type { Piece, Square } from "@a-move-ago/api-contract";
import type { Board } from "@a-move-ago/game-core";
import { type KeyboardEvent, useRef, useState } from "react";
import { type BoardOrientation, nextFocus, squareAt } from "./board-order";

const names = {
  p: "pawn",
  n: "knight",
  b: "bishop",
  r: "rook",
  q: "queen",
  k: "king",
} as const;

const glyphs: Record<string, string> = {
  wp: "♙",
  wn: "♘",
  wb: "♗",
  wr: "♖",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  bn: "♞",
  bb: "♝",
  br: "♜",
  bq: "♛",
  bk: "♚",
};

function pieceLabel(piece: Piece | undefined): string {
  return piece ? `${piece.color === "w" ? "white" : "black"} ${names[piece.type]}` : "empty";
}

export function Chessboard(props: {
  board: Board;
  orientation: BoardOrientation;
  selectedSquare: Square | null;
  onSelect(square: Square): void;
  label: string;
  disabled?: boolean;
}) {
  const [active, setActive] = useState(0);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextFocus(index, event.key);
    if (
      next === index &&
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    setActive(next);
    cells.current[next]?.focus();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: ARIA grid keyboard navigation requires one roving tab stop across native button cells.
    <div className="chessboard" role="grid" aria-label={props.label}>
      {Array.from({ length: 8 }, (_, row) => (
        // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: The row groups button gridcells and must not add another keyboard stop.
        <div className="board-row" key={squareAt(props.orientation, row, 0)} role="row">
          {Array.from({ length: 8 }, (_, column) => {
            const index = row * 8 + column;
            const square = squareAt(props.orientation, row, column);
            const piece = props.board[square];
            const selected = props.selectedSquare === square;
            return (
              // biome-ignore lint/a11y/useSemanticElements: Native buttons preserve click and keyboard activation while participating directly in the ARIA grid.
              <button
                aria-label={`${square}, ${pieceLabel(piece)}`}
                aria-selected={selected}
                className={`board-cell ${(row + column) % 2 ? "dark" : "light"}`}
                disabled={props.disabled}
                key={square}
                onClick={() => props.onSelect(square)}
                onFocus={() => setActive(index)}
                onKeyDown={(event) => onKeyDown(event, index)}
                ref={(element) => {
                  cells.current[index] = element;
                }}
                role="gridcell"
                tabIndex={active === index ? 0 : -1}
                type="button"
              >
                <span aria-hidden="true" className="piece-glyph">
                  {piece ? glyphs[`${piece.color}${piece.type}`] : ""}
                </span>
                <span aria-hidden="true" className="square-coordinate">
                  {square}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
