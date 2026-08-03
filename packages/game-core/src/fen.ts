import type { Color, Piece, PieceType, Square } from "@a-move-ago/api-contract";
import { validateFen } from "chess.js";

export type Board = Partial<Record<Square, Piece>>;
export interface FenState {
  board: Board;
  turn: Color;
  castling: string;
  enPassant: Square | "-";
  halfmove: number;
  fullmove: number;
}
const files = "abcdefgh";

export function parseFen(fen: string): FenState {
  const validation = validateFen(fen);
  if (!validation.ok) throw new Error(`Invalid FEN: ${validation.error}`);
  const [placement, turn, castling, enPassant, halfmove, fullmove] = fen.split(" ");
  if (!placement || !turn || !castling || !enPassant || !halfmove || !fullmove) {
    throw new Error("Invalid FEN: expected six fields");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(halfmove) || !/^[1-9]\d*$/.test(fullmove)) {
    throw new Error("Invalid FEN: invalid move counters");
  }
  const parsedHalfmove = Number(halfmove);
  const parsedFullmove = Number(fullmove);
  if (
    !Number.isSafeInteger(parsedHalfmove) ||
    !Number.isSafeInteger(parsedFullmove) ||
    parsedHalfmove < 0 ||
    parsedFullmove < 1
  ) {
    throw new Error("Invalid FEN: invalid move counters");
  }
  const board: Board = {};
  placement.split("/").forEach((rankText, rankIndex) => {
    let fileIndex = 0;
    for (const char of rankText) {
      if (/\d/.test(char)) {
        fileIndex += Number(char);
        continue;
      }
      const square = `${files[fileIndex]}${8 - rankIndex}` as Square;
      board[square] = {
        color: char === char.toUpperCase() ? "w" : "b",
        type: char.toLowerCase() as PieceType,
      };
      fileIndex += 1;
    }
  });
  return {
    board,
    turn: turn as Color,
    castling,
    enPassant: enPassant as Square | "-",
    halfmove: parsedHalfmove,
    fullmove: parsedFullmove,
  };
}

export function serializeFen(state: FenState): string {
  const ranks = Array.from({ length: 8 }, (_, rankIndex) => {
    let empty = 0;
    let text = "";
    for (let fileIndex = 0; fileIndex < 8; fileIndex += 1) {
      const square = `${files[fileIndex]}${8 - rankIndex}` as Square;
      const piece = state.board[square];
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty) text += String(empty);
      empty = 0;
      const symbol = piece.color === "w" ? piece.type.toUpperCase() : piece.type;
      text += symbol;
    }
    if (empty) text += String(empty);
    return text;
  });
  return `${ranks.join("/")} ${state.turn} ${state.castling} ${state.enPassant} ${state.halfmove} ${state.fullmove}`;
}
