export const ErrorCode = {
	UploadSizeExceeded: "UPLOAD_SIZE_EXCEEDED",
	MimeNotAllowed: "MIME_NOT_ALLOWED",
	QuotaExceededVisitor: "QUOTA_EXCEEDED_VISITOR",
	QuotaExceededIp: "QUOTA_EXCEEDED_IP",
	QuotaExceededGlobal: "QUOTA_EXCEEDED_GLOBAL",
	TurnstileInvalid: "TURNSTILE_INVALID",
	RateLimited: "RATE_LIMITED",
	InvalidRequest: "INVALID_REQUEST",
	ConfigMissing: "CONFIG_MISSING",
	ObjectNotFound: "OBJECT_NOT_FOUND",
	HashCheckFailed: "HASH_CHECK_FAILED",
	HashMismatch: "HASH_MISMATCH",
	InternalError: "INTERNAL_ERROR",
};

export function jsonOk(data, init = {}) {
	return new Response(JSON.stringify({ ok: true, data }), {
		status: 200,
		headers: {
			"content-type": "application/json",
			...(init.headers || {}),
		},
		...init,
	});
}

export function jsonError(code, message, status = 400, details = undefined) {
	return new Response(
		JSON.stringify({ ok: false, error: { code, message, details } }),
		{
			status,
			headers: { "content-type": "application/json" },
		}
	);
}
