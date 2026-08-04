import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWriteWorkerSecrets, workerSecretsDocument } from "./write-worker-secrets";

const secretEnvironment = {
  SESSION_PEPPER: "0123456789abcdef0123456789abcdef",
  TELEGRAM_BOT_TOKEN: "bot-token-private",
  TELEGRAM_OIDC_CLIENT_SECRET: "oidc-secret-private",
};

describe("workerSecretsDocument", () => {
  it("reads and serializes exactly the three application secrets", () => {
    const reads: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      {
        ...secretEnvironment,
        CLOUDFLARE_API_TOKEN: "cloudflare-token-must-not-be-read",
        CLOUDFLARE_ACCOUNT_ID: "cloudflare-account-must-not-be-read",
        D1_DATABASE_ID: "database-id-must-not-be-read",
      },
      {
        get(target, property, receiver) {
          if (typeof property === "string") reads.push(property);
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );

    const document = workerSecretsDocument(env);

    expect(JSON.parse(document)).toEqual(secretEnvironment);
    expect(new Set(reads)).toEqual(new Set(Object.keys(secretEnvironment)));
    expect(document).not.toContain("cloudflare-token-must-not-be-read");
    expect(document).not.toContain("cloudflare-account-must-not-be-read");
    expect(document).not.toContain("database-id-must-not-be-read");
  });

  it.each(Object.keys(secretEnvironment))("rejects missing or blank %s", (key) => {
    const missing = { ...secretEnvironment } as Record<string, string | undefined>;
    delete missing[key];
    expect(() => workerSecretsDocument(missing)).toThrow(key);
    expect(() => workerSecretsDocument({ ...secretEnvironment, [key]: " \t " })).toThrow(key);
  });

  it("requires a SESSION_PEPPER of at least 32 UTF-8 bytes", () => {
    expect(() =>
      workerSecretsDocument({ ...secretEnvironment, SESSION_PEPPER: "x".repeat(31) }),
    ).toThrow(/32 bytes/i);
    expect(() =>
      workerSecretsDocument({ ...secretEnvironment, SESSION_PEPPER: "я".repeat(16) }),
    ).not.toThrow();
  });
});

describe("runWriteWorkerSecrets", () => {
  it.each([
    [],
    ["--target"],
    ["target.json"],
    ["--target", "one.json", "--target", "two.json"],
    ["--target", "target.json", "--unknown", "value"],
    ["--source", "target.json"],
  ])("accepts only --target <path>: %j", async (...args) => {
    await expect(
      runWriteWorkerSecrets(args as string[], { env: secretEnvironment }),
    ).rejects.toThrow("Usage:");
  });

  it("writes JSON with mode 0600 and logs only the target path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a-move-ago-worker-secrets-"));
    const targetPath = join(directory, "worker-secrets.json");
    const log = vi.fn();
    try {
      await writeFile(targetPath, "old", { mode: 0o644 });
      await chmod(targetPath, 0o644);

      await runWriteWorkerSecrets(["--target", "worker-secrets.json"], {
        cwd: directory,
        env: secretEnvironment,
        log,
      });

      expect(JSON.parse(await readFile(targetPath, "utf8"))).toEqual(secretEnvironment);
      expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(targetPath);
      for (const value of Object.values(secretEnvironment)) {
        expect(JSON.stringify(log.mock.calls)).not.toContain(value);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
