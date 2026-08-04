import type { Env } from "./env";

export async function cleanupExpired(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM auth_flows
        WHERE expires_at < ?
           OR (handoff_expires_at IS NOT NULL AND handoff_expires_at < ?)`,
    ).bind(now - 86_400, now - 86_400),
    env.DB.prepare(
      `DELETE FROM attempts
        WHERE player_id IS NULL
          AND session_id IN (
            SELECT id FROM sessions WHERE expires_at < ? OR revoked_at < ?
          )`,
    ).bind(now, now - 2_592_000),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(
      now,
      now - 2_592_000,
    ),
    env.DB.prepare("DELETE FROM hint_events WHERE created_at < ?").bind(now - 31_536_000),
  ]);
}
