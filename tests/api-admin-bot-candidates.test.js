import test from "node:test";
import assert from "node:assert/strict";
import {
	onRequestGet,
	onRequestPost as onBatchReview,
} from "../functions/api/admin/bot-candidates.js";
import { onRequestPost as onApprove } from "../functions/api/admin/bot-candidates/[id]/approve.js";
import { onRequestPost as onReject } from "../functions/api/admin/bot-candidates/[id]/reject.js";
import { createMockContextEnv } from "./utils/mock-env.js";

function createAdminRequest(
	url,
	{ method = "GET", token = "admin-token", body } = {}
) {
	return new Request(url, {
		method,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			"cf-connecting-ip": "127.0.0.1",
			"user-agent": "node-test",
		},
		body: body == null ? undefined : JSON.stringify(body),
	});
}

function seedCandidate(
	DB,
	{
		candidateId,
		status = "pending",
		groupId = "g-1",
		messageId = "m-1",
		createdAt,
		meta = {},
	} = {}
) {
	DB.addBotCandidate({
		candidate_id: candidateId,
		group_id: groupId,
		message_id: messageId,
		sender_id: "u-1",
		image_url: "https://example.com/image.jpg",
		content_hash: "",
		default_tags_json: JSON.stringify(["qq投稿"]),
		manual_tags_json: JSON.stringify([]),
		final_tags_json: JSON.stringify([]),
		meta_json: JSON.stringify(meta),
		status,
		reason: "",
		created_at: createdAt || new Date().toISOString(),
		reviewed_at: null,
	});
}

test("admin bot-candidates list returns pending items with pagination", async () => {
	const { env, DB } = createMockContextEnv({
		ADMIN_API_TOKEN: "admin-token",
	});
	seedCandidate(DB, {
		candidateId: "c-new",
		status: "pending",
		groupId: "g-1",
		createdAt: "2026-04-08T07:10:00.000Z",
	});
	seedCandidate(DB, {
		candidateId: "c-old",
		status: "pending",
		groupId: "g-1",
		createdAt: "2026-04-08T07:00:00.000Z",
	});
	seedCandidate(DB, {
		candidateId: "c-approved",
		status: "approved",
		groupId: "g-1",
		createdAt: "2026-04-08T06:00:00.000Z",
	});

	const request = createAdminRequest(
		"https://example.com/api/admin/bot-candidates?status=pending&groupId=g-1&limit=1"
	);
	const response = await onRequestGet({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.count, 1);
	assert.equal(payload.data.items[0].candidate_id, "c-new");
	assert.equal(payload.data.nextCursor, "2026-04-08T07:10:00.000Z");
});

test("admin bot-candidates reject single candidate", async () => {
	const { env, DB } = createMockContextEnv({
		ADMIN_API_TOKEN: "admin-token",
	});
	seedCandidate(DB, { candidateId: "c-reject", status: "pending" });

	const request = createAdminRequest(
		"https://example.com/api/admin/bot-candidates/c-reject/reject",
		{
			method: "POST",
			body: { reason: "not-good" },
		}
	);
	const response = await onReject({
		request,
		env,
		params: { id: "c-reject" },
	});
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.status, "rejected");
	assert.equal(DB.botCandidatesById.get("c-reject")?.status, "rejected");
});

test("admin bot-candidates approve returns 404 when candidate not found", async () => {
	const { env } = createMockContextEnv({ ADMIN_API_TOKEN: "admin-token" });
	const request = createAdminRequest(
		"https://example.com/api/admin/bot-candidates/not-found/approve",
		{
			method: "POST",
			body: { manualTags: ["精选"] },
		}
	);
	const response = await onApprove({
		request,
		env,
		params: { id: "not-found" },
		waitUntil: () => {},
	});
	const payload = await response.json();

	assert.equal(response.status, 404);
	assert.equal(payload.ok, false);
	assert.equal(payload.error.code, "OBJECT_NOT_FOUND");
});

test("admin bot-candidates batch reject supports continueOnError=false", async () => {
	const { env, DB } = createMockContextEnv({
		ADMIN_API_TOKEN: "admin-token",
	});
	seedCandidate(DB, { candidateId: "c-ok", status: "pending" });

	const request = createAdminRequest(
		"https://example.com/api/admin/bot-candidates",
		{
			method: "POST",
			body: {
				action: "reject",
				candidateIds: ["missing-id", "c-ok"],
				reason: "batch-reject",
				continueOnError: false,
			},
		}
	);
	const response = await onBatchReview({ request, env, waitUntil: () => {} });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.results.length, 1);
	assert.equal(payload.data.results[0].candidateId, "missing-id");
	assert.equal(payload.data.results[0].ok, false);
	assert.equal(DB.botCandidatesById.get("c-ok")?.status, "pending");
});

test("admin bot-candidates batch approve updates candidate status", async () => {
	const { env, DB } = createMockContextEnv({
		ADMIN_API_TOKEN: "admin-token",
		THUMBNAIL_ENABLED: "false",
	});
	seedCandidate(DB, {
		candidateId: "c-approve",
		status: "pending",
		groupId: "g-9",
		messageId: "m-9",
		meta: {
			clientFileId: "cf-1",
			fileName: "a.jpg",
			mime: "image/jpeg",
			uploaderNickname: "tester",
		},
	});

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(new Uint8Array([255, 216, 255, 217]), {
			status: 200,
			headers: {
				"content-type": "image/jpeg",
				"content-length": "4",
			},
		});

	try {
		const request = createAdminRequest(
			"https://example.com/api/admin/bot-candidates",
			{
				method: "POST",
				body: {
					action: "approve",
					candidateIds: ["c-approve"],
					manualTags: ["人工精选"],
				},
			}
		);
		const response = await onBatchReview({
			request,
			env,
			waitUntil: () => {},
		});
		const payload = await response.json();

		assert.equal(response.status, 200);
		assert.equal(payload.ok, true);
		assert.equal(payload.data.successCount, 1);
		assert.equal(DB.botCandidatesById.get("c-approve")?.status, "approved");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
