import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import {
	createObjectKey,
	dayBucket,
	getIdentity,
	minuteBucket,
} from "../../_shared/identity.js";
import {
	buildMinuteCounterIncrementStatement,
	getMinuteCounter,
} from "../../_shared/rate-limit.js";
import {
	buildQuotaUpsertStatement,
	getQuotaRows,
} from "../../_shared/quota.js";
import { verifyTurnstile } from "../../_shared/turnstile.js";
import { createPresignedPutUrl } from "../../_shared/r2-presign.js";
import { normalizeUploaderNickname } from "../../_shared/nickname.js";
import { issueUploadToken } from "../../_shared/upload-token.js";
import { buildCreateUploadTokenRecordStatement } from "../../_shared/db.js";
import {
	issueBatchSessionToken,
	verifyBatchSessionToken,
} from "../../_shared/upload-batch-session.js";

const MAX_BATCH_ITEMS = 50;

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
	const requestStartedAt = Date.now();
	const perfSteps = {
		validateMs: 0,
		rateReadMs: 0,
		quotaReadMs: 0,
		quotaSimulateMs: 0,
		presignMs: 0,
		tokenIssueMs: 0,
		persistMs: 0,
	};
	let dbMs = 0;

	async function runStep(name, task, { isDb = false } = {}) {
		const startedAt = Date.now();
		const result = await task();
		const duration = Date.now() - startedAt;
		perfSteps[name] = Number(perfSteps[name] || 0) + duration;
		if (isDb) dbMs += duration;
		return result;
	}

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
				batchSessionToken,
				{
					allowExpiredWithinSeconds:
						config.uploadBatchSessionRefreshGraceSeconds,
				}
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

		const quotaCodeByScope = {
			visitor: ErrorCode.QuotaExceededVisitor,
			ip: ErrorCode.QuotaExceededIp,
			global: ErrorCode.QuotaExceededGlobal,
		};

		const bucketMinute = minuteBucket();
		const bucketDate = dayBucket();

		const rateReadResult = await runStep(
			"rateReadMs",
			() =>
				Promise.all([
					getMinuteCounter(
						env.DB,
						"visitor",
						identity.visitorId,
						bucketMinute
					),
					getMinuteCounter(
						env.DB,
						"ip",
						identity.ipHash,
						bucketMinute
					),
				]),
			{ isDb: true }
		);

		const quotaReadResult = await runStep(
			"quotaReadMs",
			() =>
				getQuotaRows(env.DB, bucketDate, [
					{ scope: "visitor", scopeKey: identity.visitorId },
					{ scope: "ip", scopeKey: identity.ipHash },
					{ scope: "global", scopeKey: "global" },
				]),
			{ isDb: true }
		);

		let visitorMinuteCount = Number(rateReadResult?.[0] || 0);
		let ipMinuteCount = Number(rateReadResult?.[1] || 0);
		let visitorMinuteIncrements = 0;
		let ipMinuteIncrements = 0;

		const visitorQuota = quotaReadResult?.[0] || {
			uploadCount: 0,
			uploadBytes: 0,
		};
		const ipQuota = quotaReadResult?.[1] || {
			uploadCount: 0,
			uploadBytes: 0,
		};
		const globalQuota = quotaReadResult?.[2] || {
			uploadCount: 0,
			uploadBytes: 0,
		};

		let visitorQuotaCount = Number(visitorQuota.uploadCount || 0);
		let visitorQuotaBytes = Number(visitorQuota.uploadBytes || 0);
		let ipQuotaCount = Number(ipQuota.uploadCount || 0);
		let ipQuotaBytes = Number(ipQuota.uploadBytes || 0);
		let globalQuotaCount = Number(globalQuota.uploadCount || 0);
		let globalQuotaBytes = Number(globalQuota.uploadBytes || 0);

		let quotaVisitorAddCount = 0;
		let quotaVisitorAddBytes = 0;
		let quotaIpAddCount = 0;
		let quotaIpAddBytes = 0;
		let quotaGlobalAddCount = 0;
		let quotaGlobalAddBytes = 0;

		const acceptedCandidates = [];
		const validateStartedAt = Date.now();
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

			visitorMinuteCount += 1;
			visitorMinuteIncrements += 1;
			if (visitorMinuteCount > config.ratePerMinuteVisitor) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.RateLimited,
					message: "visitor rate limited",
				});
				continue;
			}

			ipMinuteCount += 1;
			ipMinuteIncrements += 1;
			if (ipMinuteCount > config.ratePerMinuteIp) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: ErrorCode.RateLimited,
					message: "ip rate limited",
				});
				continue;
			}

			if (
				visitorQuotaCount + 1 > config.maxVisitorCount ||
				visitorQuotaBytes + item.size > config.maxVisitorBytes
			) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: quotaCodeByScope.visitor,
					message: "visitor quota exceeded",
				});
				continue;
			}

			if (
				ipQuotaCount + 1 > config.maxIpCount ||
				ipQuotaBytes + item.size > config.maxIpBytes
			) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: quotaCodeByScope.ip,
					message: "ip quota exceeded",
				});
				continue;
			}

			if (
				globalQuotaCount + 1 > config.maxGlobalCount ||
				globalQuotaBytes + item.size > config.maxGlobalBytes
			) {
				rejectedItems.push({
					clientFileId: item.clientFileId,
					errorCode: quotaCodeByScope.global,
					message: "global quota exceeded",
				});
				continue;
			}

			visitorQuotaCount += 1;
			visitorQuotaBytes += item.size;
			ipQuotaCount += 1;
			ipQuotaBytes += item.size;
			globalQuotaCount += 1;
			globalQuotaBytes += item.size;

			quotaVisitorAddCount += 1;
			quotaVisitorAddBytes += item.size;
			quotaIpAddCount += 1;
			quotaIpAddBytes += item.size;
			quotaGlobalAddCount += 1;
			quotaGlobalAddBytes += item.size;

			const normalizedNickname = normalizeUploaderNickname(
				item.uploaderNickname,
				config.uploaderNicknameMaxLength
			);
			acceptedCandidates.push({
				...item,
				uploaderNickname: normalizedNickname.nickname,
			});
		}
		perfSteps.validateMs += Date.now() - validateStartedAt;

		const acceptedItems = [];
		const mutationStatements = [];

		const rateVisitorStatement = buildMinuteCounterIncrementStatement(
			env.DB,
			{
				scope: "visitor",
				scopeKey: identity.visitorId,
				addCount: visitorMinuteIncrements,
				bucketMinute,
			}
		);
		if (rateVisitorStatement) mutationStatements.push(rateVisitorStatement);

		const rateIpStatement = buildMinuteCounterIncrementStatement(env.DB, {
			scope: "ip",
			scopeKey: identity.ipHash,
			addCount: ipMinuteIncrements,
			bucketMinute,
		});
		if (rateIpStatement) mutationStatements.push(rateIpStatement);

		const quotaVisitorStatement = buildQuotaUpsertStatement(env.DB, {
			bucketDate,
			scope: "visitor",
			scopeKey: identity.visitorId,
			addCount: quotaVisitorAddCount,
			addBytes: quotaVisitorAddBytes,
		});
		if (quotaVisitorStatement)
			mutationStatements.push(quotaVisitorStatement);

		const quotaIpStatement = buildQuotaUpsertStatement(env.DB, {
			bucketDate,
			scope: "ip",
			scopeKey: identity.ipHash,
			addCount: quotaIpAddCount,
			addBytes: quotaIpAddBytes,
		});
		if (quotaIpStatement) mutationStatements.push(quotaIpStatement);

		const quotaGlobalStatement = buildQuotaUpsertStatement(env.DB, {
			bucketDate,
			scope: "global",
			scopeKey: "global",
			addCount: quotaGlobalAddCount,
			addBytes: quotaGlobalAddBytes,
		});
		if (quotaGlobalStatement) mutationStatements.push(quotaGlobalStatement);

		const quotaSimulateStartedAt = Date.now();
		for (const item of acceptedCandidates) {
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
				const presigned = await runStep(
					"presignMs",
					() =>
						createPresignedPutUrl(
							env,
							objectKey,
							item.mime,
							config.uploadUrlTtlSeconds
						),
					{ isDb: false }
				);
				uploadUrl = presigned.uploadUrl;
				requiredHeaders = presigned.requiredHeaders;
			}

			let issuedToken = null;
			if (shouldIssueToken) {
				issuedToken = await runStep("tokenIssueMs", () =>
					issueUploadToken(config, {
						objectKey,
						mime: item.mime,
						size: item.size,
						visitorId: identity.visitorId,
						ipHash: identity.ipHash,
					})
				);

				const tokenStatement = buildCreateUploadTokenRecordStatement(
					env.DB,
					{
						tokenId: issuedToken.tokenId,
						objectKey,
						mime: item.mime,
						size: item.size,
						issuedVisitorId: identity.visitorId,
						issuedIpHash: identity.ipHash,
						expiresAt: issuedToken.expiresAt,
					}
				);
				if (tokenStatement) {
					mutationStatements.push(tokenStatement);
				}
			}

			acceptedItems.push({
				clientFileId: item.clientFileId,
				objectKey,
				uploadUrl,
				requiredHeaders,
				uploadToken: issuedToken?.token || "",
				uploadTokenExpiresAt: issuedToken?.expiresAt || "",
				expiresIn: config.uploadUrlTtlSeconds,
				uploaderNickname: item.uploaderNickname,
				mime: item.mime,
				size: item.size,
			});
		}
		perfSteps.quotaSimulateMs += Date.now() - quotaSimulateStartedAt;

		if (mutationStatements.length) {
			await runStep(
				"persistMs",
				async () => {
					if (typeof env.DB.batch === "function") {
						await env.DB.batch(mutationStatements);
						return;
					}
					for (const statement of mutationStatements) {
						await statement.run();
					}
				},
				{
					isDb: true,
				}
			);
		}

		return jsonOk({
			batchId,
			nextBatchSessionToken,
			nextBatchSessionExpiresAt,
			items: acceptedItems,
			acceptedCount: acceptedItems.length,
			rejectedCount: rejectedItems.length,
			rejectedItems,
			perf: {
				serverMs: Date.now() - requestStartedAt,
				dbMs,
				steps: perfSteps,
			},
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
