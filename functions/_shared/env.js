export function readNumber(env, key, fallback) {
	const raw = env[key];
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

export function getConfig(env) {
	return {
		maxFileSize: readNumber(env, "MAX_FILE_SIZE", 209715200),
		maxVisitorCount: readNumber(env, "MAX_VISITOR_UPLOAD_COUNT_DAILY", 500),
		maxVisitorBytes: readNumber(
			env,
			"MAX_VISITOR_UPLOAD_BYTES_DAILY",
			2147483648
		),
		maxIpCount: readNumber(env, "MAX_IP_UPLOAD_COUNT_DAILY", 1500),
		maxIpBytes: readNumber(env, "MAX_IP_UPLOAD_BYTES_DAILY", 6442450944),
		maxGlobalCount: readNumber(env, "MAX_GLOBAL_UPLOAD_COUNT_DAILY", 10000),
		maxGlobalBytes: readNumber(
			env,
			"MAX_GLOBAL_UPLOAD_BYTES_DAILY",
			42949672960
		),
		ratePerMinuteVisitor: readNumber(
			env,
			"UPLOAD_RATE_LIMIT_PER_MIN_VISITOR",
			30
		),
		ratePerMinuteIp: readNumber(env, "UPLOAD_RATE_LIMIT_PER_MIN_IP", 120),
		uploadUrlTtlSeconds: readNumber(env, "UPLOAD_URL_TTL_SECONDS", 900),
		allowedMime: new Set([
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/avif",
		]),
		publicImageBaseUrl:
			env.PUBLIC_IMAGE_BASE_URL || "https://img.example.com",
		defaultUploaderNickname: env.DEFAULT_UPLOADER_NICKNAME || "093",
		uploaderNicknameMaxLength: readNumber(
			env,
			"UPLOADER_NICKNAME_MAX_LENGTH",
			24
		),
		thumbnailEnabled: (env.THUMBNAIL_ENABLED || "true") === "true",
		thumbnailWidth: readNumber(env, "THUMBNAIL_WIDTH", 360),
		thumbnailFormat: (env.THUMBNAIL_FORMAT || "webp").toLowerCase(),
		thumbnailQuality: readNumber(env, "THUMBNAIL_QUALITY", 80),
		thumbnailGenerator: (
			env.THUMBNAIL_GENERATOR || "disabled"
		).toLowerCase(),
		thumbnailResizeBaseUrl: env.THUMBNAIL_RESIZE_BASE_URL || "",
		r2BucketName: env.R2_BUCKET_NAME,
		accountId: env.CLOUDFLARE_ACCOUNT_ID,
		localUploadDirect: (env.LOCAL_UPLOAD_DIRECT || "false") === "true",
		turnstileEnforced: (env.TURNSTILE_ENFORCED || "true") === "true",
	};
}
