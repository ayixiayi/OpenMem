-- Upgrade the Python 001 schema, preserving IDs, values and validity intervals.
-- Legacy records have no recorded update time: keep it NULL, not invented.
ALTER TABLE temporal_facts RENAME COLUMN obj TO object;
ALTER TABLE temporal_facts ADD COLUMN user_id TEXT;
ALTER TABLE temporal_facts ADD COLUMN last_updated INTEGER;
CREATE INDEX idx_temporal_user ON temporal_facts(user_id);

ALTER TABLE temporal_edges RENAME COLUMN relation TO relation_type;
ALTER TABLE temporal_edges ADD COLUMN id TEXT;
UPDATE temporal_edges SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX idx_temporal_edge_id ON temporal_edges(id);
