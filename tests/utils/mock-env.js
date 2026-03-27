class MockStatement {
	constructor(db, sql) {
		this.db = db;
		this.sql = sql;
		this.args = [];
	}

	bind(...args) {
		this.args = args;
		return this;
	}

	async first() {
		return this.db.first(this.sql, this.args);
	}

	async all() {
		const results = await this.db.all(this.sql, this.args);
		return { results };
	}

	async run() {
		return this.db.run(this.sql, this.args);
	}
}

class MockD1 {
	constructor() {
		this.imageObjectsByHash = new Map();
		this.imageObjectsById = new Map();
		this.uploadEventsById = new Map();
		this.imagesById = new Map();
		this.rateMinute = new Map();
		this.quotaDaily = new Map();
	}

	prepare(sql) {
		return new MockStatement(this, sql);
	}

	key(parts) {
		return parts.join("|");
	}

	addImageObject(object) {
		const normalized = {
			object_id: object.object_id,
			content_hash: object.content_hash,
			object_key: object.object_key,
			mime: object.mime,
			size_bytes: Number(object.size_bytes || 0),
			r2_etag: object.r2_etag || null,
			ref_count: Number(object.ref_count || 1),
		};
		this.imageObjectsByHash.set(normalized.content_hash, normalized);
		this.imageObjectsById.set(normalized.object_id, normalized);
	}

	async first(sql, args) {
		if (sql.includes("SELECT request_count FROM rate_limits_minute")) {
			const mapKey = this.key(args);
			return { request_count: this.rateMinute.get(mapKey) || 0 };
		}

		if (
			sql.includes("SELECT upload_count, upload_bytes FROM quota_daily")
		) {
			const mapKey = this.key(args);
			const row = this.quotaDaily.get(mapKey) || {
				upload_count: 0,
				upload_bytes: 0,
			};
			return row;
		}

		if (
			sql.includes("FROM image_objects") &&
			sql.includes("content_hash = ?1")
		) {
			return this.imageObjectsByHash.get(args[0]) || null;
		}

		if (
			sql.includes("FROM image_objects") &&
			sql.includes("object_id = ?1")
		) {
			return this.imageObjectsById.get(args[0]) || null;
		}

		if (
			sql.includes("FROM images") &&
			sql.includes("WHERE object_key = ?1")
		) {
			const objectKey = args[0];
			const rows = Array.from(this.imagesById.values())
				.filter(
					(item) =>
						item.object_key === objectKey &&
						item.status === "active"
				)
				.sort((a, b) =>
					String(b.created_at).localeCompare(a.created_at)
				);
			return rows[0] || null;
		}

		return null;
	}

	async all(_sql, _args) {
		return [];
	}

	async run(sql, args) {
		if (sql.includes("INSERT INTO rate_limits_minute")) {
			const mapKey = this.key(args.slice(0, 3));
			const current = this.rateMinute.get(mapKey) || 0;
			this.rateMinute.set(mapKey, current + 1);
			return { success: true };
		}

		if (sql.includes("INSERT INTO quota_daily")) {
			const mapKey = this.key(args.slice(0, 3));
			const current = this.quotaDaily.get(mapKey) || {
				upload_count: 0,
				upload_bytes: 0,
			};
			this.quotaDaily.set(mapKey, {
				upload_count: current.upload_count + Number(args[3] || 0),
				upload_bytes: current.upload_bytes + Number(args[4] || 0),
			});
			return { success: true };
		}

		if (sql.includes("INSERT INTO image_objects")) {
			const [objectId, contentHash, objectKey, mime, sizeBytes, r2Etag] =
				args;
			const existing = this.imageObjectsByHash.get(contentHash);
			if (existing) {
				existing.ref_count = Number(existing.ref_count || 0) + 1;
				this.imageObjectsByHash.set(contentHash, existing);
				this.imageObjectsById.set(existing.object_id, existing);
			} else {
				this.addImageObject({
					object_id: objectId,
					content_hash: contentHash,
					object_key: objectKey,
					mime,
					size_bytes: sizeBytes,
					r2_etag: r2Etag,
					ref_count: 1,
				});
			}
			return { success: true };
		}

		if (sql.includes("INSERT INTO image_upload_events")) {
			const [
				uploadEventId,
				objectId,
				sourceBatchId,
				sourceClientFileId,
				uploaderNickname,
				uploadMode,
			] = args;
			this.uploadEventsById.set(uploadEventId, {
				upload_event_id: uploadEventId,
				object_id: objectId,
				source_batch_id: sourceBatchId,
				source_client_file_id: sourceClientFileId,
				uploader_nickname: uploaderNickname,
				upload_mode: uploadMode,
			});
			return { success: true };
		}

		if (
			sql.includes("INSERT INTO images (") ||
			sql.includes("INSERT INTO images\n")
		) {
			const [
				imageId,
				objectId,
				uploadEventId,
				contentHash,
				uploadMode,
				objectKey,
				publicUrl,
				thumbObjectKey,
				thumbPublicUrl,
				thumbStatus,
				mime,
				sizeBytes,
				uploaderNickname,
				width,
				height,
				status,
				createdAt,
				updatedAt,
			] = args;
			this.imagesById.set(imageId, {
				image_id: imageId,
				object_id: objectId,
				upload_event_id: uploadEventId,
				content_hash: contentHash,
				upload_mode: uploadMode,
				object_key: objectKey,
				public_url: publicUrl,
				thumb_object_key: thumbObjectKey,
				thumb_public_url: thumbPublicUrl,
				thumb_status: thumbStatus,
				mime,
				size_bytes: sizeBytes,
				uploader_nickname: uploaderNickname,
				width,
				height,
				status,
				created_at: createdAt,
				updated_at: updatedAt,
			});
			return { success: true };
		}

		if (sql.includes("UPDATE images") && sql.includes("thumb_status")) {
			const [imageId, thumbObjectKey, thumbPublicUrl, thumbStatus] = args;
			const row = this.imagesById.get(imageId);
			if (row) {
				if (thumbObjectKey != null)
					row.thumb_object_key = thumbObjectKey;
				if (thumbPublicUrl != null)
					row.thumb_public_url = thumbPublicUrl;
				if (thumbStatus != null) row.thumb_status = thumbStatus;
			}
			return { success: true };
		}

		return { success: true };
	}
}

class MockR2 {
	constructor() {
		this.objects = new Map();
	}

	setObject(key, payload) {
		this.objects.set(key, {
			body: payload.body || new Uint8Array(),
			etag: payload.etag || "etag-test",
			contentType: payload.contentType || "image/png",
		});
	}

	async head(key) {
		const item = this.objects.get(key);
		if (!item) return null;
		return { etag: item.etag };
	}

	async get(key) {
		const item = this.objects.get(key);
		if (!item) return null;
		return {
			arrayBuffer: async () => {
				if (item.body instanceof ArrayBuffer) return item.body;
				if (ArrayBuffer.isView(item.body)) {
					return item.body.buffer.slice(
						item.body.byteOffset,
						item.body.byteOffset + item.body.byteLength
					);
				}
				return new TextEncoder().encode(String(item.body)).buffer;
			},
		};
	}

	async put(key, body, options = {}) {
		this.objects.set(key, {
			body,
			etag: "etag-put",
			contentType: options?.httpMetadata?.contentType || "image/webp",
		});
		return { etag: "etag-put" };
	}

	async delete(key) {
		this.objects.delete(key);
	}
}

export function createMockContextEnv(overrides = {}) {
	const DB = new MockD1();
	const R2 = new MockR2();
	const env = {
		DB,
		R2,
		MAX_FILE_SIZE: "209715200",
		UPLOAD_RATE_LIMIT_PER_MIN_VISITOR: "30",
		UPLOAD_RATE_LIMIT_PER_MIN_IP: "120",
		MAX_VISITOR_UPLOAD_COUNT_DAILY: "500",
		MAX_VISITOR_UPLOAD_BYTES_DAILY: "2147483648",
		MAX_IP_UPLOAD_COUNT_DAILY: "1500",
		MAX_IP_UPLOAD_BYTES_DAILY: "6442450944",
		MAX_GLOBAL_UPLOAD_COUNT_DAILY: "10000",
		MAX_GLOBAL_UPLOAD_BYTES_DAILY: "42949672960",
		UPLOAD_URL_TTL_SECONDS: "900",
		PUBLIC_IMAGE_BASE_URL: "https://img.example.com",
		LOCAL_UPLOAD_DIRECT: "true",
		TURNSTILE_ENFORCED: "false",
		THUMBNAIL_ENABLED: "false",
		...overrides,
	};
	return { env, DB, R2 };
}
