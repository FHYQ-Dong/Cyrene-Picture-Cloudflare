import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { onRequestPost as completeSingleUpload } from "../upload-complete.js";

const MAX_BATCH_ITEMS = 20;

function normalizeItems(rawItems) {
	if (!Array.isArray(rawItems)) return [];
	return rawItems.slice(0, MAX_BATCH_ITEMS).map((item, index) => ({
		clientFileId: String(item?.clientFileId || `item-${index}`),
		dedupHit: Boolean(item?.dedupHit),
		dedupObjectId: String(item?.dedupObjectId || "").trim(),
		contentHash: String(item?.contentHash || "").trim(),
		objectKey: String(item?.objectKey || "").trim(),
		mime: String(item?.mime || "").toLowerCase(),
		size: Number(item?.size || 0),
		etag: String(item?.etag || "").trim(),
		uploaderNickname: item?.uploaderNickname,
		batchId: item?.batchId,
		originalFilename: item?.originalFilename,
	}));
}

export async function onRequestPost(context) {
	const { request, env, waitUntil } = context;

	try {
		const body = await request.json().catch(() => null);
		const batchId = String(body?.batchId || crypto.randomUUID());
		const items = normalizeItems(body?.items);
		if (!items.length) {
			return jsonError(ErrorCode.InvalidRequest, "invalid items", 400);
		}

		const results = [];
		for (const item of items) {
			const singleRequestPayload = {
				clientFileId: item.clientFileId,
				batchId,
				contentHash: item.contentHash || null,
				dedupObjectId: item.dedupHit ? item.dedupObjectId : null,
				objectKey: item.objectKey || null,
				mime: item.mime,
				size: item.size,
				etag: item.etag,
				uploaderNickname: item.uploaderNickname,
				originalFilename: item.originalFilename,
			};

			const singleRequest = new Request(
				new URL("/api/upload-complete", request.url).toString(),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify(singleRequestPayload),
				}
			);

			const singleResponse = await completeSingleUpload({
				request: singleRequest,
				env,
				waitUntil,
			});
			const singlePayload = await singleResponse.json();
			if (!singlePayload?.ok) {
				results.push({
					clientFileId: item.clientFileId,
					ok: false,
					errorCode:
						singlePayload?.error?.code || ErrorCode.InternalError,
					message:
						singlePayload?.error?.message ||
						"upload complete failed",
				});
				continue;
			}

			results.push({
				clientFileId: item.clientFileId,
				ok: true,
				...singlePayload.data,
			});
		}

		const successCount = results.filter((item) => item.ok).length;
		const failedCount = results.length - successCount;

		return jsonOk({
			batchId,
			results,
			successCount,
			failedCount,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
