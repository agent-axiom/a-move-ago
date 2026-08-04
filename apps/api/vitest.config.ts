import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SESSION_PEPPER: "test-session-pepper-at-least-32-bytes",
          TELEGRAM_BOT_TOKEN: "123456:test-bot-secret",
          TELEGRAM_OIDC_CLIENT_SECRET: "test-oidc-client-secret",
          ENVIRONMENT: "test",
          API_ORIGIN: "https://api.test",
          WEB_AUTH_RETURN_URL: "https://agent-axiom.github.io/a-move-ago/",
          ANDROID_AUTH_RETURN_URL: "amoveago-debug://auth",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
});
