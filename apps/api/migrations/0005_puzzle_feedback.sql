CREATE TABLE puzzle_feedback (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  report_uuid TEXT NOT NULL,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  puzzle_id TEXT NOT NULL,
  client_puzzle_id TEXT NOT NULL,
  puzzle_version INTEGER NOT NULL CHECK (puzzle_version > 0),
  locale TEXT NOT NULL CHECK (locale IN ('en', 'ru', 'zh')),
  reason TEXT NOT NULL CHECK (
    reason IN ('unclear_condition', 'alternative_answer', 'explanation_error', 'other')
  ),
  comment TEXT NOT NULL CHECK (length(comment) <= 1000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, report_uuid),
  FOREIGN KEY (case_id, puzzle_id)
    REFERENCES daily_case_puzzles(case_id, puzzle_id) ON DELETE CASCADE
);

CREATE INDEX puzzle_feedback_created_idx ON puzzle_feedback(created_at);
CREATE INDEX puzzle_feedback_session_created_idx ON puzzle_feedback(session_id, created_at);
CREATE INDEX puzzle_feedback_player_created_idx ON puzzle_feedback(player_id, created_at);
