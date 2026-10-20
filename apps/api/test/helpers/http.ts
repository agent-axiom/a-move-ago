import { env } from "cloudflare:workers";
import { SessionIssuedSchema } from "@a-move-ago/api-contract";
import { app } from "../../src/app";
import { hashSessionToken } from "../../src/crypto/opaque-token";
import type { Env } from "../../src/env";
import { withFakeRateLimiters } from "../fake-rate-limiters";
import { seedContentFixture } from "../fixtures/content";

export const testEnv = withFakeRateLimiters(env as Env);

export type JsonRequestInit = {
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
};

export async function requestJson(
  path: string,
  init: JsonRequestInit = {},
  requestEnv: Env = testEnv,
) {
  const headers = new Headers(init.headers);
  const requestInit: RequestInit = { headers };
  if (init.method !== undefined) requestInit.method = init.method;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  }
  const response = await app.fetch(new Request(`https://api.test${path}`, requestInit), requestEnv);
  return { response, body: (await response.json()) as unknown };
}

export async function authenticatedJson(
  path: string,
  token: string,
  init: JsonRequestInit = {},
  requestEnv: Env = testEnv,
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await requestJson(path, { ...init, headers }, requestEnv);
}

export async function issueGuest(channel: "web" | "telegram" | "android" = "web") {
  const result = await requestJson("/v1/sessions/guest", {
    method: "POST",
    body: { channel },
  });
  const issued = SessionIssuedSchema.parse(result.body);
  const row = await testEnv.DB.prepare("SELECT id FROM sessions WHERE token_hash = ?")
    .bind(await hashSessionToken(issued.token, testEnv.SESSION_PEPPER))
    .first<{ id: string }>();
  if (!row) throw new Error("Issued guest session was not persisted.");
  return { token: issued.token, sessionId: row.id, issued, response: result.response };
}

export async function seedAttempt(input: { sessionId: string; attemptId: string }) {
  const fixture = await seedContentFixture(testEnv.DB);
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
  )
    .bind(
      input.attemptId,
      `${input.attemptId}-uuid`,
      input.sessionId,
      fixture.caseId,
      fixture.puzzle.rowId,
      JSON.stringify({ answer: "before-login" }),
      JSON.stringify({ correct: false }),
      1_785_715_200,
    )
    .run();
  return fixture;
}

export async function resetDatabase() {
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_fail_mini_app_revoke").run();
  await testEnv.DB.prepare("DROP TRIGGER IF EXISTS test_ignore_mini_app_revoke").run();
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM puzzle_feedback"),
    testEnv.DB.prepare("DELETE FROM gameplay_events"),
    testEnv.DB.prepare("DELETE FROM auth_flows"),
    testEnv.DB.prepare("DELETE FROM hint_events"),
    testEnv.DB.prepare("DELETE FROM attempts"),
    testEnv.DB.prepare("DELETE FROM content_imports"),
    testEnv.DB.prepare("DELETE FROM daily_case_puzzles"),
    testEnv.DB.prepare("DELETE FROM puzzle_hints"),
    testEnv.DB.prepare("DELETE FROM puzzle_solutions"),
    testEnv.DB.prepare("DELETE FROM daily_cases"),
    testEnv.DB.prepare("DELETE FROM puzzles"),
    testEnv.DB.prepare("DELETE FROM sessions"),
    testEnv.DB.prepare("DELETE FROM players"),
  ]);
}
