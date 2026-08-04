import { describe, expect, it } from "vitest";
import { clientBuildProfile } from "../vite.config";

describe("client build profiles", () => {
  it("uses the repository base for Pages", () => {
    expect(clientBuildProfile("pages")).toEqual({
      base: "/a-move-ago/",
      outDir: "dist/pages",
    });
  });

  it("uses the root base for the Android web artifact", () => {
    expect(clientBuildProfile("android")).toEqual({
      base: "/",
      outDir: "dist/android",
    });
  });
});
