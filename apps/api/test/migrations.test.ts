import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";

const gameplayTables = [
  "players",
  "sessions",
  "puzzles",
  "puzzle_solutions",
  "puzzle_hints",
  "daily_cases",
  "daily_case_puzzles",
  "attempts",
  "hint_events",
  "content_imports",
  "case_localizations",
  "puzzle_localizations",
  "gameplay_events",
];
const digest = "a".repeat(64);
const migrationNames = [
  { name: "0001_initial.sql" },
  { name: "0002_telegram_auth.sql" },
  { name: "0003_content_localizations.sql" },
  { name: "0004_gameplay_progress.sql" },
];
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
type SqlCase = [sql: string, values?: unknown[]];

async function execute(sql: string, values: unknown[] = []) {
  const statement = env.DB.prepare(sql);
  return await (values.length > 0 ? statement.bind(...values) : statement).run();
}

async function results<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
  const statement = env.DB.prepare(sql);
  return (await (values.length > 0 ? statement.bind(...values) : statement).all<T>()).results;
}

async function rejects(sql: string, values: unknown[] = []) {
  await expect(execute(sql, values)).rejects.toThrow();
}

function ids() {
  const suffix = crypto.randomUUID();
  return {
    attempt: `attempt-${suffix}`,
    case: `case-${suffix}`,
    otherCase: `other-case-${suffix}`,
    guest: `guest-${suffix}`,
    otherGuest: `other-guest-${suffix}`,
    player: `player-${suffix}`,
    otherPlayer: `other-player-${suffix}`,
    puzzle: `puzzle-${suffix}`,
    otherPuzzle: `other-puzzle-${suffix}`,
    telegram: `telegram-${suffix}`,
  };
}

async function player(id: string) {
  await execute(
    `INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1)`,
    [id, `telegram-user-${id}`, "Player"],
  );
}

async function session(id: string, kind: "guest" | "telegram", playerId: string | null) {
  await execute(
    `INSERT INTO sessions
       (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'web', 1, 2, 1)`,
    [id, playerId, `token-${id}`, kind],
  );
}

async function puzzle(id: string, contentDigest = digest) {
  await execute(
    `INSERT INTO puzzles
       (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'published', '{"prompt":"Solve"}', 'test', 'CC0', 1, 1)`,
    [id, `content-${id}`, contentDigest],
  );
}

async function dailyCase(id: string, date = "2026-08-03") {
  await execute(
    `INSERT INTO daily_cases
       (id, case_date, slug, title, status, published_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Case', 'published', 1, 1, 1)`,
    [id, date, `slug-${id}`],
  );
}

async function membership(caseId: string, puzzleId: string, position = 1) {
  await execute(
    `INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json)
     VALUES (?, ?, ?, '{"act":1}')`,
    [caseId, puzzleId, position],
  );
}

async function attempt(
  id: string,
  sessionId: string | null,
  playerId: string | null,
  caseId: string,
  puzzleId: string,
  attemptUuid = `uuid-${id}`,
) {
  await execute(
    `INSERT INTO attempts
       (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, '{"answer":1}', 1, '{"result":"ok"}', 1)`,
    [id, attemptUuid, sessionId, playerId, caseId, puzzleId],
  );
}

async function fixture() {
  const value = ids();
  await player(value.player);
  await player(value.otherPlayer);
  await session(value.guest, "guest", null);
  await session(value.telegram, "telegram", value.player);
  await session(value.otherGuest, "guest", null);
  await puzzle(value.puzzle);
  await puzzle(value.otherPuzzle, "b".repeat(64));
  await dailyCase(value.case);
  await dailyCase(value.otherCase, "2026-08-04");
  await membership(value.case, value.puzzle);
  return value;
}

beforeEach(async () => {
  await execute("PRAGMA foreign_keys = ON");
  for (const table of [
    "auth_flows",
    "hint_events",
    "attempts",
    "content_imports",
    "daily_case_puzzles",
    "puzzle_hints",
    "puzzle_solutions",
    "sessions",
    "daily_cases",
    "puzzles",
    "players",
  ]) {
    await execute(`DELETE FROM ${table}`);
  }
});

describe("D1 migrations", () => {
  it("creates the gameplay schema with puzzle content digests", async () => {
    const tables = await results<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const puzzleColumns = await results<{ name: string }>("PRAGMA table_info(puzzles)");

    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(gameplayTables));
    expect(puzzleColumns.map((column) => column.name)).toContain("content_digest");
  });

  it("parenthesizes trigger CASE expressions for the remote D1 parser", () => {
    const initialMigration = testEnv.TEST_MIGRATIONS.find(
      (migration) => migration.name === "0001_initial.sql",
    );
    const triggerSql = initialMigration?.queries.join("\n") ?? "";

    expect(triggerSql).toContain("CREATE TRIGGER attempts_validate_session_before_insert");
    expect(triggerSql).not.toMatch(/\bSELECT\s+CASE\b/);
    expect(triggerSql.match(/\bSELECT\s+\(CASE\b/g)).toHaveLength(4);
  });

  it("starts the first test with no gameplay rows", async () => {
    expect(await results<{ count: number }>("SELECT count(*) AS count FROM players")).toEqual([
      { count: 0 },
    ]);
  });

  it("starts another test with no gameplay rows", async () => {
    expect(await results<{ count: number }>("SELECT count(*) AS count FROM attempts")).toEqual([
      { count: 0 },
    ]);
  });

  it("records each migration once and reapplies them as a no-op", async () => {
    expect(await results<{ name: string }>("SELECT name FROM d1_migrations ORDER BY name")).toEqual(
      migrationNames,
    );

    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    expect(await results<{ name: string }>("SELECT name FROM d1_migrations ORDER BY name")).toEqual(
      migrationNames,
    );
  });

  it("stores hashed one-time OIDC state and handoff data", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(auth_flows)").all<{ name: string }>();
    const names = columns.results.map((column) => column.name);

    expect(names).toEqual([
      "id",
      "state_hash",
      "guest_session_id",
      "channel",
      "nonce",
      "pkce_verifier",
      "expires_at",
      "callback_claimed_at",
      "player_id",
      "handoff_hash",
      "handoff_expires_at",
      "handoff_consumed_at",
      "handoff_session_id",
      "created_at",
    ]);
    expect(names).not.toContain("state");
    expect(names).not.toContain("handoff_code");
  });

  it("enforces auth-flow references, state checks, uniqueness, and lookup indexes", async () => {
    const foreignKeys = await results<{
      from: string;
      on_delete: string;
      table: string;
      to: string;
    }>("PRAGMA foreign_key_list(auth_flows)");
    expect(
      foreignKeys
        .map(({ from, on_delete, table, to }) => ({ from, on_delete, table, to }))
        .sort((left, right) => left.from.localeCompare(right.from)),
    ).toEqual([
      { from: "guest_session_id", on_delete: "CASCADE", table: "sessions", to: "id" },
      { from: "player_id", on_delete: "CASCADE", table: "players", to: "id" },
    ]);

    const indexes = await results<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_flows' ORDER BY name",
    );
    expect(indexes.filter((index) => index.sql !== null)).toEqual([
      {
        name: "auth_flows_expiry_idx",
        sql: "CREATE INDEX auth_flows_expiry_idx ON auth_flows(expires_at)",
      },
      {
        name: "auth_flows_guest_idx",
        sql: "CREATE INDEX auth_flows_guest_idx ON auth_flows(guest_session_id, created_at)",
      },
    ]);

    const value = await fixture();
    await execute(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, created_at)
       VALUES ('flow', 'state-hash', ?, 'web', 'nonce', 'verifier', 2, 1)`,
      [value.guest],
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, created_at)
       VALUES ('duplicate-state', 'state-hash', ?, 'web', 'nonce', 'verifier', 2, 1)`,
      [value.otherGuest],
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, created_at)
       VALUES ('bad-guest', 'bad-guest-state', 'missing-session', 'web', 'nonce', 'verifier', 2, 1)`,
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, created_at)
       VALUES ('bad-channel', 'bad-channel-state', ?, 'telegram', 'nonce', 'verifier', 2, 1)`,
      [value.guest],
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at,
          handoff_hash, created_at)
       VALUES ('partial-handoff', 'partial-handoff-state', ?, 'android', 'nonce', 'verifier', 2,
               'partial-handoff-hash', 1)`,
      [value.otherGuest],
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, player_id,
          handoff_hash, handoff_expires_at, created_at)
       VALUES ('bad-player', 'bad-player-state', ?, 'web', 'nonce', 'verifier', 2,
               'missing-player', 'bad-player-handoff', 3, 1)`,
      [value.otherGuest],
    );
    await execute(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, player_id,
          handoff_hash, handoff_expires_at, created_at)
       VALUES ('handoff', 'handoff-state', ?, 'android', 'nonce', 'verifier', 2, ?,
               'handoff-hash', 3, 1)`,
      [value.otherGuest, value.player],
    );
    await rejects("UPDATE auth_flows SET handoff_consumed_at = 4 WHERE id = 'handoff'");
    await execute(
      "UPDATE auth_flows SET handoff_consumed_at = 4, handoff_session_id = 'issued-session' WHERE id = 'handoff'",
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, player_id,
          handoff_hash, handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
       VALUES ('duplicate-handoff', 'duplicate-handoff-state', ?, 'web', 'nonce', 'verifier', 2, ?,
               'handoff-hash', 3, 4, 'other-issued-session', 1)`,
      [value.guest, value.player],
    );
    await rejects(
      `INSERT INTO auth_flows
         (id, state_hash, guest_session_id, channel, nonce, pkce_verifier, expires_at, player_id,
          handoff_hash, handoff_expires_at, handoff_consumed_at, handoff_session_id, created_at)
       VALUES ('duplicate-session', 'duplicate-session-state', ?, 'web', 'nonce', 'verifier', 2, ?,
               'other-handoff-hash', 3, 4, 'issued-session', 1)`,
      [value.guest, value.player],
    );
    expect(await results<Record<string, never>>("PRAGMA foreign_key_check")).toEqual([]);

    await execute("DELETE FROM sessions WHERE id = ?", [value.guest]);
    expect(await results<{ id: string }>("SELECT id FROM auth_flows WHERE id = 'flow'")).toEqual(
      [],
    );
    await execute("DELETE FROM players WHERE id = ?", [value.player]);
    expect(await results<{ id: string }>("SELECT id FROM auth_flows WHERE id = 'handoff'")).toEqual(
      [],
    );
    expect(await results<Record<string, never>>("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("accepts a valid relational fixture and reports valid foreign keys", async () => {
    const value = await fixture();
    await attempt(value.attempt, value.guest, null, value.case, value.puzzle);
    await execute(
      "INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES (?, 1, '{\"hint\":1}', 1)",
      [value.attempt],
    );

    expect(await results<{ foreign_keys: number }>("PRAGMA foreign_keys")).toEqual([
      { foreign_keys: 1 },
    ]);
    expect(await results<Record<string, never>>("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("enforces session, puzzle, ordering, attempt, case, and publication checks", async () => {
    const value = await fixture();
    await attempt("check-attempt", value.guest, null, value.case, value.puzzle);
    const cases: SqlCase[] = [
      [
        "INSERT INTO sessions (id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('bad-kind', 'bad-kind', 'bad', 'web', 1, 2, 1)",
      ],
      [
        "INSERT INTO sessions (id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('bad-channel', 'bad-channel', 'guest', 'bad', 1, 2, 1)",
      ],
      [
        "INSERT INTO sessions (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('guest-player', ?, 'guest-player', 'guest', 'web', 1, 2, 1)",
        [value.player],
      ],
      [
        "INSERT INTO sessions (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('telegram-without-player', NULL, 'telegram-without-player', 'telegram', 'web', 1, 2, 1)",
      ],
      [
        "INSERT INTO sessions (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('self-rotation', NULL, 'self-rotation', 'guest', 'web', 'self-rotation', 1, 2, 1)",
      ],
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('bad-version', 'bad-version', 0, ?, 'published', '{}', 'test', 'CC0', 1, 1)",
        [digest],
      ],
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('bad-digest', 'bad-digest', 1, 'A', 'published', '{}', 'test', 'CC0', 1, 1)",
      ],
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('bad-status', 'bad-status', 1, ?, 'bad', '{}', 'test', 'CC0', 1, 1)",
        [digest],
      ],
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('bad-public-json', 'bad-public-json', 1, ?, 'published', 'nope', 'test', 'CC0', 1, 1)",
        [digest],
      ],
      [
        "INSERT INTO puzzle_hints (puzzle_id, level, payload_json) VALUES (?, 0, '{}')",
        [value.puzzle],
      ],
      [
        "INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json) VALUES (?, ?, 0, '{}')",
        [value.otherCase, value.otherPuzzle],
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, hints_used, submitted_at) VALUES ('bad-correct', 'bad-correct', ?, NULL, ?, ?, '{}', 2, '{}', 0, 1)",
        [value.guest, value.case, value.puzzle],
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, hints_used, submitted_at) VALUES ('bad-hints', 'bad-hints', ?, NULL, ?, ?, '{}', 1, '{}', -1, 1)",
        [value.guest, value.case, value.puzzle],
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('bad-date', '2026-02-30', 'bad-date', 'Case', 'published', 1, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('bad-month', '2026-13-01', 'bad-month', 'Case', 'published', 1, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('bad-date-format', '2026-8-03', 'bad-date-format', 'Case', 'published', 1, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('bad-publication', '2026-08-05', 'bad-publication', 'Case', 'draft', 1, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('missing-publication', '2026-08-05', 'missing-publication', 'Case', 'published', NULL, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('bad-case-status', '2026-08-05', 'bad-case-status', 'Case', 'bad', 1, 1, 1)",
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('bad-order', ?, 'bad-order', '{}', '{}', 0)",
        [value.puzzle],
      ],
      [
        "INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES ('check-attempt', 0, '{}', 1)",
      ],
    ];

    for (const [sql, values] of cases) await rejects(sql, values);
  });

  it("enforces identity, ordering, rotation, and session-scoped idempotency uniqueness", async () => {
    const value = await fixture();
    await execute(
      "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('solution-1', ?, 'one', '{}', '{}', 1)",
      [value.puzzle],
    );
    await execute(
      "INSERT INTO players (id, telegram_user_id, oidc_issuer, oidc_subject, display_name, created_at, updated_at) VALUES ('oidc-1', 'oidc-1', 'issuer', 'subject', 'Player', 1, 1)",
    );
    await execute(
      "INSERT INTO sessions (id, token_hash, kind, channel, rotated_from_session_id, created_at, expires_at, last_seen_at) VALUES ('rotation-1', 'rotation-1', 'guest', 'web', ?, 1, 2, 1)",
      [value.guest],
    );
    await membership(value.otherCase, value.otherPuzzle);
    await attempt(value.attempt, value.guest, null, value.case, value.puzzle, "same-attempt");

    const cases: SqlCase[] = [
      [
        "INSERT INTO players (id, telegram_user_id, display_name, created_at, updated_at) VALUES ('duplicate-telegram', ?, 'Player', 1, 1)",
        [`telegram-user-${value.player}`],
      ],
      [
        "INSERT INTO players (id, telegram_user_id, oidc_issuer, oidc_subject, display_name, created_at, updated_at) VALUES ('oidc-2', 'oidc-2', 'issuer', 'subject', 'Player', 1, 1)",
      ],
      [
        "INSERT INTO sessions (id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('duplicate-token', ?, 'guest', 'web', 1, 2, 1)",
        [`token-${value.guest}`],
      ],
      [
        "INSERT INTO sessions (id, token_hash, kind, channel, rotated_from_session_id, created_at, expires_at, last_seen_at) VALUES ('rotation-2', 'rotation-2', 'guest', 'web', ?, 1, 2, 1)",
        [value.guest],
      ],
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('duplicate-content', ?, 1, ?, 'published', '{}', 'test', 'CC0', 1, 1)",
        [`content-${value.puzzle}`, digest],
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('duplicate-solution-key', ?, 'one', '{}', '{}', 2)",
        [value.puzzle],
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('duplicate-solution-order', ?, 'two', '{}', '{}', 1)",
        [value.puzzle],
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('duplicate-date', '2026-08-03', 'duplicate-date', 'Case', 'published', 1, 1, 1)",
      ],
      [
        "INSERT INTO daily_cases (id, case_date, slug, title, status, published_at, created_at, updated_at) VALUES ('duplicate-slug', '2026-08-05', ?, 'Case', 'published', 1, 1, 1)",
        [`slug-${value.case}`],
      ],
      [
        "INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json) VALUES (?, ?, 2, '{}')",
        [value.case, value.puzzle],
      ],
      [
        "INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json) VALUES (?, ?, 1, '{}')",
        [value.otherCase, value.puzzle],
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('duplicate-attempt', 'same-attempt', ?, NULL, ?, ?, '{}', 1, '{}', 1)",
        [value.guest, value.case, value.puzzle],
      ],
    ];

    for (const [sql, values] of cases) await rejects(sql, values);
    await attempt(
      "other-session-attempt",
      value.otherGuest,
      null,
      value.case,
      value.puzzle,
      "same-attempt",
    );
  });

  it("enforces attempt membership and session ownership with stable trigger errors", async () => {
    const value = await fixture();
    await expect(attempt("null-session", null, null, value.case, value.puzzle)).rejects.toThrow(
      "attempt_session_required",
    );
    await expect(
      attempt("guest-owner", value.guest, value.player, value.case, value.puzzle),
    ).rejects.toThrow("attempt_guest_player_mismatch");
    await expect(
      attempt("telegram-missing", value.telegram, null, value.case, value.puzzle),
    ).rejects.toThrow("attempt_telegram_player_mismatch");
    await expect(
      attempt("telegram-wrong", value.telegram, value.otherPlayer, value.case, value.puzzle),
    ).rejects.toThrow("attempt_telegram_player_mismatch");
    await rejects(
      "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('missing-session', 'missing-session', 'missing', NULL, ?, ?, '{}', 1, '{}', 1)",
      [value.case, value.puzzle],
    );
    await rejects(
      "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('not-member', 'not-member', ?, NULL, ?, ?, '{}', 1, '{}', 1)",
      [value.guest, value.otherCase, value.puzzle],
    );

    await attempt("valid-guest", value.guest, null, value.case, value.puzzle);
    await attempt("valid-telegram", value.telegram, value.player, value.case, value.puzzle);
  });

  it("rejects missing parents for every foreign-key family", async () => {
    const value = await fixture();
    await attempt("fk-attempt", value.guest, null, value.case, value.puzzle);
    const cases: SqlCase[] = [
      [
        "INSERT INTO sessions (id, player_id, token_hash, kind, channel, created_at, expires_at, last_seen_at) VALUES ('missing-session-player', 'missing-player', 'missing-session-player', 'telegram', 'web', 1, 2, 1)",
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('missing-solution-puzzle', 'missing-puzzle', 'one', '{}', '{}', 1)",
      ],
      [
        "INSERT INTO puzzle_hints (puzzle_id, level, payload_json) VALUES ('missing-hint-puzzle', 1, '{}')",
      ],
      [
        "INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json) VALUES ('missing-case', 'missing-puzzle', 1, '{}')",
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('missing-attempt-case', 'missing-attempt-case', ?, NULL, 'missing-case', ?, '{}', 1, '{}', 1)",
        [value.guest, value.puzzle],
      ],
      [
        "INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES ('missing-attempt', 1, '{}', 1)",
      ],
      [
        "INSERT INTO content_imports (digest, case_id, source_name, imported_at) VALUES ('missing-content-case', 'missing-case', 'test', 1)",
      ],
      ["UPDATE attempts SET player_id = 'missing-player' WHERE id = 'fk-attempt'"],
    ];

    for (const [sql, values] of cases) await rejects(sql, values);
  });

  it("rejects invalid JSON in every JSON-bearing table family", async () => {
    const value = await fixture();
    const cases: SqlCase[] = [
      [
        "INSERT INTO puzzles (id, content_key, version, content_digest, status, public_json, provenance, license, created_at, updated_at) VALUES ('json-puzzle', 'json-puzzle', 1, ?, 'published', 'bad', 'test', 'CC0', 1, 1)",
        [digest],
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('json-solution', ?, 'json', 'bad', '{}', 1)",
        [value.puzzle],
      ],
      [
        "INSERT INTO puzzle_solutions (id, puzzle_id, solution_key, solution_json, contradiction_json, sort_order) VALUES ('json-contradiction', ?, 'contradiction', '{}', 'bad', 1)",
        [value.puzzle],
      ],
      [
        "INSERT INTO puzzle_hints (puzzle_id, level, payload_json) VALUES (?, 1, 'bad')",
        [value.puzzle],
      ],
      [
        "INSERT INTO daily_case_puzzles (case_id, puzzle_id, position, act_json) VALUES (?, ?, 2, 'bad')",
        [value.otherCase, value.otherPuzzle],
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('json-attempt-answer', 'json-attempt-answer', ?, NULL, ?, ?, 'bad', 1, '{}', 1)",
        [value.guest, value.case, value.puzzle],
      ],
      [
        "INSERT INTO attempts (id, attempt_uuid, session_id, player_id, case_id, puzzle_id, normalized_answer_json, correct, response_json, submitted_at) VALUES ('json-attempt-response', 'json-attempt-response', ?, NULL, ?, ?, '{}', 1, 'bad', 1)",
        [value.guest, value.case, value.puzzle],
      ],
      [
        "INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES (?, 1, 'bad', 1)",
        [value.attempt],
      ],
    ];
    await attempt(value.attempt, value.guest, null, value.case, value.puzzle);

    for (const [sql, values] of cases) await rejects(sql, values);
  });

  it("applies the requested deletion actions and restricts referenced content", async () => {
    const value = await fixture();
    await attempt(value.attempt, value.guest, null, value.case, value.puzzle);
    await execute("DELETE FROM sessions WHERE id = ?", [value.guest]);
    expect(
      await results<{ session_id: string | null }>("SELECT session_id FROM attempts WHERE id = ?", [
        value.attempt,
      ]),
    ).toEqual([{ session_id: null }]);

    await attempt("telegram-attempt", value.telegram, value.player, value.case, value.puzzle);
    await execute(
      "INSERT INTO hint_events (attempt_id, hint_level, hint_json, created_at) VALUES ('telegram-attempt', 1, '{}', 1)",
    );
    await execute("DELETE FROM players WHERE id = ?", [value.player]);
    expect(
      await results<{ count: number }>("SELECT count(*) AS count FROM sessions WHERE id = ?", [
        value.telegram,
      ]),
    ).toEqual([{ count: 0 }]);
    expect(
      await results<{ count: number }>(
        "SELECT count(*) AS count FROM attempts WHERE id = 'telegram-attempt'",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await results<{ count: number }>(
        "SELECT count(*) AS count FROM hint_events WHERE attempt_id = 'telegram-attempt'",
      ),
    ).toEqual([{ count: 0 }]);

    await session("predecessor", "guest", null);
    await execute(
      "INSERT INTO sessions (id, token_hash, kind, channel, rotated_from_session_id, created_at, expires_at, last_seen_at) VALUES ('successor', 'successor', 'guest', 'web', 'predecessor', 1, 2, 1)",
    );
    await execute("DELETE FROM sessions WHERE id = 'predecessor'");
    expect(
      await results<{ rotated_from_session_id: string | null }>(
        "SELECT rotated_from_session_id FROM sessions WHERE id = 'successor'",
      ),
    ).toEqual([{ rotated_from_session_id: null }]);
    await rejects("DELETE FROM puzzles WHERE id = ?", [value.puzzle]);
    await rejects("DELETE FROM daily_cases WHERE id = ?", [value.case]);
  });

  it("creates all FK support indexes including the partial session expiry index", async () => {
    const indexes = await results<{ name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
    );
    const names = indexes.map((index) => index.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "sessions_expiry_idx",
        "attempts_session_idx",
        "attempts_player_idx",
        "attempts_case_correct_idx",
        "sessions_player_idx",
        "daily_case_puzzles_puzzle_idx",
        "attempts_puzzle_idx",
      ]),
    );
    expect(indexes.find((index) => index.name === "sessions_expiry_idx")?.sql).toContain(
      "WHERE revoked_at IS NULL",
    );
  });
});
