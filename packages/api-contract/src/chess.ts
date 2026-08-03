import { z } from "zod";

export const SquareSchema = z.string().regex(/^[a-h][1-8]$/);
export type Square = z.infer<typeof SquareSchema>;

export const ColorSchema = z.enum(["w", "b"]);
export type Color = z.infer<typeof ColorSchema>;

export const PieceTypeSchema = z.enum(["p", "n", "b", "r", "q", "k"]);
export type PieceType = z.infer<typeof PieceTypeSchema>;

export const PieceSchema = z.object({ color: ColorSchema, type: PieceTypeSchema }).strict();
export type Piece = z.infer<typeof PieceSchema>;

export const PlacedPieceSchema = PieceSchema.extend({ square: SquareSchema }).strict();

export const RestoredPieceSchema = z
  .object({
    color: ColorSchema,
    type: z.enum(["p", "n", "b", "r", "q"]),
    square: SquareSchema,
  })
  .strict();

export const RetractionSchema = z
  .object({
    currentSquare: SquareSchema,
    previousSquare: SquareSchema,
    movedPiece: PieceSchema,
    restoredPiece: RestoredPieceSchema.nullable(),
    special: z.enum(["normal", "castle-kingside", "castle-queenside", "en-passant", "unpromotion"]),
  })
  .strict()
  .refine((value) => value.currentSquare !== value.previousSquare, {
    message: "currentSquare and previousSquare must differ",
  })
  .superRefine((value, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    const previousFile = value.previousSquare.charCodeAt(0) - 97;
    const currentFile = value.currentSquare.charCodeAt(0) - 97;
    const previousRank = Number(value.previousSquare[1]);
    const currentRank = Number(value.currentSquare[1]);
    const direction = value.movedPiece.color === "w" ? 1 : -1;

    if (value.restoredPiece?.color === value.movedPiece.color) {
      fail("restoredPiece must belong to the opposite color");
    }

    if (
      value.special === "normal" &&
      value.restoredPiece?.square !== undefined &&
      value.restoredPiece.square !== value.currentSquare
    ) {
      fail("a normal capture restores on currentSquare");
    }

    if (value.special === "castle-kingside" || value.special === "castle-queenside") {
      if (value.movedPiece.type !== "k" || value.restoredPiece !== null) {
        fail("castling retracts a king without a restored piece");
      }
    }

    if (value.special === "en-passant") {
      const expectedRestore = `${value.currentSquare[0]}${value.previousSquare[1]}`;
      if (
        value.movedPiece.type !== "p" ||
        value.restoredPiece?.type !== "p" ||
        previousRank !== (value.movedPiece.color === "w" ? 5 : 4) ||
        Math.abs(currentFile - previousFile) !== 1 ||
        currentRank !== previousRank + direction ||
        value.restoredPiece.square !== expectedRestore
      ) {
        fail("invalid en-passant retraction metadata");
      }
    }

    if (value.special === "unpromotion") {
      const previousPromotionRank = value.movedPiece.color === "w" ? 7 : 2;
      const promotionRank = value.movedPiece.color === "w" ? 8 : 1;
      const fileDistance = Math.abs(currentFile - previousFile);
      if (
        value.movedPiece.type === "p" ||
        value.movedPiece.type === "k" ||
        previousRank !== previousPromotionRank ||
        currentRank !== promotionRank ||
        fileDistance > 1 ||
        (fileDistance === 0 && value.restoredPiece !== null) ||
        (fileDistance === 1 && value.restoredPiece?.square !== value.currentSquare)
      ) {
        fail("invalid unpromotion metadata");
      }
    }
  });
export type Retraction = z.infer<typeof RetractionSchema>;
