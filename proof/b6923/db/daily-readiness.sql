-- Explicit follow-up to radar-reliability.sql. Local-tested; never run on production automatically.
-- Replace only the old overly broad uniqueness constraint; no records/history are removed.
-- Execute as one D1 migration/batch; D1 manages the transaction.
DROP INDEX IF EXISTS idx_radar_calendar_revision;
CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_calendar_observation
 ON radar_update_proposals(player_key, json_extract(proposed_payload,'$.calendarContext.sourceUrl'),
 json_extract(proposed_payload,'$.calendarContext.revision'),json_extract(proposed_payload,'$.calendarContext.sourceCapturedAt'))
 WHERE json_extract(proposed_payload,'$.calendarContext.sourceUrl') IS NOT NULL;
-- Concurrent imports cannot create multiple pending decisions or resurrect rejected revisions.
CREATE TRIGGER IF NOT EXISTS radar_calendar_pending_or_rejected
BEFORE INSERT ON radar_update_proposals
WHEN json_extract(NEW.proposed_payload,'$.calendarContext.sourceUrl') IS NOT NULL
 AND EXISTS (SELECT 1 FROM radar_update_proposals p WHERE p.player_key=NEW.player_key
 AND json_extract(p.proposed_payload,'$.calendarContext.sourceUrl')=json_extract(NEW.proposed_payload,'$.calendarContext.sourceUrl')
 AND json_extract(p.proposed_payload,'$.calendarContext.revision')=json_extract(NEW.proposed_payload,'$.calendarContext.revision')
 AND p.status IN ('pending','publishing','rejected'))
BEGIN SELECT RAISE(ABORT,'Calendar revision already pending or rejected'); END;
CREATE TABLE IF NOT EXISTS radar_write_permits(player_key TEXT PRIMARY KEY, old_payload TEXT NOT NULL, new_payload TEXT NOT NULL);
-- A legacy v22 GET/owner write must fail loudly rather than overwrite an approved record.
-- The current publisher reserves a 'publishing' proposal inside its transaction first.
CREATE TRIGGER IF NOT EXISTS radar_protect_approved_update
BEFORE UPDATE OF payload ON radar_entries
WHEN NEW.payload IS NOT OLD.payload
 AND EXISTS (SELECT 1 FROM radar_publication_history h WHERE h.player_key=OLD.player_key AND h.published_payload=OLD.payload AND h.reverted_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM radar_update_proposals p WHERE p.player_key=OLD.player_key AND p.proposed_payload=NEW.payload AND p.status='publishing' AND p.current_payload IS OLD.payload)
 AND NOT EXISTS (SELECT 1 FROM radar_write_permits w WHERE w.player_key=OLD.player_key AND w.old_payload=OLD.payload AND w.new_payload=NEW.payload)
BEGIN SELECT RAISE(ABORT,'Approved Radar record protected: legacy update denied'); END;
CREATE TRIGGER IF NOT EXISTS radar_protect_approved_delete
BEFORE DELETE ON radar_entries
WHEN EXISTS (SELECT 1 FROM radar_publication_history h WHERE h.player_key=OLD.player_key AND h.published_payload=OLD.payload AND h.reverted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'Approved Radar record protected: deletion denied'); END;
CREATE TABLE IF NOT EXISTS radar_intake_packets(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,reader_run_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_radar_intake_run ON radar_intake_packets(reader_run_id);
CREATE TRIGGER IF NOT EXISTS radar_intake_run_bound
BEFORE INSERT ON radar_intake_packets
WHEN NOT EXISTS(SELECT 1 FROM radar_intake_packets WHERE id=NEW.id)
 AND (SELECT COUNT(*) FROM radar_intake_packets WHERE reader_run_id=NEW.reader_run_id)>=8
BEGIN SELECT RAISE(ABORT,'Reader run packet limit exceeded'); END;
