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
		this.botCandidatesById = new Map();
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

	addImage(image) {
		const imageId = String(image.image_id || crypto.randomUUID());
		const normalized = {
			image_id: imageId,
			object_id: image.object_id || null,
			upload_event_id: image.upload_event_id || null,
			content_hash: image.content_hash || null,
			upload_mode: image.upload_mode || null,
			object_key: image.object_key || `public/mock/${imageId}.png`,
			public_url: image.public_url || null,
			thumb_object_key: image.thumb_object_key || null,
			thumb_public_url: image.thumb_public_url || null,
			thumb_status: image.thumb_status || "none",
			media_type: image.media_type || "image",
			mime: image.mime || "image/png",
			size_bytes: Number(image.size_bytes || 0),
			uploader_nickname: image.uploader_nickname || "093",
			duration_seconds: image.duration_seconds ?? null,
			audio_title: image.audio_title || null,
			width: image.width || null,
			height: image.height || null,
			status: image.status || "active",
			created_at: image.created_at || new Date().toISOString(),
			updated_at: image.updated_at || new Date().toISOString(),
		};
		this.imagesById.set(imageId, normalized);
	}

	addBotCandidate(candidate) {
		const candidateId = String(
			candidate.candidate_id ||
				candidate.candidateId ||
				crypto.randomUUID()
		);
		const normalized = {
			candidate_id: candidateId,
			group_id: String(candidate.group_id || candidate.groupId || ""),
			message_id: String(
				candidate.message_id || candidate.messageId || ""
			),
			sender_id: String(candidate.sender_id || candidate.senderId || ""),
			image_url: String(candidate.image_url || candidate.imageUrl || ""),
			content_hash: String(
				candidate.content_hash || candidate.contentHash || ""
			),
			quality_score:
				candidate.quality_score ?? candidate.qualityScore ?? null,
			default_tags_json:
				typeof candidate.default_tags_json === "string"
					? candidate.default_tags_json
					: JSON.stringify(candidate.default_tags || []),
			manual_tags_json:
				typeof candidate.manual_tags_json === "string"
					? candidate.manual_tags_json
					: JSON.stringify(candidate.manual_tags || []),
			final_tags_json:
				typeof candidate.final_tags_json === "string"
					? candidate.final_tags_json
					: JSON.stringify(candidate.final_tags || []),
			meta_json:
				typeof candidate.meta_json === "string"
					? candidate.meta_json
					: JSON.stringify(candidate.meta || {}),
			status: String(candidate.status || "pending"),
			reason: String(candidate.reason || ""),
			created_at: candidate.created_at || new Date().toISOString(),
			reviewed_at: candidate.reviewed_at || null,
		};
		this.botCandidatesById.set(candidateId, normalized);
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
			sql.includes("FROM bot_ingest_candidates") &&
			sql.includes("WHERE candidate_id = ?1")
		) {
			return this.botCandidatesById.get(String(args[0] || "")) || null;
		}

		if (
			sql.includes("FROM images") &&
			sql.includes("content_hash = ?1") &&
			sql.includes("uploader_nickname = ?2")
		) {
			const contentHash = args[0];
			const uploaderNickname = args[1];
			const wantsAudio = sql.includes("media_type = 'audio'");
			const rows = Array.from(this.imagesById.values())
				.filter((item) => {
					if (item.status !== "active") return false;
					if (item.content_hash !== contentHash) return false;
					if (item.uploader_nickname !== uploaderNickname)
						return false;
					if (wantsAudio) return item.media_type === "audio";
					return (
						!item.media_type ||
						item.media_type === "image" ||
						String(item.media_type).trim() === ""
					);
				})
				.sort((a, b) =>
					String(b.created_at).localeCompare(a.created_at)
				);
			return rows[0] || null;
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

		if (
			sql.includes("FROM images") &&
			sql.includes("WHERE image_id = ?1")
		) {
			return this.imagesById.get(args[0]) || null;
		}

		return null;
	}

	async all(sql, args) {
		if (
			sql.includes("FROM bot_ingest_candidates") &&
			sql.includes("ORDER BY created_at DESC")
		) {
			let index = 0;
			let status = "";
			let groupId = "";
			let cursor = "";

			if (sql.includes("status = ?")) {
				status = String(args[index++] || "")
					.trim()
					.toLowerCase();
			}
			if (sql.includes("group_id = ?")) {
				groupId = String(args[index++] || "").trim();
			}
			if (sql.includes("created_at < ?")) {
				cursor = String(args[index++] || "").trim();
			}
			const limit = Number(args[index] || 50);

			const rows = Array.from(this.botCandidatesById.values())
				.filter((item) => {
					if (status && item.status !== status) return false;
					if (groupId && item.group_id !== groupId) return false;
					if (cursor && String(item.created_at) >= String(cursor)) {
						return false;
					}
					return true;
				})
				.sort((a, b) =>
					String(b.created_at).localeCompare(a.created_at)
				);

			return rows.slice(0, limit);
		}

		if (
			sql.includes("FROM images") &&
			sql.includes("ORDER BY created_at DESC")
		) {
			const wantsAudio = sql.includes("media_type = 'audio'");
			const hasCursor = sql.includes("created_at < ?1");
			const hasUploader =
				sql.includes("uploader_nickname = ?") ||
				sql.includes("uploader_nickname = ?2") ||
				sql.includes("uploader_nickname = ?1");

			let cursor = null;
			let uploader = null;
			let limit = 20;

			if (hasCursor && hasUploader) {
				cursor = args[0] || null;
				uploader = args[1] || null;
				limit = Number(args[2] || 20);
			} else if (hasUploader) {
				uploader = args[0] || null;
				limit = Number(args[1] || 20);
			} else if (hasCursor) {
				cursor = args[0] || null;
				limit = Number(args[1] || 20);
			} else {
				limit = Number(args[0] || 20);
			}

			const rows = Array.from(this.imagesById.values())
				.filter((item) => {
					if (item.status !== "active") return false;
					if (cursor && String(item.created_at) >= String(cursor)) {
						return false;
					}
					if (uploader && item.uploader_nickname !== uploader) {
						return false;
					}
					if (wantsAudio) return item.media_type === "audio";
					return (
						!item.media_type ||
						item.media_type === "image" ||
						String(item.media_type).trim() === ""
					);
				})
				.sort((a, b) =>
					String(b.created_at).localeCompare(a.created_at)
				);

			return rows.slice(0, limit);
		}

		if (sql.includes("SELECT DISTINCT") && sql.includes("AS nickname")) {
			const cursor =
				sql.includes("> ?1") && typeof args?.[0] === "string"
					? String(args[0])
					: "";
			const limit = Number(args?.[sql.includes("> ?1") ? 1 : 0] || 200);

			const nicknames = Array.from(this.imagesById.values())
				.filter((item) => item.status === "active")
				.map(
					(item) =>
						String(item.uploader_nickname || "093").trim() || "093"
				)
				.filter((nickname) => !cursor || nickname > cursor);

			const unique = Array.from(new Set(nicknames)).sort((left, right) =>
				left.localeCompare(right, "zh-CN")
			);

			return unique.slice(0, limit).map((nickname) => ({ nickname }));
		}

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

		if (sql.includes("INSERT INTO bot_ingest_candidates")) {
			const [
				candidateId,
				groupId,
				messageId,
				senderId,
				imageUrl,
				contentHash,
				qualityScore,
				defaultTagsJson,
				manualTagsJson,
				finalTagsJson,
				metaJson,
				status,
				reason,
				createdAt,
				reviewedAt,
			] = args;
			this.addBotCandidate({
				candidate_id: candidateId,
				group_id: groupId,
				message_id: messageId,
				sender_id: senderId,
				image_url: imageUrl,
				content_hash: contentHash,
				quality_score: qualityScore,
				default_tags_json: defaultTagsJson,
				manual_tags_json: manualTagsJson,
				final_tags_json: finalTagsJson,
				meta_json: metaJson,
				status,
				reason,
				created_at: createdAt,
				reviewed_at: reviewedAt,
			});
			return { success: true, meta: { changes: 1 } };
		}

		if (sql.includes("UPDATE bot_ingest_candidates")) {
			const [
				candidateId,
				status,
				reason,
				manualTagsJson,
				finalTagsJson,
				metaJson,
				reviewedAt,
			] = args;
			const row = this.botCandidatesById.get(String(candidateId || ""));
			if (!row) {
				return { success: true, meta: { changes: 0 } };
			}
			row.status = String(status || row.status);
			row.reason = String(reason || "");
			row.manual_tags_json = String(manualTagsJson || "[]");
			row.final_tags_json = String(finalTagsJson || "[]");
			if (metaJson != null) {
				row.meta_json = String(metaJson);
			}
			row.reviewed_at = reviewedAt || row.reviewed_at;
			this.botCandidatesById.set(String(candidateId || ""), row);
			return { success: true, meta: { changes: 1 } };
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
				mediaType,
				mime,
				sizeBytes,
				uploaderNickname,
				durationSeconds,
				audioTitle,
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
				media_type: mediaType || "image",
				mime,
				size_bytes: sizeBytes,
				uploader_nickname: uploaderNickname,
				duration_seconds: durationSeconds ?? null,
				audio_title: audioTitle || null,
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
