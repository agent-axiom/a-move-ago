-- Score chronology belongs to persisted events, never request timestamps or client state.
-- Hint text may expire independently; the associated scoring fact remains until its attempt is deleted.
CREATE TABLE gameplay_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES attempts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('attempt', 'hint', 'clue')),
  hint_level INTEGER NOT NULL DEFAULT 0,
  legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
  clue_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  clue_player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  UNIQUE (attempt_id, kind, hint_level),
  CHECK (
    (kind = 'attempt' AND attempt_id IS NOT NULL AND hint_level = 0
      AND clue_session_id IS NULL AND clue_player_id IS NULL)
    OR (kind = 'hint' AND attempt_id IS NOT NULL AND hint_level > 0
      AND clue_session_id IS NULL AND clue_player_id IS NULL)
    OR (kind = 'clue' AND attempt_id IS NULL AND hint_level = 0 AND legacy = 0
      AND ((clue_session_id IS NOT NULL AND clue_player_id IS NULL)
        OR (clue_session_id IS NULL AND clue_player_id IS NOT NULL)))
  )
);

-- Include retained hints and the historical hints_used watermark. The latter survives
-- the independent annual cleanup of hint text. Legacy puzzles already solved stay unrated.
WITH historical_events AS (
  SELECT a.puzzle_id, a.id AS attempt_id, 'attempt' AS kind, 0 AS hint_level,
         a.submitted_at AS event_time, 1 AS event_order, a.rowid AS attempt_order
    FROM attempts a
  UNION ALL
  SELECT a.puzzle_id, a.id, 'hint', ph.level,
         COALESCE(he.created_at, a.submitted_at), 0, a.rowid
    FROM attempts a
    JOIN puzzle_hints ph ON ph.puzzle_id = a.puzzle_id AND ph.level <= a.hints_used
    LEFT JOIN hint_events he ON he.attempt_id = a.id AND he.hint_level = ph.level
  UNION ALL
  SELECT a.puzzle_id, a.id, 'hint', he.hint_level, he.created_at, 0, a.rowid
    FROM hint_events he
    JOIN attempts a ON a.id = he.attempt_id
   WHERE NOT EXISTS (
     SELECT 1 FROM puzzle_hints ph
      WHERE ph.puzzle_id = a.puzzle_id AND ph.level = he.hint_level
        AND ph.level <= a.hints_used
   )
)
INSERT INTO gameplay_events (puzzle_id, attempt_id, kind, hint_level, legacy)
SELECT puzzle_id, attempt_id, kind, hint_level, 1
  FROM historical_events
 ORDER BY event_time, event_order, attempt_order, hint_level;

CREATE INDEX gameplay_events_attempt_idx ON gameplay_events(attempt_id, seq);
CREATE INDEX gameplay_events_puzzle_idx ON gameplay_events(puzzle_id, seq);
CREATE INDEX gameplay_events_guest_clue_idx
  ON gameplay_events(clue_session_id, puzzle_id) WHERE kind = 'clue';
CREATE INDEX gameplay_events_player_clue_idx
  ON gameplay_events(clue_player_id, puzzle_id) WHERE kind = 'clue';

CREATE TRIGGER gameplay_attempt_after_insert
AFTER INSERT ON attempts
FOR EACH ROW
BEGIN
  INSERT INTO gameplay_events (puzzle_id, attempt_id, kind)
  VALUES (NEW.puzzle_id, NEW.id, 'attempt');
END;

CREATE TRIGGER gameplay_hint_after_insert
AFTER INSERT ON hint_events
FOR EACH ROW
BEGIN
  INSERT INTO gameplay_events (puzzle_id, attempt_id, kind, hint_level)
  SELECT a.puzzle_id, NEW.attempt_id, 'hint', NEW.hint_level
    FROM attempts a WHERE a.id = NEW.attempt_id
  ON CONFLICT(attempt_id, kind, hint_level) DO NOTHING;
END;
