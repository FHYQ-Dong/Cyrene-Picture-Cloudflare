import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { onRequestPost as completeSingleUpload } from "../upload-complete.js";

const MAX_BATCH_ITEMS = 50;

function normalizeItems(rawItems) {
	if (!Array.isArray(rawItems)) return [];
	return rawItems.map((item, index) => ({
		clientFileId: String(item?.clientFileId || `item-${index}`),
		dedupHit: Boolean(item?.dedupHit),
		dedupObjectId: String(item?.dedupObjectId || "").trim(),
		contentHash: String(item?.contentHash || "").trim(),
		uploadToken: String(item?.uploadToken || "").trim(),
		objectKey: String(item?.objectKey || "").trim(),
		mime: String(item?.mime || "").toLowerCase(),
		size: Number(item?.size || 0),
		etag: String(item?.etag || "").trim(),
		mediaType: String(item?.mediaType || "")
			.trim()
			.toLowerCase(),
		durationSeconds: Number(item?.durationSeconds || 0),
		audioTitle: String(item?.audioTitle || "").trim(),
		width: Number(item?.width || 0),
		height: Number(item?.height || 0),
		uploaderNickname: item?.uploaderNickname,
		batchId: item?.batchId,
		originalFilename: item?.originalFilename,
		tags: Array.isArray(item?.tags) ? item.tags : [],
	}));
}

export async function onRequestPost(context) {
	const { request, env, waitUntil } = context;
	const config = getConfig(env);

	try {
		const body = await request.json().catch(() => null);
		const batchId = String(body?.batchId || crypto.randomUUID());
		const items = normalizeItems(body?.items);
		if (!items.length) {
			return jsonError(ErrorCode.InvalidRequest, "invalid items", 400);
		}
		if (items.length > MAX_BATCH_ITEMS) {
			return jsonError(
				ErrorCode.BatchLimitExceeded,
				"batch items exceeded",
				400,
				{
					maxItems: MAX_BATCH_ITEMS,
					receivedItems: items.length,
				}
			);
		}

		const results = new Array(items.length);
		const concurrency = Math.min(
			Math.max(Number(config.uploadBatchCompleteConcurrency || 8), 1),
			items.length
		);
		let cursor = 0;

		async function processItem(item) {
			if (item.mime.startsWith("audio/") || item.mediaType === "audio") {
				return {
					clientFileId: item.clientFileId,
					ok: false,
					errorCode: ErrorCode.AudioBatchNotAllowed,
					message: "audio batch upload is not allowed",
				};
			}

			const singleRequestPayload = {
				clientFileId: item.clientFileId,
				batchId,
				contentHash: item.contentHash || null,
				uploadToken: item.uploadToken || null,
				dedupObjectId: item.dedupHit ? item.dedupObjectId : null,
				objectKey: item.objectKey || null,
				mime: item.mime,
				size: item.size,
				etag: item.etag,
				mediaType: item.mediaType || null,
				durationSeconds: item.durationSeconds || null,
				audioTitle: item.audioTitle || null,
				width: item.width,
				height: item.height,
				uploaderNickname: item.uploaderNickname,
				originalFilename: item.originalFilename,
				tags: item.tags,
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
				return {
					clientFileId: item.clientFileId,
					ok: false,
					errorCode:
						singlePayload?.error?.code || ErrorCode.InternalError,
					message:
						singlePayload?.error?.message ||
						"upload complete failed",
				};
			}

			return {
				clientFileId: item.clientFileId,
				ok: true,
				...singlePayload.data,
				dedup_hit: Boolean(
					singlePayload?.data?.dedup_hit ??
						singlePayload?.data?.dedupHit
				),
			};
		}

		async function worker() {
			while (cursor < items.length) {
				const currentIndex = cursor;
				cursor += 1;
				results[currentIndex] = await processItem(items[currentIndex]);
			}
		}

		await Promise.all(Array.from({ length: concurrency }, () => worker()));

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
