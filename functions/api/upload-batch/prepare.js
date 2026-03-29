import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { getIdentity } from "../../_shared/identity.js";
import { incrementMinuteCounter } from "../../_shared/rate-limit.js";
import { checkAndConsumeQuotas } from "../../_shared/quota.js";
import { verifyTurnstile } from "../../_shared/turnstile.js";
import { createObjectKey } from "../../_shared/identity.js";
import { createPresignedPutUrl } from "../../_shared/r2-presign.js";
import { normalizeUploaderNickname } from "../../_shared/nickname.js";
import { issueUploadToken } from "../../_shared/upload-token.js";
import { createUploadTokenRecord } from "../../_shared/db.js";
import {
	issueBatchSessionToken,
	verifyBatchSessionToken,
} from "../../_shared/upload-batch-session.js";

const MAX_BATCH_ITEMS = 20;

function parseItems(rawItems) {
	if (!Array.isArray(rawItems)) return [];
	return rawItems.map((item, index) => ({
		clientFileId: String(item?.clientFileId || `item-${index}`),
		filename: String(item?.filename || item?.fileName || "").trim(),
		mime: String(item?.mime || "").toLowerCase(),
		size: Number(item?.size || 0),
		uploaderNickname: item?.uploaderNickname,
	}));
}

export async function onRequestPost(context) {
	const { request, env } = context;
	const config = getConfig(env);

	try {
		const body = await request.json().catch(() => null);
		const batchId = String(body?.batchId || crypto.randomUUID());
		const batchSessionToken = String(body?.batchSessionToken || "").trim();
		const items = parseItems(body?.items);
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

		const identity = await getIdentity(request);
		let nextBatchSessionToken = "";
		let nextBatchSessionExpiresAt = "";
		if (batchSessionToken) {
			const verified = await verifyBatchSessionToken(
				config,
				batchSessionToken
			);
			if (!verified.ok) {
				if (verified.reason === "UPLOAD_BATCH_SESSION_EXPIRED") {
					return jsonError(
						ErrorCode.UploadBatchSessionExpired,
						"batch session expired",
						403
					);
				}
				if (verified.reason === "UPLOAD_BATCH_SESSION_SECRET_MISSING") {
					return jsonError(
						ErrorCode.ConfigMissing,
						"missing UPLOAD_BATCH_SESSION_SECRET",
						500,
						{ required: ["UPLOAD_BATCH_SESSION_SECRET"] }
					);
				}
				return jsonError(
					ErrorCode.UploadBatchSessionInvalid,
					"invalid batch session token",
					403
				);
			}

			const tokenPayload = verified.payload || {};
			if (
				tokenPayload.batchId !== batchId ||
				tokenPayload.visitorId !== identity.visitorId ||
				tokenPayload.ipHash !== identity.ipHash
			) {
				return jsonError(
					ErrorCode.UploadBatchSessionInvalid,
					"batch session binding mismatch",
					403
				);
			}
		} else if (config.turnstileEnforced) {
			const legacyTurnstileToken = String(
				body?.turnstileToken || ""
			).trim();
			if (!legacyTurnstileToken) {
				return jsonError(
					ErrorCode.UploadBatchSessionMissing,
					"missing batchSessionToken",
					403
				);
			}
			const turnstileResult = await verifyTurnstile(
				env,
				legacyTurnstileToken,
				identity.ip
			);
			if (!turnstileResult.ok) {
				return jsonError(
					ErrorCode.TurnstileInvalid,
					"turnstile verification failed",
					403,
					turnstileResult.details || turnstileResult.reason
				);
			}
		}

		if (config.uploadBatchSessionSecret) {
			const issuedSession = await issueBatchSessionToken(config, {
				batchId,
				visitorId: identity.visitorId,
				ipHash: identity.ipHash,
			});
			nextBatchSessionToken = issuedSession.token;
			nextBatchSessionExpiresAt = issuedSession.expiresAt;
		}

		const acceptedItems = [];
		const rejectedItems = [];

		const shouldIssueToken = config.uploadCompleteRequireToken;
		if (shouldIssueToken && !config.uploadTokenSecret) {
			return jsonError(
				ErrorCode.ConfigMissing,
				"missing UPLOAD_TOKEN_SECRET",
				500,
				{ required: ["UPLOAD_TOKEN_SECRET"] }
			);
		}

		for (const item of items) {
			if (!item.filename || !item.mime || item.size <= 0) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.InvalidRequest,
					message: "invalid item fields",
				});
				continue;
			}

			if (!config.allowedMime.has(item.mime)) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.MimeNotAllowed,
					message: "mime not allowed",
				});
				continue;
			}

			if (item.size > config.maxFileSize) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.UploadSizeExceeded,
					message: "file size exceeded",
				});
				continue;
			}

			const visitorMinuteCount = await incrementMinuteCounter(
				env.DB,
				"visitor",
				identity.visitorId
			);
			if (visitorMinuteCount > config.ratePerMinuteVisitor) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.RateLimited,
					message: "visitor rate limited",
				});
				continue;
			}

			const ipMinuteCount = await incrementMinuteCounter(
				env.DB,
				"ip",
				identity.ipHash
			);
			if (ipMinuteCount > config.ratePerMinuteIp) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.RateLimited,
					message: "ip rate limited",
				});
				continue;
			}

			const quotaResult = await checkAndConsumeQuotas(
				env.DB,
				identity,
				item.size,
				config
			);
			if (!quotaResult.ok) {
				const codeByScope = {
					visitor: ErrorCode.QuotaExceededVisitor,
					ip: ErrorCode.QuotaExceededIp,
					global: ErrorCode.QuotaExceededGlobal,
				};
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: codeByScope[quotaResult.scope],
					message: `${quotaResult.scope} quota exceeded`,
				});
				continue;
			}

			const objectKey = createObjectKey(item.filename);
			let uploadUrl;
			let requiredHeaders;

			if (config.localUploadDirect) {
				uploadUrl = `/api/upload-direct?objectKey=${encodeURIComponent(
					objectKey
				)}`;
				requiredHeaders = {
					"content-type": item.mime,
				};
			} else {
				const presigned = await createPresignedPutUrl(
					env,
					objectKey,
					item.mime,
					config.uploadUrlTtlSeconds
				);
				uploadUrl = presigned.uploadUrl;
				requiredHeaders = presigned.requiredHeaders;
			}

			const normalizedNickname = normalizeUploaderNickname(
				item.uploaderNickname,
				config.uploaderNicknameMaxLength
			);

			let issuedToken = null;
			if (shouldIssueToken) {
				issuedToken = await issueUploadToken(config, {
					objectKey,
					mime: item.mime,
					size: item.size,
					visitorId: identity.visitorId,
					ipHash: identity.ipHash,
				});

				await createUploadTokenRecord(env.DB, {
					tokenId: issuedToken.tokenId,
					objectKey,
					mime: item.mime,
					size: item.size,
					issuedVisitorId: identity.visitorId,
					issuedIpHash: identity.ipHash,
					expiresAt: issuedToken.expiresAt,
				});
			}

			acceptedItems.push({
				clientFileId: item.clientFileId,
				objectKey,
				uploadUrl,
				requiredHeaders,
				uploadToken: issuedToken?.token || "",
				uploadTokenExpiresAt: issuedToken?.expiresAt || "",
				expiresIn: config.uploadUrlTtlSeconds,
				uploaderNickname: normalizedNickname.nickname,
				mime: item.mime,
				size: item.size,
			});
		}

		return jsonOk({
			batchId,
			nextBatchSessionToken,
			nextBatchSessionExpiresAt,
			items: acceptedItems,
			acceptedCount: acceptedItems.length,
			rejectedCount: rejectedItems.length,
			rejectedItems,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
