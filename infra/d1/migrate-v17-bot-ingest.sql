CREATE TABLE IF NOT EXISTS bot_ingest_logs (
  ingest_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  group_id TEXT,
  message_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  image_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_ingest_logs_created_at
  ON bot_ingest_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS bot_ingest_candidates (
  candidate_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT,
  image_url TEXT,
  content_hash TEXT,
  quality_score REAL,
  default_tags_json TEXT,
  manual_tags_json TEXT,
  final_tags_json TEXT,
  meta_json TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_candidates_status_created
  ON bot_ingest_candidates(status, created_at DESC);
