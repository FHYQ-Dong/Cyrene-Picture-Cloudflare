import { rejectBotCandidate } from "../../../../_shared/bot-candidate-review.js";
import { ErrorCode, jsonError, jsonOk } from "../../../../_shared/errors.js";
import { verifyAdminRequest } from "../../../../_shared/admin-auth.js";

export async function onRequestPost(context) {
	const auth = await verifyAdminRequest(context);
	if (!auth.ok) return auth.response;

	const candidateId = String(context.params?.id || "").trim();
	if (!candidateId) {
		return jsonError(ErrorCode.InvalidRequest, "missing candidate id", 400);
	}

	const body = await context.request.json().catch(() => ({}));
	const reason = String(body?.reason || "")
		.trim()
		.slice(0, 200);

	const result = await rejectBotCandidate({
		candidateId,
		env: context.env,
		reason: reason || "rejected-by-admin",
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
			result.message || "reject failed",
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
