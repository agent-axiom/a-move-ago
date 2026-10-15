import { describe, expect, it } from "vitest";
import { clientBuildProfile } from "../vite.config";

describe("client build profiles", () => {
  it("uses relative assets for Pages at either a repository path or a custom domain", () => {
    expect(clientBuildProfile("pages")).toEqual({
      base: "./",
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
