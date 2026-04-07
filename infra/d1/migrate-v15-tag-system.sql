CREATE TABLE IF NOT EXISTS item_tags (
  image_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (image_id, media_type, tag_name),
  FOREIGN KEY (image_id) REFERENCES images(image_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_item_tags_media_tag_image ON item_tags(media_type, tag_name, image_id);
