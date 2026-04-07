import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/upload-complete.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("upload-complete writes audio metadata", async () => {
	const { env, DB, R2 } = createMockContextEnv({
		THUMBNAIL_ENABLED: "false",
	});

	const objectKey = "public/2026/03/29/mock-song.mp3";
	const bodyBytes = new TextEncoder().encode("mock-audio-content");
	R2.setObject(objectKey, {
		body: bodyBytes,
		contentType: "audio/mpeg",
		etag: "etag-audio-1",
	});

	const request = new Request("https://example.com/api/upload-complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			objectKey,
			mime: "audio/mpeg",
			size: bodyBytes.byteLength,
			audioTitle: "测试音频",
			durationSeconds: 12.8,
			mediaType: "audio",
			uploaderNickname: "alice",
		}),
	});

	const response = await onRequestPost({ request, env, waitUntil: () => {} });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.mediaType, "audio");
	assert.equal(payload.data.audioTitle, "测试音频");
	assert.equal(payload.data.durationSeconds, 12.8);

	const row = DB.imagesById.get(payload.data.imageId);
	assert.ok(row);
	assert.equal(row.media_type, "audio");
	assert.equal(row.audio_title, "测试音频");
	assert.equal(row.duration_seconds, 12.8);
	assert.equal(row.width, null);
	assert.equal(row.height, null);
});

test("upload-complete rejects audio without title", async () => {
	const { env, R2 } = createMockContextEnv();
	const objectKey = "public/2026/03/29/mock-song-2.mp3";
	R2.setObject(objectKey, {
		body: new TextEncoder().encode("audio"),
		contentType: "audio/mpeg",
	});

	const request = new Request("https://example.com/api/upload-complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			objectKey,
			mime: "audio/mpeg",
			size: 5,
			mediaType: "audio",
		}),
	});

	const response = await onRequestPost({ request, env, waitUntil: () => {} });
	const payload = await response.json();

	assert.equal(response.status, 400);
	assert.equal(payload.ok, false);
	assert.equal(payload.error.code, "AUDIO_TITLE_REQUIRED");
});
