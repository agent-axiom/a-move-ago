import type { Square } from "@a-move-ago/api-contract";

export type BoardOrientation = "white" | "black";

const files = "abcdefgh";

export function squareAt(orientation: BoardOrientation, row: number, column: number): Square {
  const fileIndex = orientation === "white" ? column : 7 - column;
  const rank = orientation === "white" ? 8 - row : row + 1;
  return `${files[fileIndex]}${rank}` as Square;
}

export function nextFocus(index: number, key: string): number {
  const row = Math.floor(index / 8);
  const column = index % 8;
  switch (key) {
    case "ArrowUp":
      return Math.max(0, row - 1) * 8 + column;
    case "ArrowDown":
      return Math.min(7, row + 1) * 8 + column;
    case "ArrowLeft":
      return row * 8 + Math.max(0, column - 1);
    case "ArrowRight":
      return row * 8 + Math.min(7, column + 1);
    case "Home":
      return row * 8;
    case "End":
      return row * 8 + 7;
    default:
      return index;
  }
}
