-- Preserve each side's earned result before account linking combines event histories.
-- A puzzle contributes one award: the highest verified score, never the sum of devices.
CREATE TABLE merged_puzzle_awards (
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE RESTRICT,
  award_attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  earned_points INTEGER NOT NULL CHECK (earned_points BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  assistance_count INTEGER NOT NULL CHECK (assistance_count >= 0),
  legacy_solved INTEGER NOT NULL CHECK (legacy_solved IN (0, 1)),
  PRIMARY KEY (player_id, puzzle_id)
);

CREATE INDEX merged_puzzle_awards_attempt_idx ON merged_puzzle_awards(award_attempt_id);
