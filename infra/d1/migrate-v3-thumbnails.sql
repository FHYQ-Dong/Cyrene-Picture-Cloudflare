ALTER TABLE images ADD COLUMN thumb_object_key TEXT;
ALTER TABLE images ADD COLUMN thumb_public_url TEXT;
ALTER TABLE images ADD COLUMN thumb_status TEXT NOT NULL DEFAULT 'none';

UPDATE images
SET thumb_status = 'none'
WHERE thumb_status IS NULL OR TRIM(thumb_status) = '';

CREATE INDEX IF NOT EXISTS idx_images_thumb_status_created_at ON images(thumb_status, created_at DESC);
