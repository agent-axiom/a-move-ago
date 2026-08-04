CREATE TABLE auth_flows (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  guest_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('web', 'android')),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  callback_claimed_at INTEGER,
  player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
  handoff_hash TEXT UNIQUE,
  handoff_expires_at INTEGER,
  handoff_consumed_at INTEGER,
  handoff_session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (
    (handoff_hash IS NULL AND handoff_expires_at IS NULL AND player_id IS NULL)
    OR
    (handoff_hash IS NOT NULL AND handoff_expires_at IS NOT NULL AND player_id IS NOT NULL)
  ),
  CHECK (
    (handoff_consumed_at IS NULL AND handoff_session_id IS NULL)
    OR
    (handoff_consumed_at IS NOT NULL AND handoff_session_id IS NOT NULL)
  )
);

CREATE INDEX auth_flows_expiry_idx ON auth_flows(expires_at);
CREATE INDEX auth_flows_guest_idx ON auth_flows(guest_session_id, created_at);
