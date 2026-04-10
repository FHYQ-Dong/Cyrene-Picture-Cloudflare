import {
	ensureAllowedGroup,
	ensureBotAuthorized,
} from "../../_shared/bot-auth.js";
import {
	addTagsToImage,
	insertBotCandidate,
	insertBotIngestLog,
	normalizeTagsInput,
} from "../../_shared/db.js";
import { ingestRemoteImageToLibrary } from "../../_shared/bot-ingest.js";
import { getConfig } from "../../_shared/env.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { incrementMinuteCounter } from "../../_shared/rate-limit.js";

const MAX_ITEMS = 20;
const DEFAULT_TAGS = ["昔涟美图", "qq投稿"];

function parseItems(rawItems) {
	if (!Array.isArray(rawItems)) return [];
	return rawItems.slice(0, MAX_ITEMS).map((item, index) => ({
		clientFileId: String(item?.clientFileId || `item-${index}`),
		imageUrl: String(item?.imageUrl || item?.url || "").trim(),
		fileName: String(
			item?.fileName || item?.filename || `image-${index}.jpg`
		).trim(),
		mime: String(item?.mime || "")
			.trim()
			.toLowerCase(),
		tags: Array.isArray(item?.tags) ? item.tags : [],
	}));
}

function toIngestStatus(successCount, failedCount) {
	if (!failedCount) return "success";
	if (!successCount) return "failed";
	return "partial";
}

function normalizeReviewMode(rawValue) {
	const mode = String(rawValue || "auto")
		.trim()
		.toLowerCase();
	return mode === "pending" ? "pending" : "auto";
}

export async function onRequestPost(context) {
	const { request, env, waitUntil } = context;
	const config = getConfig(env);

	const unauthorized = ensureBotAuthorized(request, config);
	if (unauthorized) return unauthorized;

	try {
		const body = await request.json().catch(() => null);
		const groupId = String(body?.groupId || "").trim();
		const messageId = String(body?.messageId || "").trim();
		const senderId = String(body?.senderId || "").trim();
		const senderName = String(body?.senderName || "").trim();
		const source = String(body?.source || "qq-bot").trim() || "qq-bot";
		const reviewMode = normalizeReviewMode(body?.reviewMode);
		const items = parseItems(body?.images);
		if (!messageId) {
			return jsonError(
				ErrorCode.InvalidRequest,
				"missing messageId",
				400
			);
		}
		const groupCheck = ensureAllowedGroup(config, groupId);
		if (groupCheck) return groupCheck;
		if (!items.length) {
			return jsonError(ErrorCode.InvalidRequest, "invalid images", 400);
		}

		const rateScope = `group:${groupId}`;
		const minuteCount = await incrementMinuteCounter(
			env.DB,
			"bot_ingest",
			rateScope
		);
		if (
			minuteCount >
			Math.max(Number(config.botIngestRateLimitPerMin || 120), 1)
		) {
			return jsonError(
				ErrorCode.RateLimited,
				"bot ingest rate limited",
				429,
				{
					scope: "bot_ingest",
					groupId,
				}
			);
		}

		const requestTags = normalizeTagsInput(body?.tags, 10, 30);
		const results = [];
		for (const item of items) {
			if (!item.imageUrl) {
				results.push({
					clientFileId: item.clientFileId,
					ok: false,
					errorCode: ErrorCode.InvalidRequest,
					message: "missing imageUrl",
				});
				continue;
			}

			try {
				const mergedTags = normalizeTagsInput([
					...DEFAULT_TAGS,
					...requestTags,
					...item.tags,
				]);

				if (reviewMode === "pending") {
					const candidateId = crypto.randomUUID();
					await insertBotCandidate(env.DB, {
						candidateId,
						groupId,
						messageId,
						senderId,
						imageUrl: item.imageUrl,
						contentHash: "",
						defaultTags: mergedTags,
						manualTags: [],
						finalTags: [],
						status: "pending",
						reason: "pending-review",
						meta: {
							clientFileId: item.clientFileId,
							fileName: item.fileName,
							mime: item.mime,
							uploaderNickname:
								body?.uploaderNickname || senderName || "",
							source,
						},
					});

					results.push({
						clientFileId: item.clientFileId,
						ok: true,
						queued: true,
						candidateId,
						tags: mergedTags,
					});
					continue;
				}

				const ingestResult = await ingestRemoteImageToLibrary({
					env,
					config,
					waitUntil,
					imageUrl: item.imageUrl,
					fileName: item.fileName,
					itemMime: item.mime,
					uploaderNickname: body?.uploaderNickname || senderName,
					tags: mergedTags,
					sourceBatchId: `qq:${groupId}:${messageId}`,
					sourceClientFileId: item.clientFileId,
				});

				if (!ingestResult.ok) {
					results.push({
						clientFileId: item.clientFileId,
						ok: false,
						errorCode: ingestResult.errorCode,
						message: ingestResult.message,
					});
					continue;
				}

				await insertBotCandidate(env.DB, {
					candidateId: crypto.randomUUID(),
					groupId,
					messageId,
					senderId,
					imageUrl: item.imageUrl,
					contentHash: ingestResult.contentHash,
					defaultTags: DEFAULT_TAGS,
					manualTags: [],
					finalTags: mergedTags,
					status: "approved",
					reason: ingestResult.dedupHit
						? "dedup-hit"
						: "auto-approved",
					reviewedAt: new Date().toISOString(),
					meta: {
						clientFileId: item.clientFileId,
						imageId: ingestResult.imageId,
						objectId: ingestResult.objectId,
						source,
					},
				});

				results.push({
					clientFileId: item.clientFileId,
					...ingestResult,
				});
			} catch (error) {
				results.push({
					clientFileId: item.clientFileId,
					ok: false,
					errorCode: ErrorCode.InternalError,
					message: String(error?.message || error),
				});
			}
		}

		const successCount = results.filter((item) => item.ok).length;
		const failedCount = results.length - successCount;
		const ingestId = crypto.randomUUID();
		await insertBotIngestLog(env.DB, {
			ingestId,
			source,
			groupId,
			messageId,
			senderId,
			senderName,
			imageCount: results.length,
			successCount,
			failedCount,
			status: toIngestStatus(successCount, failedCount),
			errorJson: failedCount ? results.filter((item) => !item.ok) : null,
		});

		return jsonOk({
			ingestId,
			source,
			reviewMode,
			groupId,
			messageId,
			successCount,
			failedCount,
			results,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
