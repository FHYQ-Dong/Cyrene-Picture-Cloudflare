import { ErrorCode, jsonError, jsonOk } from "../_shared/errors.js";
import { getConfig } from "../_shared/env.js";
import {
	createOrReuseImageObject,
	createUploadEvent,
	getImageObjectById,
	getLatestImageByObjectKey,
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

async function computeObjectContentHash(env, objectKey) {
	const object = await env.R2.get(objectKey);
	if (!object) return "";
	const bytes = await object.arrayBuffer();
	return sha256HexFromArrayBuffer(bytes);
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
		const normalizedNickname = normalizeUploaderNickname(
			body.uploaderNickname,
			config.uploaderNicknameMaxLength
		);

		const requestedHash = normalizeContentHash(body.contentHash);
		const requestedObjectId = String(body.dedupObjectId || "").trim();

		let objectKey = String(body.objectKey || "").trim();
		let contentHash = requestedHash;
		let uploadMode = "normal";
		let dedupHit = false;
		let imageObject = null;

		if (requestedObjectId) {
			const dedupObject = await getImageObjectById(
				env.DB,
				requestedObjectId
			);
			if (!dedupObject) {
				return jsonError(
					ErrorCode.ObjectNotFound,
					"dedup object not found",
					404
				);
			}

			objectKey = dedupObject.object_key;
			contentHash = dedupObject.content_hash;
			uploadMode = "instant";
			dedupHit = true;
			imageObject = await createOrReuseImageObject(env.DB, {
				objectId: crypto.randomUUID(),
				contentHash,
				objectKey,
				mime: dedupObject.mime,
				size: Number(dedupObject.size_bytes || body.size),
				etag: dedupObject.r2_etag,
			});
		} else {
			if (!objectKey) {
				return jsonError(
					ErrorCode.InvalidRequest,
					"missing objectKey",
					400
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
		const thumbObjectKey = createThumbObjectKey(
			objectKey,
			imageId,
			config.thumbnailFormat
		);
		const inheritedThumbReady =
			latestForObject && latestForObject.thumb_status === "ready";

		await upsertImageMetadata(env.DB, {
			imageId,
			objectId: imageObject.object_id,
			uploadEventId,
			contentHash,
			uploadMode,
			objectKey,
			publicUrl,
			mime: body.mime,
			size: Number(imageObject.size_bytes || body.size),
			uploaderNickname: normalizedNickname.nickname,
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

		if (
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
			uploadMode,
			dedupHit,
			publicUrl,
			thumbUrl: inheritedThumbReady
				? latestForObject.thumb_public_url
				: null,
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
