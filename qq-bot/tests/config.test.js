import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig parses list and number values", () => {
	const config = loadConfig({
		LLBOT_WS_URL: "ws://localhost:3001",
		BOT_QQ_ID: "12345",
		QQ_ALLOWED_GROUPS: "1001,1002",
		INGEST_MAX_ITEMS_PER_MESSAGE: "9",
		RETRY_MAX_ATTEMPTS: "5",
	});

	assert.equal(config.llbotWsUrl, "ws://localhost:3001");
	assert.equal(config.botQqId, "12345");
	assert.equal(config.qqAllowedGroups.has("1001"), true);
	assert.equal(config.ingestMaxItemsPerMessage, 9);
	assert.equal(config.retryMaxAttempts, 5);
});
