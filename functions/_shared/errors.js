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
	UploadTokenMissing: "UPLOAD_TOKEN_MISSING",
	UploadTokenInvalid: "UPLOAD_TOKEN_INVALID",
	UploadTokenExpired: "UPLOAD_TOKEN_EXPIRED",
	UploadTokenAlreadyUsed: "UPLOAD_TOKEN_ALREADY_USED",
	UploadTokenBindingMismatch: "UPLOAD_TOKEN_BINDING_MISMATCH",
	UploadBatchSessionMissing: "UPLOAD_BATCH_SESSION_MISSING",
	UploadBatchSessionInvalid: "UPLOAD_BATCH_SESSION_INVALID",
	UploadBatchSessionExpired: "UPLOAD_BATCH_SESSION_EXPIRED",
	AudioTitleRequired: "AUDIO_TITLE_REQUIRED",
	AudioBatchNotAllowed: "AUDIO_BATCH_NOT_ALLOWED",
	BotUnauthorized: "BOT_UNAUTHORIZED",
	BotGroupNotAllowed: "BOT_GROUP_NOT_ALLOWED",
	AdminUnauthorized: "ADMIN_UNAUTHORIZED",
	BatchLimitExceeded: "BATCH_LIMIT_EXCEEDED",
	ImageAlreadyDeleted: "IMAGE_ALREADY_DELETED",
	ObjectRefConflict: "OBJECT_REF_CONFLICT",
	R2DeleteFailed: "R2_DELETE_FAILED",
	PartialDeleteStorageFailed: "PARTIAL_DELETE_STORAGE_FAILED",
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
