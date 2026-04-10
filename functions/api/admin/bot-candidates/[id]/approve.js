import { normalizeTagsInput } from "../../../../_shared/db.js";
import { approveBotCandidate } from "../../../../_shared/bot-candidate-review.js";
import { ErrorCode, jsonError, jsonOk } from "../../../../_shared/errors.js";
import { verifyAdminRequest } from "../../../../_shared/admin-auth.js";

export async function onRequestPost(context) {
	const auth = await verifyAdminRequest(context);
	if (!auth.ok) return auth.response;
	context.config = auth.config;

	const candidateId = String(context.params?.id || "").trim();
	if (!candidateId) {
		return jsonError(ErrorCode.InvalidRequest, "missing candidate id", 400);
	}

	const body = await context.request.json().catch(() => ({}));
	const manualTags = normalizeTagsInput(body?.manualTags || []);
	const reason = String(body?.reason || "")
		.trim()
		.slice(0, 200);

	const result = await approveBotCandidate({
		context,
		candidateId,
		manualTags,
		reason: reason || "approved-by-admin",
	});

	if (!result.ok) {
		const status =
			result.errorCode === ErrorCode.ObjectNotFound
				? 404
				: result.errorCode === ErrorCode.InvalidRequest
				? 409
				: 500;
		return jsonError(
			result.errorCode || ErrorCode.InternalError,
			result.message || "approve failed",
			status,
			result
		);
	}

	return jsonOk(result, {
		headers: {
			"cache-control": "no-store",
		},
	});
}
