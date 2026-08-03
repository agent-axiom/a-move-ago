import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFen, serializeFen } from "./fen";

const postFen = "rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";

describe("FEN", () => {
  it("round-trips all six FEN fields", () => {
    expect(serializeFen(parseFen(postFen))).toBe(postFen);
  });
  it("maps d5 to a white pawn", () => {
    expect(parseFen(postFen).board.d5).toEqual({ color: "w", type: "p" });
  });
  it("rejects malformed FEN", () => {
    expect(() => parseFen("8/8/8")).toThrow("Invalid FEN");
    expect(() => parseFen("4k3/8/8/8/8/8/8/4K3 w - - 12x 34y")).toThrow("Invalid FEN");
    expect(() => parseFen("4k3/8/8/8/8/8/8/4K3 w - - 9007199254740992 34")).toThrow("Invalid FEN");
  });
  it("round-trips generated legal move counters", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 1, max: 500 }),
        (halfmove, fullmove) => {
          const fen = postFen.replace(/0 2$/, `${halfmove} ${fullmove}`);
          expect(serializeFen(parseFen(fen))).toBe(fen);
        },
      ),
    );
  });
});
