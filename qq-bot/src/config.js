function parseList(rawValue) {
	return String(rawValue || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseNumber(rawValue, fallback) {
	const value = Number(rawValue);
	return Number.isFinite(value) ? value : fallback;
}

export function loadConfig(env = process.env) {
	return {
		llbotWsUrl: String(env.LLBOT_WS_URL || "ws://127.0.0.1:3001").trim(),
		llbotAccessToken: String(env.LLBOT_ACCESS_TOKEN || "").trim(),
		llbotReconnectDelayMs: Math.max(
			parseNumber(env.LLBOT_RECONNECT_DELAY_MS, 3000),
			500
		),
		llbotHeartbeatIntervalMs: Math.max(
			parseNumber(env.LLBOT_HEARTBEAT_INTERVAL_MS, 30000),
			5000
		),
		cyreneApiBaseUrl: String(
			env.CYRENE_API_BASE_URL || "http://127.0.0.1:8788"
		)
			.trim()
			.replace(/\/+$/, ""),
		cyreneBotIngestToken: String(env.CYRENE_BOT_INGEST_TOKEN || "").trim(),
		cyreneReviewMode:
			String(env.CYRENE_REVIEW_MODE || "pending")
				.trim()
				.toLowerCase() === "auto"
				? "auto"
				: "pending",
		cyreneDefaultTags: parseList(
			env.CYRENE_DEFAULT_TAGS || "昔涟美图"
		),
		cyreneTimeoutMs: Math.max(
			parseNumber(env.CYRENE_TIMEOUT_MS, 20000),
			1000
		),
		botQqId: String(env.BOT_QQ_ID || "").trim(),
		qqAllowedGroups: new Set(parseList(env.QQ_ALLOWED_GROUPS || "")),
		qqAllowedUsers: new Set(parseList(env.QQ_ALLOWED_USERS || "")),
		ingestMaxItemsPerMessage: Math.min(
			Math.max(parseNumber(env.INGEST_MAX_ITEMS_PER_MESSAGE, 20), 1),
			20
		),
		retryMaxAttempts: Math.max(parseNumber(env.RETRY_MAX_ATTEMPTS, 3), 1),
		retryBackoffMs: Math.max(parseNumber(env.RETRY_BACKOFF_MS, 1200), 100),
		collectorTimeoutMs: Math.max(
			parseNumber(env.COLLECTOR_TIMEOUT_MS, 300000),
			30000
		),
		idempotencyTtlMs: Math.max(
			parseNumber(env.IDEMPOTENCY_TTL_MS, 900000),
			60000
		),
	};
}
