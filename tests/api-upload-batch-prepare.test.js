import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/upload-batch/prepare.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("upload-batch/prepare returns accepted and rejected items", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		LOCAL_UPLOAD_DIRECT: "true",
	});

	const request = new Request(
		"https://example.com/api/upload-batch/prepare",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "test",
			},
			body: JSON.stringify({
				batchId: "batch-prepare-1",
				items: [
					{
						clientFileId: "ok-1",
						filename: "a.png",
						mime: "image/png",
						size: 100,
						uploaderNickname: "alice",
					},
					{
						clientFileId: "bad-1",
						filename: "bad.txt",
						mime: "text/plain",
						size: 100,
					},
				],
			}),
		}
	);

	const response = await onRequestPost({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.batchId, "batch-prepare-1");
	assert.equal(payload.data.acceptedCount, 1);
	assert.equal(payload.data.rejectedCount, 1);
	assert.equal(payload.data.items[0].clientFileId, "ok-1");
	assert.match(
		payload.data.items[0].uploadUrl,
		/^\/api\/upload-direct\?objectKey=/
	);
	assert.equal(payload.data.rejectedItems[0].errorCode, "MIME_NOT_ALLOWED");
});
