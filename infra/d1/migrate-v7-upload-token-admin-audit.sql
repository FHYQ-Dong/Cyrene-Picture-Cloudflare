CREATE TABLE IF NOT EXISTS upload_tokens (
  token_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  issued_visitor_id TEXT,
  issued_ip_hash TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_tokens_expires_at ON upload_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_object_key ON upload_tokens(object_key);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_consumed_at ON upload_tokens(consumed_at);

CREATE TABLE IF NOT EXISTS admin_action_logs (
  action_id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  actor_token_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  request_id TEXT,
  params_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_action_logs_created_at ON admin_action_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_logs_action_type ON admin_action_logs(action_type, created_at DESC);