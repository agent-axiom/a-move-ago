import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { Response as MiniflareResponse } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Intercept below native Workers fetch so receiver/Request errors stay observable.
        outboundService: async (request) => {
          if (request.url !== "https://oauth.telegram.org/token" || request.method !== "POST") {
            throw new Error("Unexpected outbound request in API tests");
          }
          const code = new URLSearchParams(await request.text()).get("code");
          if (code === "native-fetch-invalid-grant") {
            return MiniflareResponse.json({ error: "invalid_grant" });
          }
          const redirectStatus = /^native-fetch-redirect-(301|302|303|307|308)$/.exec(code ?? "");
          if (redirectStatus) {
            return new MiniflareResponse(null, {
              status: Number(redirectStatus[1]),
              headers: { location: "https://unexpected-redirect.test/token" },
            });
          }
          throw new Error("Unexpected synthetic authorization code in API tests");
        },
        bindings: {
          SESSION_PEPPER: "test-session-pepper-at-least-32-bytes",
          TELEGRAM_BOT_TOKEN: "123456:test-bot-secret",
          TELEGRAM_OIDC_CLIENT_SECRET: "test-oidc-client-secret",
          ENVIRONMENT: "test",
          API_ORIGIN: "https://api.test",
          WEB_AUTH_RETURN_URL: "https://agent-axiom.github.io/a-move-ago/",
          ANDROID_AUTH_RETURN_URL: "amoveago-debug://auth",
          ANDROID_PACKAGE_NAME: "com.agentaxiom.amoveago",
          ANDROID_SHA256_CERT_FINGERPRINTS:
            "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
});
