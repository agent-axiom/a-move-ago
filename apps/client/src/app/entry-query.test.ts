import { describe, expect, it } from "vitest";
import { parseEntryQuery, stripAuthReturn } from "./entry-query";

const validHandoff = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

describe("entry query", () => {
  it("reads allowlisted values without reading the Telegram fragment", () => {
    const url = new URL(
      `https://agent-axiom.github.io/a-move-ago/?case=2026-08-03&handoff=${validHandoff}` +
        "#tgWebAppData=raw%2Bfragment&handoff=fragment-value",
    );

    expect(parseEntryQuery(url)).toEqual({
      caseDate: "2026-08-03",
      handoff: validHandoff,
      authError: null,
    });
  });

  it.each(["2024-02-29", "2000-02-29", "2026-08-03"])(
    "accepts the real calendar date %s",
    (caseDate) => {
      expect(parseEntryQuery(new URL(`https://x.test/?case=${caseDate}`)).caseDate).toBe(caseDate);
    },
  );

  it.each(["2023-02-29", "1900-02-29", "2026-02-30", "2026-13-01", "2026-8-03", ""])(
    "rejects the invalid calendar date %j",
    (caseDate) => {
      expect(parseEntryQuery(new URL(`https://x.test/?case=${caseDate}`)).caseDate).toBeNull();
    },
  );

  it("accepts only one exact 43-character handoff", () => {
    expect(validHandoff).toHaveLength(43);
    expect(parseEntryQuery(new URL(`https://x.test/?handoff=${validHandoff}`)).handoff).toBe(
      validHandoff,
    );
    expect(
      parseEntryQuery(new URL(`https://x.test/?handoff=${"a".repeat(42)}`)).handoff,
    ).toBeNull();
    expect(
      parseEntryQuery(new URL(`https://x.test/?handoff=${"a".repeat(44)}`)).handoff,
    ).toBeNull();
    expect(parseEntryQuery(new URL("https://x.test/?handoff=invalid%2Bvalue")).handoff).toBeNull();
  });

  it("rejects duplicate sensitive and case values even when duplicates match", () => {
    const duplicate = new URL(
      `https://x.test/?case=2026-08-03&case=2026-08-03&handoff=${validHandoff}` +
        `&handoff=${validHandoff}&authError=access_denied&authError=access_denied`,
    );

    expect(parseEntryQuery(duplicate)).toEqual({
      caseDate: null,
      handoff: null,
      authError: null,
    });
  });

  it("allowlists only the fixed provider denial", () => {
    expect(parseEntryQuery(new URL("https://x.test/?authError=access_denied")).authError).toBe(
      "access_denied",
    );
    expect(parseEntryQuery(new URL("https://x.test/?authError=server_error")).authError).toBeNull();
    expect(parseEntryQuery(new URL("https://x.test/?authError=")).authError).toBeNull();
  });

  it("strips auth return values while preserving path, unrelated query and fragment", () => {
    const url = new URL(
      `https://x.test/a-move-ago/play?case=2026-08-03&handoff=${validHandoff}` +
        "&keep=raw%2Bvalue&authError=access_denied#tgWebAppData=raw%2Bfragment",
    );

    expect(stripAuthReturn(url)).toBe(
      "/a-move-ago/play?case=2026-08-03&keep=raw%2Bvalue#tgWebAppData=raw%2Bfragment",
    );
    expect(url.searchParams.get("handoff")).toBe(validHandoff);
    expect(url.hash).toBe("#tgWebAppData=raw%2Bfragment");
  });
});
