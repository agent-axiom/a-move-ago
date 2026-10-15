import { describe, expect, it } from "vitest";
import { type ArchiveResponse, ArchiveResponseSchema } from "./api";
import { ApiContractError, createApiClient } from "./client";

const catalog: ArchiveResponse = {
  today: "2026-10-15",
  startsOn: "2026-09-10",
  cases: [
    {
      id: "case-october",
      date: "2026-10-14",
      slug: "october-case",
      title: "October case",
      puzzleCount: 2,
      solvedPuzzles: 1,
      completed: false,
    },
    {
      id: "case-september",
      date: "2026-09-10",
      slug: "september-case",
      title: "September case",
      puzzleCount: 1,
      solvedPuzzles: 1,
      completed: true,
    },
  ],
};

function firstCase(value: ArchiveResponse) {
  const first = value.cases[0];
  if (!first) throw new Error("Expected catalog fixture");
  return first;
}

describe("archive contract", () => {
  it("accepts public metadata, actor progress, and an empty published catalog", () => {
    expect(ArchiveResponseSchema.parse(catalog)).toEqual(catalog);
    expect(
      ArchiveResponseSchema.parse({ today: "2026-10-15", startsOn: null, cases: [] }),
    ).toEqual({ today: "2026-10-15", startsOn: null, cases: [] });
  });

  it("rejects private fields at both response and case levels", () => {
    expect(
      ArchiveResponseSchema.safeParse({ ...catalog, acceptedSolutions: [] }).success,
    ).toBe(false);
    expect(
      ArchiveResponseSchema.safeParse({
        ...catalog,
        cases: [{ ...firstCase(catalog), public_json: "private-puzzle-data" }],
      }).success,
    ).toBe(false);
  });

  const invalidCases: [string, (value: ArchiveResponse) => void][] = [
    [
      "future dates",
      (value) => {
        firstCase(value).date = "2026-10-16";
      },
    ],
    [
      "ascending dates",
      (value) => {
        value.cases.reverse();
      },
    ],
    [
      "duplicate cases",
      (value) => {
        value.cases.push(structuredClone(firstCase(value)));
      },
    ],
    [
      "incorrect start date",
      (value) => {
        value.startsOn = "2026-09-09";
      },
    ],
    [
      "missing start date",
      (value) => {
        value.startsOn = null;
      },
    ],
    [
      "empty cases with a start date",
      (value) => {
        value.cases = [];
      },
    ],
    [
      "impossible dates",
      (value) => {
        firstCase(value).date = "2026-02-30";
      },
    ],
    [
      "empty cases",
      (value) => {
        firstCase(value).puzzleCount = 0;
      },
    ],
    [
      "negative progress",
      (value) => {
        firstCase(value).solvedPuzzles = -1;
      },
    ],
    [
      "excess progress",
      (value) => {
        firstCase(value).solvedPuzzles = 3;
      },
    ],
    [
      "premature completion",
      (value) => {
        firstCase(value).completed = true;
      },
    ],
    [
      "missing completion",
      (value) => {
        firstCase(value).solvedPuzzles = 2;
      },
    ],
  ];
  it.each(invalidCases)("rejects %s", (_label, mutate) => {
    const value = structuredClone(catalog);
    mutate(value);
    expect(ArchiveResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("ApiClient.getArchive", () => {
  it("authenticates a read-only catalog request and forwards cancellation", async () => {
    const requests: { url: RequestInfo | URL; init?: RequestInit }[] = [];
    const api = createApiClient({
      baseUrl: "https://api.test/",
      getToken: () => "guest-token",
      fetch: async (url, init) => {
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        return Response.json(catalog);
      },
    });
    const signal = new AbortController().signal;
    await expect(api.getArchive(signal)).resolves.toEqual(catalog);
    expect(requests).toEqual([
      {
        url: "https://api.test/v1/archive",
        init: {
          method: "GET",
          headers: { accept: "application/json", authorization: "Bearer guest-token" },
          signal,
        },
      },
    ]);
  });

  it("rejects malformed or future catalog metadata before returning it to the UI", async () => {
    const api = createApiClient({
      baseUrl: "https://api.test",
      getToken: () => "guest-token",
      fetch: async () => Response.json({ ...catalog, today: "2026-09-01" }),
    });
    await expect(api.getArchive()).rejects.toBeInstanceOf(ApiContractError);
  });
});
