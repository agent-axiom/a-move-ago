import { describe, expect, it, vi } from "vitest";
import { executeD1Batch } from "./d1-http";
import type { D1Statement } from "./import-plan";

const statements: D1Statement[] = [
  { sql: "INSERT INTO example (id, value) VALUES (?, ?)", params: ["row-1", "private-value"] },
  { sql: "UPDATE example SET value = ? WHERE id = ?", params: ["next-value", "row-1"] },
];

describe("executeD1Batch", () => {
  it("uses the D1 REST URL, bearer token, and exact batch body", async () => {
    const payload = { success: true, result: [{ success: true }, { success: true }] };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      executeD1Batch({
        accountId: "account-id",
        databaseId: "database-id",
        apiToken: "secret-token",
        statements,
        fetch: fetchMock,
      }),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query",
      {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ batch: statements }),
      },
    );
  });

  it("rejects non-success HTTP responses without exposing the response body", async () => {
    const fetchMock = vi.fn(
      async () => new Response("private upstream diagnostic", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(
      executeD1Batch({
        accountId: "account-id",
        databaseId: "database-id",
        apiToken: "secret-token",
        statements,
        fetch: fetchMock,
      }),
    ).rejects.toThrow("D1 query failed with HTTP 403");
  });

  it("sanitizes invalid JSON response errors", async () => {
    const fetchMock = vi.fn(
      async () => new Response("private-response-body"),
    ) as unknown as typeof fetch;

    const failure = await executeD1Batch({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      statements,
      fetch: fetchMock,
    }).catch((error: unknown) => error);

    expect(String(failure)).toBe("Error: D1 query returned invalid JSON");
    expect(String(failure)).not.toContain("private-response-body");
  });

  it("sanitizes rejected fetch errors", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("injected-request-secret");
    }) as unknown as typeof fetch;

    const failure = await executeD1Batch({
      accountId: "account-id",
      databaseId: "database-id",
      apiToken: "secret-token",
      statements,
      fetch: fetchMock,
    }).catch((error: unknown) => error);

    expect(String(failure)).toBe("Error: D1 query request failed");
    expect(String(failure)).not.toContain("injected-request-secret");
  });
});
