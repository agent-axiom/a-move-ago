import type { Color, PieceType, PuzzlePrivate, Retraction, Square } from "@a-move-ago/api-contract";
import { Chess } from "chess.js";
import { parseFen, serializeFen } from "./fen";
import { applyRetraction } from "./retract";

type Board = ReturnType<typeof parseFen>["board"];
type Restorable = NonNullable<Retraction["restoredPiece"]>["type"];

export interface RetroCandidate {
  retraction: Retraction;
  previousFen: string;
  forwardSan: string;
  postFen: string;
}

const files = "abcdefgh";
const squares: Square[] = Array.from(
  { length: 64 },
  (_, index) => `${files[index % 8]}${Math.floor(index / 8) + 1}`,
);
const capturedTypes: Restorable[] = ["p", "n", "b", "r", "q"];
const promotedTypes = new Set<PieceType>(["n", "b", "r", "q"]);

function coordinates(square: Square): [number, number] {
  return [square.charCodeAt(0) - 97, Number(square[1]) - 1];
}

function opposite(color: Color): Color {
  return color === "w" ? "b" : "w";
}

function placement(fen: string): string {
  return fen.split(" ")[0] ?? "";
}

/** Minimum captures by surviving pawns, without presuming their original files. */
function minimumPawnCaptures(pawns: Square[], color: Color): number {
  let costs = new Map<number, number>([[0, 0]]);
  for (const square of pawns) {
    const [file, rank] = coordinates(square);
    const advancement = color === "w" ? rank - 1 : 6 - rank;
    const next = new Map<number, number>();
    for (const [used, cost] of costs) {
      for (let origin = 0; origin < 8; origin += 1) {
        const captures = Math.abs(origin - file);
        if ((used & (1 << origin)) !== 0 || captures > advancement) continue;
        const mask = used | (1 << origin);
        next.set(mask, Math.min(next.get(mask) ?? Number.POSITIVE_INFINITY, cost + captures));
      }
    }
    costs = next;
  }
  return Math.min(...costs.values());
}

/** Necessary bounds only: passing does not establish complete game reachability. */
export function retroMaterialFeasible(board: Board): boolean {
  const entries = Object.entries(board).filter((entry) => entry[1] !== undefined);
  for (const color of ["w", "b"] as const) {
    const own = entries.filter(([, piece]) => piece?.color === color);
    const opponents = entries.filter(([, piece]) => piece?.color === opposite(color));
    const count = (type: PieceType) => own.filter(([, piece]) => piece?.type === type).length;
    const pawns = own.filter(([, piece]) => piece?.type === "p").map(([square]) => square);
    if (own.length > 16 || count("k") !== 1 || pawns.length > 8) return false;
    if (pawns.some((square) => square.endsWith("1") || square.endsWith("8"))) return false;
    const bishops = own.filter(([, piece]) => piece?.type === "b");
    const bishopColors = [0, 0];
    for (const [square] of bishops) {
      const [file, rank] = coordinates(square);
      const index = (file + rank) % 2;
      bishopColors[index] = (bishopColors[index] ?? 0) + 1;
    }
    const requiredPromotions =
      Math.max(0, count("q") - 1) +
      Math.max(0, count("r") - 2) +
      Math.max(0, count("n") - 2) +
      bishopColors.reduce((total, count) => total + Math.max(0, count - 1), 0);
    if (requiredPromotions > 8 - pawns.length) return false;
    if (minimumPawnCaptures(pawns, color) > 16 - opponents.length) return false;
  }
  return true;
}

function clearPath(board: Board, previous: Square, current: Square): boolean {
  const [px, py] = coordinates(previous);
  const [cx, cy] = coordinates(current);
  const dx = Math.sign(cx - px);
  const dy = Math.sign(cy - py);
  for (let x = px + dx, y = py + dy; x !== cx || y !== cy; x += dx, y += dy) {
    if (board[`${files[x]}${y + 1}`]) return false;
  }
  return true;
}

function canOriginate(board: Board, move: Retraction): boolean {
  const [px, py] = coordinates(move.previousSquare);
  const [cx, cy] = coordinates(move.currentSquare);
  const dx = Math.abs(cx - px);
  const dy = Math.abs(cy - py);
  switch (move.movedPiece.type) {
    case "p": {
      const direction = move.movedPiece.color === "w" ? 1 : -1;
      return (
        (dx <= 1 && cy - py === direction) ||
        (dx === 0 && cy - py === 2 * direction && py === (direction === 1 ? 1 : 6))
      );
    }
    case "n":
      return dx * dy === 2;
    case "k":
      return Math.max(dx, dy) === 1;
    case "b":
      return dx === dy && clearPath(board, move.previousSquare, move.currentSquare);
    case "r":
      return (dx === 0 || dy === 0) && clearPath(board, move.previousSquare, move.currentSquare);
    case "q":
      return (
        (dx === dy || dx === 0 || dy === 0) &&
        clearPath(board, move.previousSquare, move.currentSquare)
      );
  }
}

export function retroRetractionKey(move: Retraction): string {
  return JSON.stringify([
    move.currentSquare,
    move.previousSquare,
    move.movedPiece.color,
    move.movedPiece.type,
    move.special,
    move.restoredPiece?.color ?? null,
    move.restoredPiece?.type ?? null,
    move.restoredPiece?.square ?? null,
  ]);
}

/**
 * Enumerate the complete set of locally legal, materially feasible predecessors.
 * Only placement and retractingColor are evidence: invisible FEN metadata cannot
 * be used to reject a player's answer. Search includes all five restore types,
 * en passant, both castlings and all four unpromotions. A unique result plus a
 * legal game lineage proves uniqueness without charging for essential conditions.
 */
export function enumerateRetroCandidates(
  postFen: string,
  retractingColor: Color,
): RetroCandidate[] {
  const post = parseFen(postFen);
  if (post.turn !== opposite(retractingColor)) throw new Error("RETRO_TURN_MISMATCH");
  if (!retroMaterialFeasible(post.board)) throw new Error("RETRO_MATERIAL_INVALID");
  const answers = new Map<string, RetroCandidate>();
  function consider(move: Retraction): void {
    try {
      const previous = applyRetraction(post, move);
      previous.castling = "-";
      previous.enPassant = move.special === "en-passant" ? move.currentSquare : "-";
      previous.halfmove = 0;
      previous.fullmove = 1;
      if (move.special === "castle-kingside") {
        previous.castling = retractingColor === "w" ? "K" : "k";
      } else if (move.special === "castle-queenside") {
        previous.castling = retractingColor === "w" ? "Q" : "q";
      }
      if (!retroMaterialFeasible(previous.board)) return;
      const previousFen = serializeFen(previous);
      const opponent = new Chess(
        serializeFen({ ...previous, turn: opposite(retractingColor), enPassant: "-" }),
      );
      if (opponent.isCheck()) return;
      const game = new Chess(previousFen);
      const forward = game.move({
        from: move.previousSquare,
        to: move.currentSquare,
        ...(move.special === "unpromotion" ? { promotion: move.movedPiece.type } : {}),
      });
      if (placement(game.fen()) !== placement(postFen) || game.turn() !== post.turn) return;
      answers.set(retroRetractionKey(move), {
        retraction: move,
        previousFen,
        forwardSan: forward.san,
        postFen: game.fen(),
      });
    } catch {
      // Invalid predecessor, impossible special move, or illegal forward replay.
    }
  }
  function withCapture(move: Retraction, square: Square): void {
    for (const type of capturedTypes) {
      consider({ ...move, restoredPiece: { color: opposite(retractingColor), type, square } });
    }
  }
  for (const currentSquare of squares) {
    const piece = post.board[currentSquare];
    if (!piece || piece.color !== retractingColor) continue;
    for (const previousSquare of squares) {
      if (post.board[previousSquare]) continue;
      const move: Retraction = {
        currentSquare,
        previousSquare,
        movedPiece: piece,
        restoredPiece: null,
        special: "normal",
      };
      if (!canOriginate(post.board, move)) continue;
      const changesFile = currentSquare[0] !== previousSquare[0];
      if (piece.type !== "p" || !changesFile) consider(move);
      if (piece.type !== "p" || changesFile) withCapture(move, currentSquare);
    }
    const [file, rank] = coordinates(currentSquare);
    if (piece.type === "p" && rank === (retractingColor === "w" ? 5 : 2)) {
      for (const dx of [-1, 1]) {
        if (!files[file + dx]) continue;
        const priorRank = rank + (retractingColor === "w" ? -1 : 1);
        consider({
          currentSquare,
          previousSquare: `${files[file + dx]}${priorRank + 1}`,
          movedPiece: piece,
          special: "en-passant",
          restoredPiece: {
            color: opposite(retractingColor),
            type: "p",
            square: `${files[file]}${priorRank + 1}`,
          },
        });
      }
    }
    if (promotedTypes.has(piece.type) && rank === (retractingColor === "w" ? 7 : 0)) {
      for (const dx of [-1, 0, 1]) {
        if (!files[file + dx]) continue;
        const move: Retraction = {
          currentSquare,
          previousSquare: `${files[file + dx]}${retractingColor === "w" ? 7 : 2}`,
          movedPiece: piece,
          restoredPiece: null,
          special: "unpromotion",
        };
        if (dx === 0) consider(move);
        else withCapture(move, currentSquare);
      }
    }
    if (piece.type === "k" && rank === (retractingColor === "w" ? 0 : 7)) {
      for (const [castleFile, special] of [
        [6, "castle-kingside"],
        [2, "castle-queenside"],
      ] as const) {
        if (file !== castleFile) continue;
        consider({
          currentSquare,
          previousSquare: `e${rank + 1}`,
          movedPiece: piece,
          restoredPiece: null,
          special,
        });
      }
    }
  }
  return [...answers.values()];
}

/** Counts are safe to log; returned candidates and corpus payloads are private. */
export function auditRetroCompleteness(puzzle: PuzzlePrivate): {
  candidates: number;
  accepted: number;
  missing: number;
  impossible: number;
  unique: boolean;
} {
  const candidates = new Set(
    enumerateRetroCandidates(puzzle.public.postFen, puzzle.public.retractingColor).map(
      (candidate) => retroRetractionKey(candidate.retraction),
    ),
  );
  const accepted = new Set(
    puzzle.acceptedSolutions.map((solution) => retroRetractionKey(solution.retraction)),
  );
  const missing = [...candidates].filter((key) => !accepted.has(key)).length;
  const impossible = [...accepted].filter((key) => !candidates.has(key)).length;
  return {
    candidates: candidates.size,
    accepted: accepted.size,
    missing,
    impossible,
    unique: candidates.size === 1 && missing === 0 && impossible === 0,
  };
}
