import test from "node:test";
import assert from "node:assert/strict";
import { getConfig } from "../functions/_shared/env.js";

test("getConfig parses number vars", () => {
	const config = getConfig({
		MAX_FILE_SIZE: "100",
		UPLOAD_RATE_LIMIT_PER_MIN_IP: "22",
		TURNSTILE_ENFORCED: "false",
	});

	assert.equal(config.maxFileSize, 100);
	assert.equal(config.ratePerMinuteIp, 22);
	assert.equal(config.turnstileEnforced, false);
});
