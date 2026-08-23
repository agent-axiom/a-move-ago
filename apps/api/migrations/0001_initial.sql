PRAGMA foreign_keys = ON;

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  oidc_issuer TEXT,
  oidc_subject TEXT,
  oidc_audience TEXT,
  display_name TEXT NOT NULL,
  username TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (oidc_issuer, oidc_subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('guest', 'telegram')),
  channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram', 'android')),
  rotated_from_session_id TEXT UNIQUE REFERENCES sessions(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  CHECK (rotated_from_session_id IS NULL OR rotated_from_session_id <> id),
  CHECK ((kind = 'guest' AND player_id IS NULL) OR (kind = 'telegram' AND player_id IS NOT NULL))
);

CREATE TABLE puzzles (
  id TEXT PRIMARY KEY,
  content_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  provenance TEXT NOT NULL,
  license TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (content_key, version)
);

CREATE TABLE puzzle_solutions (
  id TEXT PRIMARY KEY,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  solution_key TEXT NOT NULL,
  solution_json TEXT NOT NULL CHECK (json_valid(solution_json)),
  contradiction_json TEXT NOT NULL CHECK (json_valid(contradiction_json)),
  sort_order INTEGER NOT NULL CHECK (sort_order > 0),
  UNIQUE (puzzle_id, solution_key),
  UNIQUE (puzzle_id, sort_order)
);

CREATE TABLE puzzle_hints (
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  level INTEGER NOT NULL CHECK (level > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (puzzle_id, level)
);

CREATE TABLE daily_cases (
  id TEXT PRIMARY KEY,
  case_date TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    length(case_date) = 10
    AND case_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND COALESCE(date(case_date, '+0 days') = case_date, 0)
  ),
  CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
  )
);

CREATE TABLE daily_case_puzzles (
  case_id TEXT NOT NULL REFERENCES daily_cases(id) ON DELETE RESTRICT,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position > 0),
  act_json TEXT NOT NULL CHECK (json_valid(act_json)),
  PRIMARY KEY (case_id, position),
  UNIQUE (case_id, puzzle_id)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  attempt_uuid TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES daily_cases(id) ON DELETE RESTRICT,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  normalized_answer_json TEXT NOT NULL CHECK (json_valid(normalized_answer_json)),
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  hints_used INTEGER NOT NULL DEFAULT 0 CHECK (hints_used >= 0),
  submitted_at INTEGER NOT NULL,
  UNIQUE (session_id, attempt_uuid),
  FOREIGN KEY (case_id, puzzle_id) REFERENCES daily_case_puzzles(case_id, puzzle_id) ON DELETE RESTRICT
);

CREATE TABLE hint_events (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  hint_level INTEGER NOT NULL CHECK (hint_level > 0),
  hint_json TEXT NOT NULL CHECK (json_valid(hint_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, hint_level)
);

CREATE TABLE content_imports (
  digest TEXT PRIMARY KEY,
  case_id TEXT NOT NULL UNIQUE REFERENCES daily_cases(id) ON DELETE RESTRICT,
  source_name TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TRIGGER attempts_validate_session_before_insert
BEFORE INSERT ON attempts
FOR EACH ROW
BEGIN
  SELECT (CASE
    WHEN NEW.session_id IS NULL THEN RAISE(ABORT, 'attempt_session_required')
  END);
  SELECT (CASE
    WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id)
      THEN RAISE(ABORT, 'attempt_session_missing')
  END);
  SELECT (CASE
    WHEN (SELECT kind FROM sessions WHERE id = NEW.session_id) = 'guest'
      AND NEW.player_id IS NOT NULL THEN RAISE(ABORT, 'attempt_guest_player_mismatch')
  END);
  SELECT (CASE
    WHEN (SELECT kind FROM sessions WHERE id = NEW.session_id) = 'telegram'
      AND NEW.player_id IS NOT (SELECT player_id FROM sessions WHERE id = NEW.session_id)
      THEN RAISE(ABORT, 'attempt_telegram_player_mismatch')
  END);
END;

CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_player_idx ON sessions(player_id);
CREATE INDEX daily_case_puzzles_puzzle_idx ON daily_case_puzzles(puzzle_id);
CREATE INDEX attempts_session_idx ON attempts(session_id, submitted_at);
CREATE INDEX attempts_player_idx ON attempts(player_id, submitted_at);
CREATE INDEX attempts_puzzle_idx ON attempts(puzzle_id);
CREATE INDEX attempts_case_correct_idx ON attempts(case_id, puzzle_id, correct);
