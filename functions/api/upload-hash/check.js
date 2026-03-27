import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { normalizeContentHash } from "../../_shared/hash.js";
import { getImageObjectByHash } from "../../_shared/db.js";

function normalizeItems(input) {
	if (!Array.isArray(input)) return [];
	return input.slice(0, 20).map((item, index) => ({
		clientFileId: String(item?.clientFileId || `item-${index}`),
		fileName: String(item?.fileName || "").trim(),
		mime: String(item?.mime || "").toLowerCase(),
		size: Number(item?.size || 0),
		contentHash: normalizeContentHash(item?.contentHash),
		uploaderNickname: String(item?.uploaderNickname || "").trim(),
		batchId: String(item?.batchId || "").trim(),
	}));
}

export async function onRequestPost(context) {
	const { request, env } = context;
	const config = getConfig(env);

	try {
		const body = await request.json().catch(() => null);
		const items = normalizeItems(body?.items);
		if (!items.length) {
			return jsonError(ErrorCode.InvalidRequest, "invalid items", 400);
		}

		const results = [];
		for (const item of items) {
			if (!item.fileName || !item.mime || !item.contentHash) {
				results.push({
					clientFileId: item.clientFileId,
					exists: false,
					dedupHit: false,
					errorCode: ErrorCode.InvalidRequest,
					message: "invalid item fields",
				});
				continue;
			}

			if (!config.allowedMime.has(item.mime)) {
				results.push({
					clientFileId: item.clientFileId,
					exists: false,
					dedupHit: false,
					errorCode: ErrorCode.MimeNotAllowed,
					message: "mime not allowed",
				});
				continue;
			}

			if (item.size <= 0 || item.size > config.maxFileSize) {
				results.push({
					clientFileId: item.clientFileId,
					exists: false,
					dedupHit: false,
					errorCode: ErrorCode.UploadSizeExceeded,
					message: "file size exceeded",
				});
				continue;
			}

			const object = await getImageObjectByHash(env.DB, item.contentHash);
			if (object) {
				results.push({
					clientFileId: item.clientFileId,
					exists: true,
					dedupHit: true,
					objectId: object.object_id,
					objectKey: object.object_key,
					contentHash: object.content_hash,
				});
				continue;
			}

			results.push({
				clientFileId: item.clientFileId,
				exists: false,
				dedupHit: false,
				contentHash: item.contentHash,
			});
		}

		const hitCount = results.filter((item) => item.exists).length;
		const missCount = results.length - hitCount;
		return jsonOk({
			results,
			hitCount,
			missCount,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
