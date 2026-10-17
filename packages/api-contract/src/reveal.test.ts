import { expect, it, vi } from "vitest";
import { PuzzleRevealResponseSchema } from "./api";
import { ApiContractError, createApiClient } from "./client";

const reveal = {
  retraction: {
    currentSquare: "d5", previousSquare: "e4", movedPiece: { color: "w", type: "p" },
    restoredPiece: { color: "b", type: "p", square: "d5" }, special: "normal",
  },
  previousFen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2",
  forwardSan: "exd5", explanation: "The white pawn captured on d5.", historyConstraints: [],
};

it("fetches an earned explanation with an authenticated GET and validates the response", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ reveal }));
  const client = createApiClient({ baseUrl: "https://api.test", getToken: () => "guest-token",
    includeLocalizations: true, fetch });
  const signal = new AbortController().signal;
  expect(await client.getPuzzleReveal("case/one", "puzzle?one", signal)).toEqual({ reveal });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.test/v1/cases/case%2Fone/puzzles/puzzle%3Fone/reveal",
    { method: "GET", headers: { accept: "application/json", authorization: "Bearer guest-token",
      "x-content-locales": "1" }, signal },
  );
  expect(PuzzleRevealResponseSchema.safeParse({ reveal, acceptedSolutions: [reveal] }).success)
    .toBe(false);
  fetch.mockResolvedValueOnce(Response.json({ reveal: { explanation: "incomplete" } }));
  await expect(client.getPuzzleReveal("case", "puzzle")).rejects.toBeInstanceOf(ApiContractError);
});
