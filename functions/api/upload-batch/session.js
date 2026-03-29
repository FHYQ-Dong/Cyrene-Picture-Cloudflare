import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { getIdentity } from "../../_shared/identity.js";
import { verifyTurnstile } from "../../_shared/turnstile.js";
import { issueBatchSessionToken } from "../../_shared/upload-batch-session.js";

export async function onRequestPost(context) {
	const { request, env } = context;
	const config = getConfig(env);

	try {
		const body = await request.json().catch(() => null);
		const batchId = String(body?.batchId || "").trim();
		const turnstileToken = String(body?.turnstileToken || "").trim();
		if (!batchId) {
			return jsonError(ErrorCode.InvalidRequest, "missing batchId", 400);
		}

		if (!config.uploadBatchSessionSecret) {
			return jsonError(
				ErrorCode.ConfigMissing,
				"missing UPLOAD_BATCH_SESSION_SECRET",
				500,
				{ required: ["UPLOAD_BATCH_SESSION_SECRET"] }
			);
		}

		const identity = await getIdentity(request);
		if (config.turnstileEnforced) {
			const turnstileResult = await verifyTurnstile(
				env,
				turnstileToken,
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

		const issued = await issueBatchSessionToken(config, {
			batchId,
			visitorId: identity.visitorId,
			ipHash: identity.ipHash,
		});

		return jsonOk({
			batchId,
			batchSessionToken: issued.token,
			expiresAt: issued.expiresAt,
			ttlSeconds: Math.max(config.uploadBatchSessionTtlSeconds || 900, 1),
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
