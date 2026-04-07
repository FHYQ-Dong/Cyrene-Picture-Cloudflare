import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost as createBatchSession } from "../functions/api/upload-batch/session.js";
import { onRequestPost as prepareBatchUpload } from "../functions/api/upload-batch/prepare.js";
import { getConfig } from "../functions/_shared/env.js";
import { getIdentity } from "../functions/_shared/identity.js";
import {
	issueBatchSessionToken,
	verifyBatchSessionToken,
} from "../functions/_shared/upload-batch-session.js";
import { createMockContextEnv } from "./utils/mock-env.js";

function createPrepareRequest({
	batchId,
	batchSessionToken,
	ip = "203.0.113.8",
	userAgent = "session-test-agent",
}) {
	return new Request("https://example.com/api/upload-batch/prepare", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"cf-connecting-ip": ip,
			"user-agent": userAgent,
		},
		body: JSON.stringify({
			batchId,
			batchSessionToken,
			items: [
				{
					clientFileId: "f-1",
					filename: "a.png",
					mime: "image/png",
					size: 100,
					uploaderNickname: "alice",
				},
			],
		}),
	});
}

test("upload-batch/session issues bound session token", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		UPLOAD_BATCH_SESSION_SECRET: "test-batch-session-secret",
	});

	const request = new Request(
		"https://example.com/api/upload-batch/session",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "203.0.113.8",
				"user-agent": "session-test-agent",
			},
			body: JSON.stringify({
				batchId: "batch-session-1",
				turnstileToken: "unused-when-turnstile-disabled",
			}),
		}
	);

	const response = await createBatchSession({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.equal(payload.data.batchId, "batch-session-1");
	assert.ok(payload.data.batchSessionToken);

	const config = getConfig(env);
	const verified = await verifyBatchSessionToken(
		config,
		payload.data.batchSessionToken
	);
	assert.equal(verified.ok, true);
	assert.equal(verified.payload.batchId, "batch-session-1");

	const identity = await getIdentity(request);
	assert.equal(verified.payload.visitorId, identity.visitorId);
	assert.equal(verified.payload.ipHash, identity.ipHash);
});

test("upload-batch/prepare rejects expired batch session token", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		UPLOAD_BATCH_SESSION_SECRET: "test-batch-session-secret",
		UPLOAD_BATCH_SESSION_TTL_SECONDS: "1",
		UPLOAD_BATCH_SESSION_REFRESH_GRACE_SECONDS: "0",
	});
	const config = getConfig(env);

	const identityRequest = new Request("https://example.com/identity", {
		headers: {
			"cf-connecting-ip": "203.0.113.8",
			"user-agent": "session-test-agent",
		},
	});
	const identity = await getIdentity(identityRequest);

	const issued = await issueBatchSessionToken(config, {
		batchId: "batch-session-expired",
		visitorId: identity.visitorId,
		ipHash: identity.ipHash,
	});

	const originalNow = Date.now;
	Date.now = () => originalNow() + 2000;
	try {
		const request = createPrepareRequest({
			batchId: "batch-session-expired",
			batchSessionToken: issued.token,
			ip: "203.0.113.8",
			userAgent: "session-test-agent",
		});

		const response = await prepareBatchUpload({ request, env });
		const payload = await response.json();

		assert.equal(response.status, 403);
		assert.equal(payload.ok, false);
		assert.equal(payload.error.code, "UPLOAD_BATCH_SESSION_EXPIRED");
	} finally {
		Date.now = originalNow;
	}
});

test("upload-batch/prepare rejects batch session binding mismatch", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		UPLOAD_BATCH_SESSION_SECRET: "test-batch-session-secret",
	});
	const config = getConfig(env);

	const sourceIdentityRequest = new Request("https://example.com/identity", {
		headers: {
			"cf-connecting-ip": "203.0.113.8",
			"user-agent": "session-test-agent",
		},
	});
	const sourceIdentity = await getIdentity(sourceIdentityRequest);

	const issued = await issueBatchSessionToken(config, {
		batchId: "batch-session-bind",
		visitorId: sourceIdentity.visitorId,
		ipHash: sourceIdentity.ipHash,
	});

	const mismatchedRequest = createPrepareRequest({
		batchId: "batch-session-bind",
		batchSessionToken: issued.token,
		ip: "198.51.100.9",
		userAgent: "session-test-agent",
	});

	const response = await prepareBatchUpload({
		request: mismatchedRequest,
		env,
	});
	const payload = await response.json();

	assert.equal(response.status, 403);
	assert.equal(payload.ok, false);
	assert.equal(payload.error.code, "UPLOAD_BATCH_SESSION_INVALID");
	assert.equal(payload.error.message, "batch session binding mismatch");
});

test("upload-batch/prepare returns renewed batch session token", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		UPLOAD_BATCH_SESSION_SECRET: "test-batch-session-secret",
	});
	const config = getConfig(env);

	const identityRequest = new Request("https://example.com/identity", {
		headers: {
			"cf-connecting-ip": "203.0.113.8",
			"user-agent": "session-test-agent",
		},
	});
	const identity = await getIdentity(identityRequest);

	const issued = await issueBatchSessionToken(config, {
		batchId: "batch-session-rolling",
		visitorId: identity.visitorId,
		ipHash: identity.ipHash,
	});

	const request = createPrepareRequest({
		batchId: "batch-session-rolling",
		batchSessionToken: issued.token,
		ip: "203.0.113.8",
		userAgent: "session-test-agent",
	});

	const response = await prepareBatchUpload({ request, env });
	const payload = await response.json();

	assert.equal(response.status, 200);
	assert.equal(payload.ok, true);
	assert.ok(payload.data.nextBatchSessionToken);
	assert.notEqual(payload.data.nextBatchSessionToken, issued.token);

	const verified = await verifyBatchSessionToken(
		config,
		payload.data.nextBatchSessionToken
	);
	assert.equal(verified.ok, true);
	assert.equal(verified.payload.batchId, "batch-session-rolling");
	assert.equal(verified.payload.visitorId, identity.visitorId);
	assert.equal(verified.payload.ipHash, identity.ipHash);
});

test("upload-batch/prepare allows expired token within grace window", async () => {
	const { env } = createMockContextEnv({
		TURNSTILE_ENFORCED: "false",
		UPLOAD_BATCH_SESSION_SECRET: "test-batch-session-secret",
		UPLOAD_BATCH_SESSION_TTL_SECONDS: "1",
		UPLOAD_BATCH_SESSION_REFRESH_GRACE_SECONDS: "10",
	});
	const config = getConfig(env);

	const identityRequest = new Request("https://example.com/identity", {
		headers: {
			"cf-connecting-ip": "203.0.113.8",
			"user-agent": "session-test-agent",
		},
	});
	const identity = await getIdentity(identityRequest);

	const issued = await issueBatchSessionToken(config, {
		batchId: "batch-session-grace",
		visitorId: identity.visitorId,
		ipHash: identity.ipHash,
	});

	const originalNow = Date.now;
	Date.now = () => originalNow() + 3000;
	try {
		const request = createPrepareRequest({
			batchId: "batch-session-grace",
			batchSessionToken: issued.token,
			ip: "203.0.113.8",
			userAgent: "session-test-agent",
		});

		const response = await prepareBatchUpload({ request, env });
		const payload = await response.json();

		assert.equal(response.status, 200);
		assert.equal(payload.ok, true);
		assert.ok(payload.data.nextBatchSessionToken);
	} finally {
		Date.now = originalNow;
	}
});
