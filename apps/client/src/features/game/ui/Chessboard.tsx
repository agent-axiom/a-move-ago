import type { Piece, Square } from "@a-move-ago/api-contract";
import type { Board } from "@a-move-ago/game-core";
import { type KeyboardEvent, useRef, useState } from "react";
import blackBishop from "../../../assets/pieces/bB.svg";
import blackKing from "../../../assets/pieces/bK.svg";
import blackKnight from "../../../assets/pieces/bN.svg";
import blackPawn from "../../../assets/pieces/bP.svg";
import blackQueen from "../../../assets/pieces/bQ.svg";
import blackRook from "../../../assets/pieces/bR.svg";
import whiteBishop from "../../../assets/pieces/wB.svg";
import whiteKing from "../../../assets/pieces/wK.svg";
import whiteKnight from "../../../assets/pieces/wN.svg";
import whitePawn from "../../../assets/pieces/wP.svg";
import whiteQueen from "../../../assets/pieces/wQ.svg";
import whiteRook from "../../../assets/pieces/wR.svg";
import { useI18n } from "../../../i18n";
import { type BoardOrientation, nextFocus, squareAt } from "./board-order";

const pieces: Record<string, string> = {
  wp: whitePawn,
  wn: whiteKnight,
  wb: whiteBishop,
  wr: whiteRook,
  wq: whiteQueen,
  wk: whiteKing,
  bp: blackPawn,
  bn: blackKnight,
  bb: blackBishop,
  br: blackRook,
  bq: blackQueen,
  bk: blackKing,
};

export function Chessboard(props: {
  board: Board;
  orientation: BoardOrientation;
  selectedSquare: Square | null;
  destinationSquare?: Square | null;
  onSelect(square: Square): void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  const cells = useRef<Array<HTMLButtonElement | null>>([]);

  function pieceLabel(piece: Piece | undefined): string {
    return piece ? t(`game.piece.${piece.color}${piece.type}`) : t("game.empty");
  }

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
            const destination = props.destinationSquare === square;
            return (
              // biome-ignore lint/a11y/useSemanticElements: Native buttons preserve click and keyboard activation while participating directly in the ARIA grid.
              <button
                aria-label={`${square}, ${pieceLabel(piece)}`}
                aria-selected={selected}
                className={`board-cell ${(row + column) % 2 ? "dark" : "light"}${destination ? " board-cell-destination" : ""}`}
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
                {piece ? (
                  <img
                    alt=""
                    aria-hidden="true"
                    className="chess-piece"
                    draggable={false}
                    src={pieces[`${piece.color}${piece.type}`]}
                  />
                ) : null}
                {column === 0 ? (
                  <span aria-hidden="true" className="square-rank">
                    {square[1]}
                  </span>
                ) : null}
                {row === 7 ? (
                  <span aria-hidden="true" className="square-file">
                    {square[0]}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
