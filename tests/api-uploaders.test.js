import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/uploaders.js";
import { createMockContextEnv } from "./utils/mock-env.js";

test("api/uploaders returns distinct sorted active uploaders", async () => {
	const { env, DB } = createMockContextEnv();

	DB.addImage({
		image_id: "i-1",
		uploader_nickname: "bbb",
		status: "active",
	});
	DB.addImage({
		image_id: "i-2",
		uploader_nickname: "aaa",
		status: "active",
	});
	DB.addImage({
		image_id: "i-3",
		uploader_nickname: "bbb",
		status: "active",
	});
	DB.addImage({
		image_id: "i-4",
		uploader_nickname: "ccc",
		status: "deleted",
	});

	const request = new Request("https://example.com/api/uploaders?limit=10", {
		method: "GET",
	});
	const response = await onRequestGet({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.deepEqual(
		payload.data.items.map((item) => item.nickname),
		["aaa", "bbb"]
	);
	assert.equal(payload.data.nextCursor, null);
});

test("api/uploaders supports cursor pagination", async () => {
	const { env, DB } = createMockContextEnv();

	DB.addImage({
		image_id: "i-1",
		uploader_nickname: "aaa",
		status: "active",
	});
	DB.addImage({
		image_id: "i-2",
		uploader_nickname: "bbb",
		status: "active",
	});
	DB.addImage({
		image_id: "i-3",
		uploader_nickname: "ccc",
		status: "active",
	});

	const request = new Request(
		"https://example.com/api/uploaders?limit=1&cursor=aaa",
		{ method: "GET" }
	);
	const response = await onRequestGet({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.deepEqual(
		payload.data.items.map((item) => item.nickname),
		["bbb"]
	);
	assert.equal(payload.data.nextCursor, "bbb");
});
