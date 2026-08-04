import type { D1Statement } from "./import-plan";

export async function executeD1Batch(input: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  statements: D1Statement[];
  fetch: typeof fetch;
}) {
  let response: Response;
  try {
    response = await input.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ batch: input.statements }),
      },
    );
  } catch {
    throw new Error("D1 query request failed");
  }
  if (!response.ok) throw new Error(`D1 query failed with HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("D1 query returned invalid JSON");
  }
}
