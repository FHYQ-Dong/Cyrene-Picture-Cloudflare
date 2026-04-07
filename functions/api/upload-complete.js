import { ErrorCode, jsonError, jsonOk } from "../_shared/errors.js";
import { getConfig } from "../_shared/env.js";
import {
	createOrReuseImageObject,
	addTagsToImage,
	consumeUploadTokenRecord,
	createUploadEvent,
	getImageObjectByHash,
	getImageObjectById,
	getLatestActiveImageByHashAndUploader,
	getLatestImageByObjectKey,
	normalizeTagsInput,
	touchImageUploadTime,
	upsertImageMetadata,
} from "../_shared/db.js";
import { writeLog } from "../_shared/log.js";
import { resolveImageUrl } from "../_shared/image-url.js";
import { normalizeUploaderNickname } from "../_shared/nickname.js";
import {
	normalizeContentHash,
	sha256HexFromArrayBuffer,
} from "../_shared/hash.js";
import {
	createThumbObjectKey,
	processThumbnailJob,
} from "../_shared/thumbnail.js";
import { verifyUploadTokenSignature } from "../_shared/upload-token.js";

async function computeObjectContentHash(env, objectKey) {
	const object = await env.R2.get(objectKey);
	if (!object) return "";
	const bytes = await object.arrayBuffer();
	return sha256HexFromArrayBuffer(bytes);
}

function normalizeDimension(rawValue) {
	const value = Number(rawValue);
	if (!Number.isFinite(value)) return null;
	const normalized = Math.trunc(value);
	return normalized > 0 ? normalized : null;
}

function inferMediaTypeFromMime(mime) {
	const normalized = String(mime || "")
		.trim()
		.toLowerCase();
	if (normalized.startsWith("image/")) return "image";
	if (normalized.startsWith("audio/")) return "audio";
	return "";
}

function normalizeDurationSeconds(rawValue) {
	if (rawValue == null || rawValue === "") return null;
	const value = Number(rawValue);
	if (!Number.isFinite(value)) return null;
	return value > 0 ? value : null;
}

export async function onRequestPost(context) {
	const { request, env, waitUntil } = context;
	const config = getConfig(env);
	const requestId = crypto.randomUUID();

	try {
		const body = await request.json().catch(() => null);
		if (!body || !body.mime || typeof body.size !== "number") {
			return jsonError(
				ErrorCode.InvalidRequest,
				"invalid request body",
				400
			);
		}

		const imageId = crypto.randomUUID();
		const uploadEventId = crypto.randomUUID();
		const tags = normalizeTagsInput(body.tags, 10, 30);
		const normalizedNickname = normalizeUploaderNickname(
			body.uploaderNickname,
			config.uploaderNicknameMaxLength
		);

		const requestedHash = normalizeContentHash(body.contentHash);
		const requestedObjectId = String(body.dedupObjectId || "").trim();
		const uploadToken = String(body.uploadToken || "").trim();
		const inferredMediaType = inferMediaTypeFromMime(body.mime);
		if (!inferredMediaType) {
			return jsonError(ErrorCode.MimeNotAllowed, "mime not allowed", 400);
		}
		const requestedMediaType = String(body.mediaType || "")
			.trim()
			.toLowerCase();
		if (requestedMediaType && requestedMediaType !== inferredMediaType) {
			return jsonError(
				ErrorCode.InvalidRequest,
				"media type mismatch",
				400
			);
		}
		const mediaType = inferredMediaType;
		const audioTitle =
			mediaType === "audio" ? String(body.audioTitle || "").trim() : null;
		if (mediaType === "audio" && !audioTitle) {
			return jsonError(
				ErrorCode.AudioTitleRequired,
				"audio title is required",
				400
			);
		}
		const durationSeconds =
			mediaType === "audio"
				? normalizeDurationSeconds(body.durationSeconds)
				: null;
		const width =
			mediaType === "image" ? normalizeDimension(body.width) : null;
		const height =
			mediaType === "image" ? normalizeDimension(body.height) : null;

		let objectKey = String(body.objectKey || "").trim();
		let contentHash = requestedHash;
		let uploadMode = "normal";
		let dedupHit = false;
		let imageObject = null;
		let existingImageForUploader = null;

		if (requestedObjectId) {
			const dedupObject = await getImageObjectById(
				env.DB,
				requestedObjectId
			);
			if (!dedupObject || Number(dedupObject.ref_count) <= 0) {
				return jsonError(
					ErrorCode.ObjectNotFound,
					"dedup object not found or deleted",
					404
				);
			}

			objectKey = dedupObject.object_key;
			contentHash = dedupObject.content_hash;
			uploadMode = "instant";
			dedupHit = true;
			imageObject = dedupObject;
		} else {
			if (!objectKey) {
				return jsonError(
					ErrorCode.InvalidRequest,
					"missing objectKey",
					400
				);
			}

			if (config.uploadCompleteRequireToken && !uploadToken) {
				return jsonError(
					ErrorCode.UploadTokenMissing,
					"missing uploadToken",
					403
				);
			}

			if (uploadToken) {
				const verified = await verifyUploadTokenSignature(
					config,
					uploadToken
				);
				if (!verified.ok) {
					const reason = verified.reason;
					if (reason === "UPLOAD_TOKEN_SECRET_MISSING") {
						return jsonError(
							ErrorCode.ConfigMissing,
							"missing UPLOAD_TOKEN_SECRET",
							500,
							{ required: ["UPLOAD_TOKEN_SECRET"] }
						);
					}
					return jsonError(
						ErrorCode.UploadTokenInvalid,
						"invalid uploadToken",
						403
					);
				}

				const tokenPayload = verified.payload || {};
				if (new Date(tokenPayload.expiresAt).getTime() < Date.now()) {
					return jsonError(
						ErrorCode.UploadTokenExpired,
						"uploadToken expired",
						403
					);
				}

				const sameObjectKey = tokenPayload.objectKey === objectKey;
				const sameMime = tokenPayload.mime === body.mime;
				const sameSize =
					Number(tokenPayload.size) === Number(body.size);
				if (!sameObjectKey || !sameMime || !sameSize) {
					return jsonError(
						ErrorCode.UploadTokenBindingMismatch,
						"uploadToken binding mismatch",
						403
					);
				}

				const consumed = await consumeUploadTokenRecord(env.DB, {
					tokenId: tokenPayload.jti,
					objectKey,
					mime: body.mime,
					size: body.size,
				});
				if (!consumed) {
					return jsonError(
						ErrorCode.UploadTokenAlreadyUsed,
						"uploadToken already used or expired",
						403
					);
				}
			} else if (config.uploadCompleteRequireToken) {
				return jsonError(
					ErrorCode.UploadTokenMissing,
					"missing uploadToken",
					403
				);
			}

			const object = await env.R2.head(objectKey);
			if (!object) {
				return jsonError(
					ErrorCode.ObjectNotFound,
					"object not found",
					404
				);
			}

			contentHash =
				requestedHash ||
				(await computeObjectContentHash(env, objectKey));
			if (!contentHash) {
				return jsonError(
					ErrorCode.InternalError,
					"failed to compute content hash",
					500
				);
			}
		}

		existingImageForUploader = await getLatestActiveImageByHashAndUploader(
			env.DB,
			contentHash,
			normalizedNickname.nickname,
			mediaType
		);

		if (existingImageForUploader) {
			uploadMode = "instant";
			dedupHit = true;
			if (!requestedObjectId) {
				const existingObject = await getImageObjectByHash(
					env.DB,
					contentHash
				);
				if (
					existingObject?.object_key &&
					existingObject.object_key !== objectKey
				) {
					await env.R2.delete(body.objectKey).catch(() => null);
				}
			}

			await touchImageUploadTime(
				env.DB,
				existingImageForUploader.image_id
			);

			await addTagsToImage(
				env.DB,
				existingImageForUploader.image_id,
				tags,
				existingImageForUploader.media_type || mediaType
			);

			const reusedPublicUrl =
				existingImageForUploader.public_url ||
				resolveImageUrl(config, existingImageForUploader.object_key);

			writeLog("info", {
				request_id: requestId,
				route: "POST /api/upload-complete",
				status_code: 200,
				image_id: existingImageForUploader.image_id,
				bytes_in: Number(
					existingImageForUploader.size_bytes || body.size || 0
				),
				upload_mode: "reuse_existing",
				dedup_hit: true,
				content_hash: contentHash,
				error_code: null,
			});

			return jsonOk({
				requestId,
				imageId: existingImageForUploader.image_id,
				objectId: existingImageForUploader.object_id,
				uploadEventId: existingImageForUploader.upload_event_id,
				contentHash,
				mediaType: existingImageForUploader.media_type || mediaType,
				uploadMode: "reuse_existing",
				dedupHit: true,
				publicUrl: reusedPublicUrl,
				thumbUrl:
					existingImageForUploader.thumb_status === "ready"
						? existingImageForUploader.thumb_public_url
						: null,
				durationSeconds:
					existingImageForUploader.duration_seconds ?? null,
				audioTitle: existingImageForUploader.audio_title || null,
				tags,
				uploaderNickname: normalizedNickname.nickname,
				status: "active",
				reusedExistingImage: true,
			});
		}

		if (requestedObjectId) {
			const dedupObject = imageObject;
			imageObject = await createOrReuseImageObject(env.DB, {
				objectId: crypto.randomUUID(),
				contentHash,
				objectKey,
				mime: dedupObject.mime,
				size: Number(dedupObject.size_bytes || body.size),
				etag: dedupObject.r2_etag,
			});
		} else {
			imageObject = await createOrReuseImageObject(env.DB, {
				objectId: crypto.randomUUID(),
				contentHash,
				objectKey,
				mime: body.mime,
				size: body.size,
				etag: body.etag || "",
			});

			if (!imageObject) {
				return jsonError(
					ErrorCode.InternalError,
					"failed to save image object",
					500
				);
			}

			if (imageObject.object_key !== objectKey) {
				uploadMode = "instant";
				dedupHit = true;
				objectKey = imageObject.object_key;
				await env.R2.delete(body.objectKey).catch(() => null);
			}
		}

		if (!imageObject) {
			return jsonError(
				ErrorCode.InternalError,
				"failed to save image object",
				500
			);
		}

		await createUploadEvent(env.DB, {
			uploadEventId,
			objectId: imageObject.object_id,
			sourceBatchId: String(body.batchId || "").trim() || null,
			sourceClientFileId: String(body.clientFileId || "").trim() || null,
			uploaderNickname: normalizedNickname.nickname,
			uploadMode,
		});

		const publicUrl = resolveImageUrl(config, objectKey);
		const latestForObject = await getLatestImageByObjectKey(
			env.DB,
			objectKey
		);
		const thumbObjectKey =
			mediaType === "image"
				? createThumbObjectKey(
						objectKey,
						imageId,
						config.thumbnailFormat
				  )
				: null;
		const inheritedThumbReady =
			mediaType === "image" &&
			latestForObject &&
			latestForObject.thumb_status === "ready";

		await upsertImageMetadata(env.DB, {
			imageId,
			objectId: imageObject.object_id,
			uploadEventId,
			contentHash,
			uploadMode,
			objectKey,
			publicUrl,
			mediaType,
			mime: body.mime,
			size: Number(imageObject.size_bytes || body.size),
			uploaderNickname: normalizedNickname.nickname,
			durationSeconds,
			audioTitle,
			width,
			height,
			thumbObjectKey: inheritedThumbReady
				? latestForObject.thumb_object_key
				: null,
			thumbPublicUrl: inheritedThumbReady
				? latestForObject.thumb_public_url
				: null,
			thumbStatus: inheritedThumbReady
				? "ready"
				: config.thumbnailEnabled
				? "pending"
				: "none",
			status: "active",
		});

		await addTagsToImage(env.DB, imageId, tags, mediaType);

		if (
			mediaType === "image" &&
			config.thumbnailEnabled &&
			typeof waitUntil === "function" &&
			!inheritedThumbReady &&
			uploadMode !== "instant"
		) {
			waitUntil(
				processThumbnailJob(env, config, {
					imageId,
					objectKey,
					thumbObjectKey,
					mime: body.mime,
				})
			);
		}

		writeLog("info", {
			request_id: requestId,
			route: "POST /api/upload-complete",
			status_code: 200,
			image_id: imageId,
			bytes_in: Number(imageObject.size_bytes || body.size),
			upload_mode: uploadMode,
			dedup_hit: dedupHit,
			content_hash: contentHash,
			error_code: null,
		});

		return jsonOk({
			requestId,
			imageId,
			objectId: imageObject.object_id,
			uploadEventId,
			contentHash,
			mediaType,
			uploadMode,
			dedupHit,
			publicUrl,
			thumbUrl: inheritedThumbReady
				? latestForObject.thumb_public_url
				: null,
			durationSeconds,
			audioTitle,
			tags,
			uploaderNickname: normalizedNickname.nickname,
			status: "active",
		});
	} catch (error) {
		writeLog("error", {
			request_id: requestId,
			route: "POST /api/upload-complete",
			status_code: 500,
			error_code: ErrorCode.InternalError,
			message: String(error),
		});
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
