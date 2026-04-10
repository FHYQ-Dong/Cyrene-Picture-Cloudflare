import test from "node:test";
import assert from "node:assert/strict";
import { buildIngestPayload } from "../tools/payload-builder.js";

test("buildIngestPayload builds valid mirai ingest payload", () => {
	const payload = buildIngestPayload(
		{
			groupId: "g-1",
			messageId: "m-1",
			senderId: "u-1",
			senderName: "tester",
			images: [
				{
					url: "https://example.com/a.jpg",
					filename: "a.jpg",
					mime: "image/jpeg",
				},
			],
		},
		{
			source: "mirai-docker",
			reviewMode: "pending",
			defaultTags: "昔涟美图,qq投稿",
		}
	);

	assert.equal(payload.source, "mirai-docker");
	assert.equal(payload.groupId, "g-1");
	assert.equal(payload.messageId, "m-1");
	assert.equal(payload.images.length, 1);
	assert.equal(payload.images[0].imageUrl, "https://example.com/a.jpg");
	assert.deepEqual(payload.tags, ["昔涟美图", "qq投稿"]);
});

test("buildIngestPayload normalizes reviewMode", () => {
	const payload = buildIngestPayload(
		{ groupId: "g-1", messageId: "m-1", images: [] },
		{ reviewMode: "AUTO" }
	);
	assert.equal(payload.reviewMode, "auto");
});
