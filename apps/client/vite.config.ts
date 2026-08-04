import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type PluginOption } from "vite";
import { type ClientBuildMode, hostHeadPlugin } from "./build/telegram-script-plugin";

export function clientBuildProfile(mode: ClientBuildMode) {
  return mode === "android"
    ? { base: "/", outDir: "dist/android" }
    : { base: "/a-move-ago/", outDir: "dist/pages" };
}

export default defineConfig(({ mode }) => {
  const buildMode: ClientBuildMode = mode === "android" ? "android" : "pages";
  const profile = clientBuildProfile(buildMode);
  const environment = loadEnv(mode, ".", "");
  return {
    base: profile.base,
    plugins: [
      hostHeadPlugin(
        buildMode,
        environment.VITE_API_BASE_URL ?? "",
        environment.VITE_ANDROID_ALLOW_DEBUG_SCHEME === "true",
      ),
      react() as unknown as PluginOption,
    ],
    build: {
      outDir: profile.outDir,
      emptyOutDir: true,
      sourcemap: false,
    },
  };
});
