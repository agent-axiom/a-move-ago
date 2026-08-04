import { expect, it } from "vitest";
import { squareAt } from "./board-order";

it("maps the visual corners for both orientations", () => {
  expect(squareAt("white", 0, 0)).toBe("a8");
  expect(squareAt("white", 7, 7)).toBe("h1");
  expect(squareAt("black", 0, 0)).toBe("h1");
  expect(squareAt("black", 7, 7)).toBe("a8");
});
