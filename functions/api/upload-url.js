import { ErrorCode, jsonError, jsonOk } from "../_shared/errors";
import { getConfig } from "../_shared/env";
import { getIdentity } from "../_shared/identity";
import { incrementMinuteCounter } from "../_shared/rate-limit";
import { checkAndConsumeQuotas } from "../_shared/quota";
import { verifyTurnstile } from "../_shared/turnstile";
import { createObjectKey } from "../_shared/identity";
import { createPresignedPutUrl } from "../_shared/r2-presign";
import { writeLog } from "../_shared/log";
import { normalizeUploaderNickname } from "../_shared/nickname";

export async function onRequestPost(context) {
	const { request, env } = context;
	const config = getConfig(env);
	const requestId = crypto.randomUUID();

	try {
		const body = await request.json().catch(() => null);
		if (
			!body ||
			!body.filename ||
			!body.mime ||
			typeof body.size !== "number"
		) {
			return jsonError(
				ErrorCode.InvalidRequest,
				"invalid request body",
				400
			);
		}

		if (!config.allowedMime.has(body.mime)) {
			return jsonError(ErrorCode.MimeNotAllowed, "mime not allowed", 400);
		}

		if (body.size <= 0 || body.size > config.maxFileSize) {
			return jsonError(
				ErrorCode.UploadSizeExceeded,
				"file size exceeded",
				400
			);
		}

		const identity = await getIdentity(request);
		const normalizedNickname = normalizeUploaderNickname(
			body.uploaderNickname,
			config.uploaderNicknameMaxLength
		);

		const visitorMinuteCount = await incrementMinuteCounter(
			env.DB,
			"visitor",
			identity.visitorId
		);
		if (visitorMinuteCount > config.ratePerMinuteVisitor) {
			return jsonError(
				ErrorCode.RateLimited,
				"visitor rate limited",
				429,
				{ scope: "visitor" }
			);
		}

		const ipMinuteCount = await incrementMinuteCounter(
			env.DB,
			"ip",
			identity.ipHash
		);
		if (ipMinuteCount > config.ratePerMinuteIp) {
			return jsonError(ErrorCode.RateLimited, "ip rate limited", 429, {
				scope: "ip",
			});
		}

		if (config.turnstileEnforced) {
			const turnstileResult = await verifyTurnstile(
				env,
				body.turnstileToken,
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

		const quotaResult = await checkAndConsumeQuotas(
			env.DB,
			identity,
			body.size,
			config
		);
		if (!quotaResult.ok) {
			const codeByScope = {
				visitor: ErrorCode.QuotaExceededVisitor,
				ip: ErrorCode.QuotaExceededIp,
				global: ErrorCode.QuotaExceededGlobal,
			};
			return jsonError(
				codeByScope[quotaResult.scope],
				`${quotaResult.scope} quota exceeded`,
				429
			);
		}

		const objectKey = createObjectKey(body.filename);
		let uploadUrl;
		let requiredHeaders;

		if (config.localUploadDirect) {
			uploadUrl = `/api/upload-direct?objectKey=${encodeURIComponent(
				objectKey
			)}`;
			requiredHeaders = {
				"content-type": body.mime,
			};
		} else {
			const presigned = await createPresignedPutUrl(
				env,
				objectKey,
				body.mime,
				config.uploadUrlTtlSeconds
			);
			uploadUrl = presigned.uploadUrl;
			requiredHeaders = presigned.requiredHeaders;
		}

		writeLog("info", {
			request_id: requestId,
			route: "POST /api/upload-url",
			status_code: 200,
			visitor_id: identity.visitorId,
			ip_hash: identity.ipHash,
			bytes_in: body.size,
			error_code: null,
		});

		return jsonOk({
			requestId,
			objectKey,
			uploadUrl,
			requiredHeaders,
			uploaderNickname: normalizedNickname.nickname,
			expiresIn: config.uploadUrlTtlSeconds,
		});
	} catch (error) {
		const message = String(error?.message || error);
		writeLog("error", {
			request_id: requestId,
			route: "POST /api/upload-url",
			status_code: 500,
			error_code: ErrorCode.InternalError,
			message,
		});

		if (message.includes("Missing R2 signing env vars")) {
			return jsonError(
				ErrorCode.ConfigMissing,
				"missing R2 signing env vars",
				500,
				{
					required: [
						"CLOUDFLARE_ACCOUNT_ID",
						"R2_ACCESS_KEY_ID",
						"R2_SECRET_ACCESS_KEY",
					],
				}
			);
		}

		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
