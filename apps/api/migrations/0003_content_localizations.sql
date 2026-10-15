-- English content and persisted gameplay events remain canonical and immutable.
-- Public routes select only public_json; private translations follow hint/reveal entitlement.
CREATE TABLE case_localizations (
  case_id TEXT NOT NULL REFERENCES daily_cases(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ru', 'zh')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (case_id, locale)
);

CREATE TABLE puzzle_localizations (
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ru', 'zh')),
  public_json TEXT NOT NULL CHECK (json_valid(public_json)),
  private_json TEXT NOT NULL CHECK (json_valid(private_json)),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
  ),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (puzzle_id, locale)
);
