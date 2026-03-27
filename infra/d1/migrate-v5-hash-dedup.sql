PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS image_objects (
  object_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  r2_etag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_image_objects_created_at ON image_objects(created_at DESC);

CREATE TABLE IF NOT EXISTS image_upload_events (
  upload_event_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  source_batch_id TEXT,
  source_client_file_id TEXT,
  uploader_nickname TEXT NOT NULL,
  upload_mode TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (object_id) REFERENCES image_objects(object_id)
);

CREATE INDEX IF NOT EXISTS idx_upload_events_object_created ON image_upload_events(object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_events_batch ON image_upload_events(source_batch_id);

CREATE TABLE IF NOT EXISTS images_new (
  image_id TEXT PRIMARY KEY,
  object_id TEXT,
  upload_event_id TEXT,
  content_hash TEXT,
  upload_mode TEXT,
  object_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  thumb_object_key TEXT,
  thumb_public_url TEXT,
  thumb_status TEXT NOT NULL DEFAULT 'none',
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploader_nickname TEXT NOT NULL DEFAULT '093',
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO images_new (
  image_id,
  object_key,
  public_url,
  thumb_object_key,
  thumb_public_url,
  thumb_status,
  mime,
  size_bytes,
  uploader_nickname,
  width,
  height,
  status,
  created_at,
  updated_at
)
SELECT
  image_id,
  object_key,
  public_url,
  thumb_object_key,
  thumb_public_url,
  thumb_status,
  mime,
  size_bytes,
  COALESCE(uploader_nickname, '093'),
  width,
  height,
  status,
  created_at,
  updated_at
FROM images;

DROP TABLE images;
ALTER TABLE images_new RENAME TO images;

CREATE INDEX IF NOT EXISTS idx_images_created_at ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_thumb_status_created_at ON images(thumb_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_object_id ON images(object_id);
CREATE INDEX IF NOT EXISTS idx_images_upload_event_id ON images(upload_event_id);
CREATE INDEX IF NOT EXISTS idx_images_content_hash ON images(content_hash);

PRAGMA foreign_keys=ON;
