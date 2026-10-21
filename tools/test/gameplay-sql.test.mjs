import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const source = await readFile(
  new URL("../../apps/api/src/db/gameplay.ts", import.meta.url),
  "utf8",
);
const gameplay = await import(
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);
const attemptSource = await readFile(
  new URL("../../apps/api/src/db/attempts.ts", import.meta.url),
  "utf8",
);
const identitySource = await readFile(
  new URL("../../apps/api/src/db/puzzle-identity.ts", import.meta.url),
  "utf8",
);
const identityModule = `data:text/javascript;base64,${Buffer.from(
  stripTypeScriptTypes(identitySource),
).toString("base64")}`;
const attemptCode = stripTypeScriptTypes(attemptSource).replace(
  '"./puzzle-identity"',
  JSON.stringify(identityModule),
);
const attemptQueries = await import(
  `data:text/javascript;base64,${Buffer.from(attemptCode).toString("base64")}`
);
const migrations = await Promise.all(
  [
    "0001_initial",
    "0002_telegram_auth",
    "0003_content_localizations",
    "0004_gameplay_progress",
    "0005_puzzle_feedback",
    "0006_merged_puzzle_awards",
  ].map((name) =>
    readFile(new URL(`../../apps/api/migrations/${name}.sql`, import.meta.url), "utf8"),
  ),
);
const guest = (id = "g1") => ({ sessionId: id, playerId: null, kind: "guest", channel: "web" });
const player = (sessionId = "t1", playerId = "p1") => ({
  sessionId,
  playerId,
  kind: "telegram",
  channel: "web",
});
const now = Math.floor(Date.now() / 1000);
const today = "2026-10-15";

function fixture({ legacy } = {}) {
  const sql = new DatabaseSync(":memory:");
  for (const migration of migrations.slice(0, 3)) sql.exec(migration);
  sql.exec(`
    INSERT INTO players(id,telegram_user_id,display_name,created_at,updated_at)
      VALUES ('p1','1','One',1,1),('p2','2','Two',1,1);
    INSERT INTO sessions(id,player_id,token_hash,kind,channel,created_at,expires_at,last_seen_at)
      VALUES ('g1',NULL,'g1','guest','web',1,${now + 3600},1),
             ('g2',NULL,'g2','guest','web',1,${now + 3600},1),
             ('t1','p1','t1','telegram','web',1,${now + 3600},1),
             ('t2','p1','t2','telegram','web',1,${now + 3600},1),
             ('other','p2','other','telegram','web',1,${now + 3600},1);
    INSERT INTO daily_cases(id,case_date,slug,title,status,published_at,created_at,updated_at)
      VALUES ('c1','2026-10-15','one','Synthetic','published',1,1,1);
  `);
  for (let index = 1; index <= 4; index++) {
    const id = `q${index}`;
    sql
      .prepare(
        `INSERT INTO puzzles(id,content_key,version,content_digest,status,public_json,provenance,
         license,created_at,updated_at) VALUES (?,?,1,?,'published','{}','Synthetic','CC0',1,1)`,
      )
      .run(id, id, "a".repeat(64));
    sql
      .prepare(
        "INSERT INTO daily_case_puzzles(case_id,puzzle_id,position,act_json) VALUES ('c1',?,?,'{}')",
      )
      .run(id, index);
    for (let level = 1; level <= 3; level++)
      sql
        .prepare("INSERT INTO puzzle_hints(puzzle_id,level,payload_json) VALUES (?,?,'{}')")
        .run(id, level);
  }
  let sequence = 0;
  function attempt(actor, correct, { puzzle = "q1", id, uuid, at = now, hints = 0 } = {}) {
    const attemptId = id ?? `a${++sequence}`;
    sql
      .prepare(
        `INSERT INTO attempts(id,attempt_uuid,session_id,player_id,case_id,puzzle_id,
         normalized_answer_json,correct,response_json,hints_used,submitted_at)
       VALUES (?,?,?,?,'c1',?,'{}',?,'{}',?,?)
       ON CONFLICT(session_id,attempt_uuid) DO NOTHING`,
      )
      .run(
        attemptId,
        uuid ?? attemptId,
        actor.sessionId,
        actor.playerId,
        puzzle,
        +correct,
        hints,
        at,
      );
    return attemptId;
  }
  function hint(attemptId, level) {
    sql
      .prepare(
        `INSERT INTO hint_events(attempt_id,hint_level,hint_json,created_at) VALUES (?,?,'{}',?)
       ON CONFLICT(attempt_id,hint_level) DO NOTHING`,
      )
      .run(attemptId, level, now);
  }
  legacy?.({ sql, attempt, hint });
  for (const migration of migrations.slice(3)) sql.exec(migration);
  const db = {
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec("COMMIT");
        return results;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(query) {
      return {
        bind(...values) {
          const statement = sql.prepare(query);
          return {
            async all() {
              return { results: statement.all(...values) };
            },
            async first() {
              return statement.get(...values) ?? null;
            },
            async run() {
              return statement.run(...values);
            },
          };
        },
      };
    },
  };
  const clue = (actor = guest(), puzzleId = "q1", override = {}) =>
    gameplay.grantPuzzleClue(db, actor, { caseId: "c1", puzzleId, today, now, ...override });
  const progress = async (actor = guest(), puzzleId = "q1") =>
    (await gameplay.readGameProgress(db, actor, [puzzleId])).get(puzzleId);
  return { sql, db, attempt, hint, clue, progress, close: () => sql.close() };
}

test("gameplay starts at 100 points and distinguishes actor scopes and arbitrary bound IDs", async () => {
  const f = fixture();
  try {
    const state = await f.progress();
    assert.deepEqual(state, {
      attemptCount: 0,
      assistanceCount: 0,
      clueUnlocked: false,
      highestHintLevel: 0,
      earnedPoints: null,
      nextAttemptPoints: 100,
      legacySolved: false,
      awardAttemptId: null,
    });
    f.attempt(guest("g2"), true);
    f.attempt(player("other", "p2"), true);
    assert.deepEqual(await f.progress(), state);
    assert.deepEqual(await f.progress(player()), state);
    assert.equal((await gameplay.readGameProgress(f.db, guest(), ["q1') OR 1=1 --"])).size, 1);
    assert.equal((await gameplay.readGameProgress(f.db, guest(), [])).size, 0);
    await assert.rejects(gameplay.readGameProgress(f.db, guest(), [""]), /invalid/);
    assert.equal(await gameplay.readTotalPoints(f.db, guest()), 0);
  } finally {
    f.close();
  }
});

test("attempt UUID replay and later correct submissions award once at the first committed solve", async () => {
  const f = fixture();
  try {
    const wrong = f.attempt(guest(), false, { uuid: "same" });
    f.attempt(guest(), false, { uuid: "same" });
    assert.equal((await f.progress()).attemptCount, 1);
    assert.equal((await f.progress()).nextAttemptPoints, 70);
    const correct = f.attempt(guest(), true);
    f.attempt(guest(), true);
    f.hint(wrong, 1);
    await f.clue();
    const state = await f.progress();
    assert.equal(state.attemptCount, 2);
    assert.equal(state.earnedPoints, 70);
    assert.equal(state.awardAttemptId, correct);
    assert.equal(state.nextAttemptPoints, 0);
    assert.equal(state.assistanceCount, 0);
    assert.equal(state.clueUnlocked, true);
    assert.equal(state.highestHintLevel, 1);
    assert.equal(await gameplay.readTotalPoints(f.db, guest()), 70);
    assert.equal(
      f.sql.prepare("SELECT count(*) AS n FROM gameplay_events WHERE kind='attempt'").get().n,
      3,
    );
  } finally {
    f.close();
  }
});

test("committed hint-before-solve order freezes distinct assist penalties across attempts", async () => {
  const f = fixture();
  try {
    const first = f.attempt(guest(), false);
    f.hint(first, 1);
    f.hint(first, 1);
    const second = f.attempt(guest(), false);
    f.hint(second, 1);
    f.hint(second, 2);
    await f.clue();
    await f.clue();
    let state = await f.progress();
    assert.equal(state.assistanceCount, 3);
    assert.equal(state.nextAttemptPoints, 5);
    f.attempt(guest(), true);
    f.hint(second, 3);
    state = await f.progress();
    assert.equal(state.assistanceCount, 3);
    assert.equal(state.earnedPoints, 5);
    assert.equal(state.highestHintLevel, 3);
    assert.equal(
      f.sql.prepare("SELECT count(*) AS n FROM gameplay_events WHERE kind='clue'").get().n,
      1,
    );
    f.sql.exec("DELETE FROM hint_events");
    assert.equal((await f.progress()).earnedPoints, 5);
    assert.equal((await f.progress()).highestHintLevel, 3);
    f.hint(first, 1);
    assert.equal((await f.progress()).earnedPoints, 5);
    assert.equal((await f.progress()).assistanceCount, 3);
  } finally {
    f.close();
  }
});

test("point bands are 100, 70, 40, 20 and assistance floors each halving to at least one", async () => {
  const f = fixture();
  try {
    for (let index = 1; index <= 4; index++) {
      const puzzle = `q${index}`;
      for (let wrong = 1; wrong < index; wrong++) f.attempt(guest(), false, { puzzle });
      f.attempt(guest(), true, { puzzle });
      assert.equal((await f.progress(guest(), puzzle)).earnedPoints, [100, 70, 40, 20][index - 1]);
    }
    assert.equal(await gameplay.readTotalPoints(f.db, guest()), 230);
    for (let index = 0; index < 4; index++) f.attempt(guest("g2"), false);
    const wrong = f.attempt(guest("g2"), false);
    for (let level = 1; level <= 8; level++) f.hint(wrong, level);
    await f.clue(guest("g2"));
    f.attempt(guest("g2"), true);
    assert.equal((await f.progress(guest("g2"))).earnedPoints, 1);
  } finally {
    f.close();
  }
});

test("clue grant requires live actor, exact published case membership and no unpublished sibling", async () => {
  const f = fixture();
  try {
    await f.clue(guest(), "missing");
    await f.clue(guest(), "q1", { caseId: "missing" });
    await f.clue(guest(), "q1", { today: "2026-10-14" });
    await f.clue({ ...guest(), channel: "android" });
    f.sql.exec("UPDATE puzzles SET status='draft' WHERE id='q4'");
    await f.clue();
    f.sql.exec("UPDATE puzzles SET status='published' WHERE id='q4'");
    f.sql.exec("UPDATE sessions SET revoked_at=1 WHERE id='g1'");
    await f.clue();
    f.sql.exec(`UPDATE sessions SET revoked_at=NULL, expires_at=${now} WHERE id='g1'`);
    await f.clue();
    assert.equal((await f.progress()).clueUnlocked, false);
    await f.clue(player());
    assert.equal((await f.progress(player())).clueUnlocked, true);
    assert.equal((await f.progress()).clueUnlocked, false);
  } finally {
    f.close();
  }
});

test("legacy solved puzzles remain unrated and old failed attempts preserve clue and hint exposure", async () => {
  const f = fixture({
    legacy: ({ attempt, hint, sql }) => {
      const wrong = attempt(guest(), false, { hints: 2, at: now - 10 });
      hint(wrong, 1);
      sql.exec("DELETE FROM hint_events");
      attempt(guest(), true, { puzzle: "q2", at: now - 5 });
    },
  });
  try {
    let state = await f.progress();
    assert.equal(state.attemptCount, 1);
    assert.equal(state.clueUnlocked, true);
    assert.equal(state.highestHintLevel, 2);
    assert.equal(state.assistanceCount, 3);
    assert.equal(state.nextAttemptPoints, 8);
    await f.clue();
    assert.equal(
      f.sql.prepare("SELECT count(*) AS n FROM gameplay_events WHERE kind='clue'").get().n,
      0,
    );
    f.attempt(guest(), true);
    assert.equal((await f.progress()).earnedPoints, 8);
    f.attempt(guest(), true, { puzzle: "q2" });
    state = await f.progress(guest(), "q2");
    assert.equal(state.legacySolved, true);
    assert.equal(state.earnedPoints, 0);
    assert.equal(state.attemptCount, 1);
    assert.equal(await gameplay.readTotalPoints(f.db, guest()), 8);
  } finally {
    f.close();
  }
});

test("guest link preserves the best earned award while merging chronology and duplicate clues", async () => {
  const f = fixture();
  try {
    await f.clue();
    f.attempt(guest(), true);
    f.attempt(player(), true);
    await f.clue(player());
    assert.equal((await f.progress(player())).earnedPoints, 100);
    await gameplay.transferClueStatement(f.db, "g1", "t1", "p1").run();
    assert.equal((await f.progress()).clueUnlocked, true);
    f.sql
      .prepare(
        `INSERT INTO sessions(id,player_id,token_hash,kind,channel,rotated_from_session_id,
         created_at,expires_at,last_seen_at) VALUES ('replacement','p1','new','telegram','web','g1',1,?,1)`,
      )
      .run(now + 3600);
    f.sql.exec("BEGIN");
    await gameplay.preserveMergeAwardsStatement(f.db, "g1", "replacement").run();
    f.sql.exec("UPDATE attempts SET player_id='p1' WHERE session_id='g1' AND player_id IS NULL");
    await gameplay.transferClueStatement(f.db, "g1", "replacement", null).run();
    f.sql.exec("UPDATE sessions SET revoked_at=1 WHERE id='g1'; COMMIT");
    const state = await f.progress(player());
    assert.equal(state.earnedPoints, 100);
    assert.equal(state.assistanceCount, 0);
    assert.equal(state.attemptCount, 1);
    assert.equal(await gameplay.readTotalPoints(f.db, player()), 100);
    assert.equal(
      f.sql
        .prepare(
          "SELECT count(*) AS n FROM gameplay_events WHERE kind='clue' AND clue_player_id='p1'",
        )
        .get().n,
      2,
    );
    assert.equal((await f.progress()).earnedPoints, null);
    f.sql.exec("DELETE FROM sessions WHERE id='g1'");
    assert.equal((await f.progress(player())).earnedPoints, 100);
    f.sql.exec("DELETE FROM players WHERE id='p1'");
    assert.equal(await gameplay.readTotalPoints(f.db, player()), 0);
    assert.equal(f.sql.prepare("SELECT count(*) AS n FROM gameplay_events").get().n, 0);
  } finally {
    f.close();
  }
});

test("guest retention removes gameplay while linked scoring survives expired session cleanup", async () => {
  const f = fixture();
  try {
    await f.clue();
    const wrong = f.attempt(guest(), false);
    f.hint(wrong, 1);
    f.attempt(guest(), true);
    await f.clue(player());
    f.attempt(player(), true);
    assert.equal((await f.progress(player())).earnedPoints, 50);
    f.sql.exec(
      "DELETE FROM attempts WHERE session_id='g1'; DELETE FROM sessions WHERE id IN ('g1','t1')",
    );
    assert.equal(await gameplay.readTotalPoints(f.db, guest()), 0);
    assert.equal((await f.progress(player())).earnedPoints, 50);
  } finally {
    f.close();
  }
});

test("real hint persistence sequences levels across owned attempts and counts only a winning insert", async () => {
  const f = fixture();
  try {
    const first = f.attempt(guest(), false);
    const second = f.attempt(guest(), false);
    const third = f.attempt(guest(), false);
    const persist = (attemptId, hintLevel, actor = guest()) =>
      attemptQueries.persistHintForActor(f.db, actor, {
        attemptId,
        hintLevel,
        hintJson: JSON.stringify({ level: hintLevel, text: "Synthetic hint" }),
        now,
      });
    await persist(first, 2);
    assert.equal((await f.progress()).highestHintLevel, 0);
    await persist(first, 1);
    await persist(first, 1);
    await persist(second, 1);
    await persist(second, 2);
    await persist(third, 2);
    assert.equal((await f.progress()).highestHintLevel, 2);
    assert.equal((await f.progress()).assistanceCount, 2);
    assert.equal(f.sql.prepare("SELECT sum(hints_used) AS n FROM attempts").get().n, 2);
    assert.equal(f.sql.prepare("SELECT hints_used AS n FROM attempts WHERE id=?").get(second).n, 1);
    f.sql.exec("DELETE FROM hint_events");
    await persist(third, 1);
    await persist(third, 3);
    assert.equal((await f.progress()).highestHintLevel, 3);
    assert.equal(f.sql.prepare("SELECT sum(hints_used) AS n FROM attempts").get().n, 3);
    await persist(third, 4, guest("g2"));
    assert.equal((await f.progress()).highestHintLevel, 3);
    const unrelated = f.attempt(guest("g2"), false);
    await persist(unrelated, 1, guest("g2"));
    assert.equal((await f.progress(guest("g2"))).highestHintLevel, 1);
    assert.equal((await f.progress()).highestHintLevel, 3);
    const playerFirst = f.attempt(player(), false);
    const playerSecond = f.attempt(player("t2"), false);
    await persist(playerFirst, 1, player());
    await persist(playerSecond, 2, player("t2"));
    assert.equal((await f.progress(player())).highestHintLevel, 2);
    f.sql.exec("UPDATE sessions SET revoked_at=1 WHERE id='t1'");
    await persist(playerFirst, 3, player());
    assert.equal((await f.progress(player("t2"))).highestHintLevel, 2);
    await persist(playerSecond, 3, player("t2"));
    assert.equal((await f.progress(player("t2"))).highestHintLevel, 3);
  } finally {
    f.close();
  }
});
