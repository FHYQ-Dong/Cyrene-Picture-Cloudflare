ALTER TABLE item_tags ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';

CREATE INDEX IF NOT EXISTS idx_item_tags_media_tag_image ON item_tags(media_type, tag_name, image_id);
