ALTER TABLE images ADD COLUMN uploader_nickname TEXT NOT NULL DEFAULT '093';

UPDATE images
SET uploader_nickname = '093'
WHERE uploader_nickname IS NULL OR TRIM(uploader_nickname) = '';

CREATE INDEX IF NOT EXISTS idx_images_uploader_created_at ON images(uploader_nickname, created_at DESC);
