import type { Square } from "@a-move-ago/api-contract";
import { parseFen } from "@a-move-ago/game-core";
import { describe, expect, it } from "vitest";
import { buildPreview, draftReducer, initialDraft } from "./draft";

function choose(fen: string, current: string, previous: string) {
  const post = parseFen(fen);
  let state = draftReducer(post, "w", initialDraft, {
    type: "select-square",
    square: current as Square,
  });
  state = draftReducer(post, "w", state, {
    type: "select-square",
    square: previous as Square,
  });
  return { post, state };
}

describe("retraction draft", () => {
  it("previews an ordinary capture restored on the arrival square", () => {
    const { post, state: selected } = choose(
      "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2",
      "d5",
      "e4",
    );
    const state = draftReducer(post, "w", selected, { type: "set-capture", pieceType: "p" });
    const preview = buildPreview(post, "w", state);
    expect(preview.ok && preview.retraction).toMatchObject({
      currentSquare: "d5",
      previousSquare: "e4",
      restoredPiece: { color: "b", type: "p", square: "d5" },
      special: "normal",
    });
    expect(preview.ok && preview.previous.board.e4).toEqual({ color: "w", type: "p" });
  });

  it("delegates castling, en-passant and unpromotion previews to game-core", () => {
    const castle = choose("r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1", "g1", "e1");
    const castleState = draftReducer(castle.post, "w", castle.state, {
      type: "set-special",
      special: "castle-kingside",
    });
    const castlePreview = buildPreview(castle.post, "w", castleState);
    expect(castlePreview.ok && castlePreview.previous.board.h1).toEqual({ color: "w", type: "r" });

    const passant = choose("4k3/8/3P4/8/8/8/8/4K3 b - - 0 1", "d6", "e5");
    const passantState = draftReducer(passant.post, "w", passant.state, {
      type: "set-special",
      special: "en-passant",
    });
    const passantPreview = buildPreview(passant.post, "w", passantState);
    expect(passantPreview.ok && passantPreview.previous.board.d5).toEqual({
      color: "b",
      type: "p",
    });

    const promotion = choose("Q3k3/8/8/8/8/8/8/4K3 b - - 0 1", "a8", "a7");
    const promotionState = draftReducer(promotion.post, "w", promotion.state, {
      type: "set-special",
      special: "unpromotion",
    });
    const promotionPreview = buildPreview(promotion.post, "w", promotionState);
    expect(promotionPreview.ok && promotionPreview.previous.board.a7).toEqual({
      color: "w",
      type: "p",
    });
  });

  it("does not select an opponent piece as the last mover", () => {
    const post = parseFen("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
    expect(draftReducer(post, "w", initialDraft, { type: "select-square", square: "e8" })).toEqual(
      initialDraft,
    );
  });

  it.each([
    {
      label: "castling with a rook as the moved piece",
      fen: "4k3/8/8/8/8/8/8/K4RR1 b - - 0 1",
      current: "g1",
      previous: "e1",
      special: "castle-kingside" as const,
    },
    {
      label: "en passant from the wrong rank",
      fen: "4k3/8/3P4/8/8/8/8/4K3 b - - 0 1",
      current: "d6",
      previous: "e4",
      special: "en-passant" as const,
    },
    {
      label: "unpromotion across multiple files",
      fen: "k6Q/8/8/8/8/8/8/4K3 b - - 0 1",
      current: "h8",
      previous: "a7",
      special: "unpromotion" as const,
    },
  ])("rejects $label before an attempt can be submitted", ({ fen, current, previous, special }) => {
    const selected = choose(fen, current, previous);
    const state = draftReducer(selected.post, "w", selected.state, {
      type: "set-special",
      special,
    });

    expect(buildPreview(selected.post, "w", state)).toEqual({
      ok: false,
      reason: "The retraction details do not match the selected squares.",
    });
  });
});
