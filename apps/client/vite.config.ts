import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";

export type ClientBuildMode = "pages" | "android";

export function clientBuildProfile(mode: ClientBuildMode) {
  return mode === "android"
    ? { base: "/", outDir: "dist/android" }
    : { base: "/a-move-ago/", outDir: "dist/pages" };
}

export default defineConfig(({ mode }) => {
  const profile = clientBuildProfile(mode === "android" ? "android" : "pages");
  return {
    base: profile.base,
    plugins: [react() as unknown as PluginOption],
    build: {
      outDir: profile.outDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
