import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/upload-batch/complete.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("upload-batch/complete aggregates instant-hit result", async () => {
	const { env, DB } = createMockContextEnv({
		THUMBNAIL_ENABLED: "false",
		LOCAL_UPLOAD_DIRECT: "true",
	});

	DB.addImageObject({
		object_id: "obj-1",
		content_hash:
			"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		object_key: "public/2026/03/27/existing.png",
		mime: "image/png",
		size_bytes: 123,
		r2_etag: "etag-existing",
	});

	const request = new Request(
		"https://example.com/api/upload-batch/complete",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				batchId: "batch-complete-1",
				items: [
					{
						clientFileId: "item-1",
						dedupHit: true,
						dedupObjectId: "obj-1",
						contentHash:
							"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
						mime: "image/png",
						size: 123,
						uploaderNickname: "alice",
						originalFilename: "a.png",
					},
				],
			}),
		}
	);

	const response = await onRequestPost({ request, env, waitUntil: () => {} });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.batchId, "batch-complete-1");
	assert.equal(payload.data.successCount, 1);
	assert.equal(payload.data.failedCount, 0);
	assert.equal(payload.data.results[0].clientFileId, "item-1");
	assert.equal(payload.data.results[0].uploadMode, "instant");
	assert.equal(payload.data.results[0].dedupHit, true);
});
