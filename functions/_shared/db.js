import { nowIso } from "./identity.js";

export async function upsertImageMetadata(db, payload) {
	await db
		.prepare(
			`INSERT INTO images (
			 image_id,
			 object_id,
			 upload_event_id,
			 content_hash,
			 upload_mode,
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
	   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
	   ON CONFLICT(image_id)
	   DO UPDATE SET
		 object_id = excluded.object_id,
		 upload_event_id = excluded.upload_event_id,
		 content_hash = excluded.content_hash,
		 upload_mode = excluded.upload_mode,
		 object_key = excluded.object_key,
		 public_url = excluded.public_url,
		 thumb_object_key = excluded.thumb_object_key,
		 thumb_public_url = excluded.thumb_public_url,
		 thumb_status = excluded.thumb_status,
		 mime = excluded.mime,
		 size_bytes = excluded.size_bytes,
		 uploader_nickname = excluded.uploader_nickname,
		 width = excluded.width,
		 height = excluded.height,
		 status = excluded.status,
		 updated_at = excluded.updated_at`
		)
		.bind(
			payload.imageId,
			payload.objectId || null,
			payload.uploadEventId || null,
			payload.contentHash || null,
			payload.uploadMode || null,
			payload.objectKey,
			payload.publicUrl,
			payload.thumbObjectKey || null,
			payload.thumbPublicUrl || null,
			payload.thumbStatus || "none",
			payload.mime,
			payload.size,
			payload.uploaderNickname || "093",
			payload.width || null,
			payload.height || null,
			payload.status || "active",
			nowIso(),
			nowIso()
		)
		.run();
}

export async function updateThumbnailState(db, imageId, patch) {
	await db
		.prepare(
			`UPDATE images
       SET thumb_object_key = COALESCE(?2, thumb_object_key),
           thumb_public_url = COALESCE(?3, thumb_public_url),
           thumb_status = COALESCE(?4, thumb_status),
           updated_at = ?5
       WHERE image_id = ?1`
		)
		.bind(
			imageId,
			patch.thumbObjectKey ?? null,
			patch.thumbPublicUrl ?? null,
			patch.thumbStatus ?? null,
			nowIso()
		)
		.run();
}

export async function listImages(
	db,
	limit = 20,
	cursorCreatedAt = null,
	uploaderNickname = null
) {
	if (cursorCreatedAt && uploaderNickname) {
		const rows = await db
			.prepare(
				`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status, mime, size_bytes, uploader_nickname, width, height, created_at
         FROM images
         WHERE status = 'active' AND created_at < ?1 AND uploader_nickname = ?2
         ORDER BY created_at DESC
         LIMIT ?3`
			)
			.bind(cursorCreatedAt, uploaderNickname, limit)
			.all();
		return rows.results || [];
	}

	if (uploaderNickname) {
		const rows = await db
			.prepare(
				`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status, mime, size_bytes, uploader_nickname, width, height, created_at
         FROM images
         WHERE status = 'active' AND uploader_nickname = ?1
         ORDER BY created_at DESC
         LIMIT ?2`
			)
			.bind(uploaderNickname, limit)
			.all();
		return rows.results || [];
	}

	if (cursorCreatedAt) {
		const rows = await db
			.prepare(
				`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status, mime, size_bytes, uploader_nickname, width, height, created_at
         FROM images
         WHERE status = 'active' AND created_at < ?1
         ORDER BY created_at DESC
         LIMIT ?2`
			)
			.bind(cursorCreatedAt, limit)
			.all();
		return rows.results || [];
	}

	const rows = await db
		.prepare(
			`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status, mime, size_bytes, uploader_nickname, width, height, created_at
       FROM images
       WHERE status = 'active'
       ORDER BY created_at DESC
       LIMIT ?1`
		)
		.bind(limit)
		.all();

	return rows.results || [];
}

export async function getImageById(db, imageId) {
	return db
		.prepare(
			`SELECT image_id, object_id, upload_event_id, content_hash, upload_mode, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status, mime, size_bytes, uploader_nickname, width, height, created_at, status
       FROM images
       WHERE image_id = ?1`
		)
		.bind(imageId)
		.first();
}

export async function getLatestImageByObjectKey(db, objectKey) {
	return db
		.prepare(
			`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status
       FROM images
       WHERE object_key = ?1 AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 1`
		)
		.bind(objectKey)
		.first();
}

export async function getImageObjectByHash(db, contentHash) {
	return db
		.prepare(
			`SELECT object_id, content_hash, object_key, mime, size_bytes, r2_etag, ref_count
       FROM image_objects
       WHERE content_hash = ?1`
		)
		.bind(contentHash)
		.first();
}

export async function getImageObjectById(db, objectId) {
	return db
		.prepare(
			`SELECT object_id, content_hash, object_key, mime, size_bytes, r2_etag, ref_count
       FROM image_objects
       WHERE object_id = ?1`
		)
		.bind(objectId)
		.first();
}

export async function createOrReuseImageObject(db, payload) {
	const timestamp = nowIso();
	await db
		.prepare(
			`INSERT INTO image_objects (object_id, content_hash, object_key, mime, size_bytes, r2_etag, created_at, updated_at, ref_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
       ON CONFLICT(content_hash)
       DO UPDATE SET ref_count = image_objects.ref_count + 1,
                     updated_at = excluded.updated_at`
		)
		.bind(
			payload.objectId,
			payload.contentHash,
			payload.objectKey,
			payload.mime,
			payload.size,
			payload.etag || null,
			timestamp,
			timestamp
		)
		.run();

	return getImageObjectByHash(db, payload.contentHash);
}

export async function createUploadEvent(db, payload) {
	const timestamp = nowIso();
	await db
		.prepare(
			`INSERT INTO image_upload_events (upload_event_id, object_id, source_batch_id, source_client_file_id, uploader_nickname, upload_mode, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
		)
		.bind(
			payload.uploadEventId,
			payload.objectId,
			payload.sourceBatchId || null,
			payload.sourceClientFileId || null,
			payload.uploaderNickname,
			payload.uploadMode,
			timestamp,
			timestamp
		)
		.run();
}

export async function getImageNeighbors(db, image) {
	const prev = await db
		.prepare(
			`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status
       FROM images
       WHERE status = 'active'
         AND (
           created_at > ?1
           OR (created_at = ?1 AND image_id > ?2)
         )
       ORDER BY created_at ASC, image_id ASC
       LIMIT 1`
		)
		.bind(image.created_at, image.image_id)
		.first();

	const next = await db
		.prepare(
			`SELECT image_id, object_key, public_url, thumb_object_key, thumb_public_url, thumb_status
       FROM images
       WHERE status = 'active'
         AND (
           created_at < ?1
           OR (created_at = ?1 AND image_id < ?2)
         )
       ORDER BY created_at DESC, image_id DESC
       LIMIT 1`
		)
		.bind(image.created_at, image.image_id)
		.first();

	return { prev: prev || null, next: next || null };
}
