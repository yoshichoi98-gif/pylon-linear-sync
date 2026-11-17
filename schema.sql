-- One row per synced entity (project, milestone, task). pylon_id is the stable key.
CREATE TABLE IF NOT EXISTS mappings (
  pylon_id          TEXT PRIMARY KEY,
  linear_id         TEXT NOT NULL,
  entity_type       TEXT NOT NULL,          -- 'project' | 'milestone' | 'task'
  pylon_parent_id   TEXT,                   -- parent task (subtasks); null for top-level
  linear_parent_id  TEXT,
  pylon_project_id  TEXT,                   -- owning Pylon project (for scoped queries)
  content_hash      TEXT,                   -- fingerprint of last-synced canonical fields
  last_modified_by  TEXT,                   -- 'pylon' | 'linear'
  last_modified_at  TEXT,                   -- ISO timestamp
  status            TEXT DEFAULT 'active'   -- 'active' | 'cancelled'
);
CREATE INDEX IF NOT EXISTS idx_mappings_linear  ON mappings(linear_id);
CREATE INDEX IF NOT EXISTS idx_mappings_project ON mappings(pylon_project_id);

-- Dedup Linear webhook deliveries (Linear-Delivery header is a UUID per delivery).
CREATE TABLE IF NOT EXISTS webhook_dedup (
  delivery_id TEXT PRIMARY KEY,
  seen_at     TEXT
);
