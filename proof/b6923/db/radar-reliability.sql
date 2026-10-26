-- Additive schema preparation. Explicit migration only; public GET never executes DDL.
-- No player inserts, updates, deletes, timestamp backfills, or fabricated verification.
CREATE TABLE IF NOT EXISTS radar_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, player_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS radar_source_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL UNIQUE, source_name TEXT NOT NULL, content_hash TEXT, http_status INTEGER, checked_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS radar_review_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL, source_name TEXT NOT NULL, summary TEXT NOT NULL, previous_hash TEXT, proposed_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT);
CREATE TABLE IF NOT EXISTS radar_update_proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, player_key TEXT NOT NULL, current_payload TEXT, proposed_payload TEXT NOT NULL, evidence_url TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT);
CREATE TABLE IF NOT EXISTS radar_publication_history (id INTEGER PRIMARY KEY AUTOINCREMENT, player_key TEXT NOT NULL, previous_payload TEXT, published_payload TEXT NOT NULL, published_at INTEGER NOT NULL, published_by TEXT NOT NULL, reverted_at INTEGER, reverted_by TEXT);
CREATE TABLE IF NOT EXISTS conversion_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_name TEXT NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS radar_fetch_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, source_url TEXT NOT NULL, source_name TEXT NOT NULL, attempted_at INTEGER NOT NULL, succeeded_at INTEGER, http_status INTEGER NOT NULL, content_hash TEXT, error_code TEXT);
CREATE INDEX IF NOT EXISTS idx_radar_fetch_url_time ON radar_fetch_attempts(source_url, attempted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_radar_proposals_pending ON radar_update_proposals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_radar_history_player ON radar_publication_history(player_key, published_at);

-- Calendar observation constraints and legacy-write guards are installed by daily-readiness.sql.
