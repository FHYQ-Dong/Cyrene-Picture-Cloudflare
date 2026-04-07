import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/list.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("api/list filters image and audio by mediaType", async () => {
	const { env, DB } = createMockContextEnv();

	DB.addImage({
		image_id: "img-1",
		mime: "image/png",
		media_type: "image",
		uploader_nickname: "alice",
		created_at: "2026-03-29T10:00:00.000Z",
		status: "active",
	});
	DB.addImage({
		image_id: "aud-1",
		mime: "audio/mpeg",
		media_type: "audio",
		audio_title: "BGM",
		duration_seconds: 65,
		uploader_nickname: "alice",
		created_at: "2026-03-29T09:00:00.000Z",
		status: "active",
	});

	const imageRequest = new Request(
		"https://example.com/api/list?limit=20&mediaType=image",
		{ method: "GET" }
	);
	const imageResponse = await onRequestGet({ request: imageRequest, env });
	const imagePayload = await imageResponse.json();

	assert.equal(imageResponse.status, 200);
	assert.equal(imagePayload.ok, true);
	assert.equal(imagePayload.data.items.length, 1);
	assert.equal(imagePayload.data.items[0].image_id, "img-1");
	assert.equal(imagePayload.data.items[0].media_type, "image");

	const audioRequest = new Request(
		"https://example.com/api/list?limit=20&mediaType=audio",
		{ method: "GET" }
	);
	const audioResponse = await onRequestGet({ request: audioRequest, env });
	const audioPayload = await audioResponse.json();

	assert.equal(audioResponse.status, 200);
	assert.equal(audioPayload.ok, true);
	assert.equal(audioPayload.data.items.length, 1);
	assert.equal(audioPayload.data.items[0].image_id, "aud-1");
	assert.equal(audioPayload.data.items[0].media_type, "audio");
	assert.equal(audioPayload.data.items[0].audio_title, "BGM");
	assert.equal(audioPayload.data.items[0].duration_seconds, 65);
});
