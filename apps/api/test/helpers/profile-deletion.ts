import type { AcceptedSolution } from "@a-move-ago/api-contract";
import type { SessionActor } from "../../src/env";
import { seedContentFixture } from "../fixtures/content";
import { issueGuest, testEnv } from "./http";

export const deletionNow = 1_785_715_200;

export interface ProfileDeletionGraph {
  playerId: string;
  telegramUserId: string;
  current: { token: string; sessionId: string; tokenHash: string };
  other: { token: string; sessionId: string };
  ancestorId: string;
  predecessorId: string;
  independentGuest: { token: string; sessionId: string };
  content: {
    caseId: string;
    puzzleId: string;
    retraction: AcceptedSolution["retraction"];
  };
  independentGuestAttemptId: string;
  linkedAttemptIds: string[];
  unrelatedPlayerId: string;
  unrelatedAttemptId: string;
  unrelatedFlowId: string;
  linkedFlowId: string;
  unlinkedFlowId: string;
}

export async function seedProfileDeletionGraph(): Promise<ProfileDeletionGraph> {
  const ancestor = await issueGuest("telegram");
  const predecessor = await issueGuest("telegram");
  const current = await issueGuest("telegram");
  const other = await issueGuest("telegram");
  const independentGuest = await issueGuest("telegram");
  const content = await seedContentFixture(testEnv.DB);

  const playerId = "delete-player";
  const telegramUserId = "987654321";
  const unrelatedPlayerId = "keep-player";
  const unrelatedSessionId = "keep-session";
  const linkedAttemptIds = ["delete-attempt-current", "delete-attempt-transferred"];
  const unrelatedAttemptId = "keep-attempt";
  const independentGuestAttemptId = "keep-independent-guest-attempt";
  const unrelatedFlowId = "keep-unrelated-linked-flow";
  const linkedFlowId = "delete-linked-flow";
  const unlinkedFlowId = "keep-unlinked-flow";

  await testEnv.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, '987654321', 'https://oauth.telegram.org',
             'telegram-subject-987654321', 'client-id',
             'Deletion Marker Ada', 'delete_marker',
             'https://example.com/delete-marker.png', ?, ?)`,
  )
    .bind(playerId, deletionNow - 100, deletionNow - 50)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO players
      (id, telegram_user_id, oidc_issuer, oidc_subject, oidc_audience,
       display_name, username, avatar_url, created_at, updated_at)
     VALUES (?, '123456789', 'https://oauth.telegram.org',
             'telegram-subject-123456789', 'client-id',
             'Keep Marker Grace', 'keep_marker',
             'https://example.com/keep-marker.png', ?, ?)`,
  )
    .bind(unrelatedPlayerId, deletionNow - 100, deletionNow - 50)
    .run();

  await testEnv.DB.prepare(
    `UPDATE sessions
        SET rotated_from_session_id = ?, revoked_at = ?
      WHERE id = ?`,
  )
    .bind(ancestor.sessionId, deletionNow - 10, predecessor.sessionId)
    .run();
  await testEnv.DB.prepare(
    `UPDATE sessions
        SET kind = 'telegram', player_id = ?, rotated_from_session_id = ?
      WHERE id = ?`,
  )
    .bind(playerId, predecessor.sessionId, current.sessionId)
    .run();
  await testEnv.DB.prepare("UPDATE sessions SET kind = 'telegram', player_id = ? WHERE id = ?")
    .bind(playerId, other.sessionId)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO sessions
      (id, player_id, token_hash, kind, channel, rotated_from_session_id,
       created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, 'telegram', 'telegram', NULL, ?, ?, NULL, ?)`,
  )
    .bind(
      unrelatedSessionId,
      unrelatedPlayerId,
      "keep-session-token-hash",
      deletionNow - 100,
      deletionNow + 86_400,
      deletionNow - 20,
    )
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`,
  )
    .bind(
      linkedAttemptIds[0],
      "11111111-1111-4111-8111-111111111111",
      current.sessionId,
      playerId,
      content.caseId,
      content.puzzle.rowId,
      JSON.stringify({ answer: "delete-current" }),
      JSON.stringify({ correct: false, marker: "delete-current" }),
      deletionNow - 5,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at)
     VALUES (?, 1, ?, ?)`,
  )
    .bind(linkedAttemptIds[0], JSON.stringify({ marker: "delete-hint" }), deletionNow - 4)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
  )
    .bind(
      linkedAttemptIds[1],
      "22222222-2222-4222-8222-222222222222",
      predecessor.sessionId,
      content.caseId,
      content.puzzle.rowId,
      JSON.stringify({ answer: "delete-transferred" }),
      JSON.stringify({ correct: false, marker: "delete-transferred" }),
      deletionNow - 6,
    )
    .run();
  await testEnv.DB.prepare("UPDATE attempts SET player_id = ? WHERE id = ?")
    .bind(playerId, linkedAttemptIds[1])
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`,
  )
    .bind(
      unrelatedAttemptId,
      "33333333-3333-4333-8333-333333333333",
      unrelatedSessionId,
      unrelatedPlayerId,
      content.caseId,
      content.puzzle.rowId,
      JSON.stringify({ answer: "keep" }),
      JSON.stringify({ correct: false, marker: "keep" }),
      deletionNow - 3,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at)
     VALUES (?, 1, ?, ?)`,
  )
    .bind(unrelatedAttemptId, JSON.stringify({ marker: "keep-hint" }), deletionNow - 2)
    .run();

  await testEnv.DB.prepare(
    `INSERT INTO auth_flows
      (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
       expires_at, callback_claimed_at, player_id, handoff_hash,
       handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
     VALUES (?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(
      linkedFlowId,
      "delete-linked-flow-state",
      predecessor.sessionId,
      "delete-linked-flow-nonce",
      "delete-linked-flow-verifier",
      deletionNow + 300,
      deletionNow - 20,
      playerId,
      "delete-linked-flow-handoff",
      deletionNow + 200,
      deletionNow - 30,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO auth_flows
      (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
       expires_at, callback_claimed_at, player_id, handoff_hash,
       handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
     VALUES (?, ?, ?, 'web', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  )
    .bind(
      unlinkedFlowId,
      "keep-unlinked-flow-state",
      independentGuest.sessionId,
      "keep-unlinked-flow-nonce",
      "keep-unlinked-flow-verifier",
      deletionNow + 300,
      deletionNow - 30,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO auth_flows
      (id, state_hash, guest_session_id, channel, nonce, pkce_verifier,
       expires_at, callback_claimed_at, player_id, handoff_hash,
       handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
     VALUES (?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
    .bind(
      unrelatedFlowId,
      "keep-unrelated-linked-flow-state",
      independentGuest.sessionId,
      "keep-unrelated-linked-flow-nonce",
      "keep-unrelated-linked-flow-verifier",
      deletionNow + 300,
      deletionNow - 20,
      unrelatedPlayerId,
      "keep-unrelated-linked-flow-handoff",
      deletionNow + 200,
      deletionNow - 30,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO content_imports
      (digest, case_id, source_name, imported_at, published_at)
     VALUES (?, ?, 'profile-deletion-fixture', ?, ?)`,
  )
    .bind("f".repeat(64), content.caseId, deletionNow - 40, deletionNow - 35)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO attempts
      (id, attempt_uuid, session_id, player_id, case_id, puzzle_id,
       normalized_answer_json, correct, response_json, hints_used, submitted_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 0, ?, 0, ?)`,
  )
    .bind(
      independentGuestAttemptId,
      crypto.randomUUID(),
      independentGuest.sessionId,
      content.caseId,
      content.puzzle.rowId,
      JSON.stringify({ source: "independent-guest" }),
      JSON.stringify({ correct: false }),
      deletionNow,
    )
    .run();

  const currentRow = await testEnv.DB.prepare("SELECT token_hash FROM sessions WHERE id = ?")
    .bind(current.sessionId)
    .first<{ token_hash: string }>();
  if (!currentRow) throw new Error("Current deletion session is missing.");

  return {
    playerId,
    telegramUserId,
    current: {
      token: current.token,
      sessionId: current.sessionId,
      tokenHash: currentRow.token_hash,
    },
    other: { token: other.token, sessionId: other.sessionId },
    ancestorId: ancestor.sessionId,
    predecessorId: predecessor.sessionId,
    independentGuest: {
      token: independentGuest.token,
      sessionId: independentGuest.sessionId,
    },
    content: {
      caseId: content.caseId,
      puzzleId: content.puzzle.rowId,
      retraction: content.puzzle.solution.retraction,
    },
    independentGuestAttemptId,
    linkedAttemptIds,
    unrelatedPlayerId,
    unrelatedAttemptId,
    unrelatedFlowId,
    linkedFlowId,
    unlinkedFlowId,
  };
}

export function telegramDeletionActor(graph: ProfileDeletionGraph): SessionActor {
  return {
    sessionId: graph.current.sessionId,
    playerId: graph.playerId,
    kind: "telegram",
    channel: "telegram",
  };
}
