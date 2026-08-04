import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173/a-move-ago/",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run preview:pages -- --port 4173",
    url: "http://127.0.0.1:4173/a-move-ago/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
