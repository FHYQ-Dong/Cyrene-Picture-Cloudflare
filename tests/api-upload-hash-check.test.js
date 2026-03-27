import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/upload-hash/check.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("upload-hash/check returns hit and miss in one request", async () => {
	const { env, DB } = createMockContextEnv();
	DB.addImageObject({
		object_id: "obj-hit-1",
		content_hash:
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		object_key: "public/2026/03/27/existing.png",
		mime: "image/png",
		size_bytes: 123,
	});

	const request = new Request("https://example.com/api/upload-hash/check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			items: [
				{
					clientFileId: "hit-1",
					fileName: "a.png",
					mime: "image/png",
					size: 100,
					contentHash:
						"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
				{
					clientFileId: "miss-1",
					fileName: "b.png",
					mime: "image/png",
					size: 120,
					contentHash:
						"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				},
			],
		}),
	});

	const response = await onRequestPost({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.hitCount, 1);
	assert.equal(payload.data.missCount, 1);
	const hit = payload.data.results.find(
		(item) => item.clientFileId === "hit-1"
	);
	const miss = payload.data.results.find(
		(item) => item.clientFileId === "miss-1"
	);
	assert.equal(hit.exists, true);
	assert.equal(hit.dedupHit, true);
	assert.equal(hit.objectId, "obj-hit-1");
	assert.equal(miss.exists, false);
});

test("upload-hash/check rejects invalid item payload", async () => {
	const { env } = createMockContextEnv();
	const request = new Request("https://example.com/api/upload-hash/check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			items: [{ clientFileId: "bad-1", mime: "image/png", size: 1 }],
		}),
	});

	const response = await onRequestPost({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.results[0].errorCode, "INVALID_REQUEST");
});
