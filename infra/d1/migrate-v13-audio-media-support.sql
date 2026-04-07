ALTER TABLE images ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE images ADD COLUMN duration_seconds REAL;
ALTER TABLE images ADD COLUMN audio_title TEXT;

UPDATE images
SET media_type = 'image'
WHERE media_type IS NULL OR TRIM(media_type) = '';

CREATE INDEX IF NOT EXISTS idx_images_media_type_created_at ON images(media_type, created_at DESC);
