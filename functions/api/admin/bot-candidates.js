import { listBotCandidates, normalizeTagsInput } from "../../_shared/db.js";
import {
	approveBotCandidate,
	rejectBotCandidate,
} from "../../_shared/bot-candidate-review.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { verifyAdminRequest } from "../../_shared/admin-auth.js";

function toInt(rawValue, fallback, min, max) {
	const value = Number(rawValue);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseCandidateIds(rawValue) {
	if (!Array.isArray(rawValue)) return [];
	const unique = new Set();
	for (const item of rawValue) {
		const id = String(item || "").trim();
		if (!id) continue;
		unique.add(id);
	}
	return Array.from(unique);
}

export async function onRequestGet(context) {
	const auth = await verifyAdminRequest(context);
	if (!auth.ok) return auth.response;

	const { request, env } = context;
	const url = new URL(request.url);
	const status = String(url.searchParams.get("status") || "pending").trim();
	const groupId = String(url.searchParams.get("groupId") || "").trim();
	const cursor = String(url.searchParams.get("cursor") || "").trim();
	const limit = toInt(url.searchParams.get("limit"), 50, 1, 200);

	const items = await listBotCandidates(env.DB, {
		status,
		groupId,
		cursorCreatedAt: cursor,
		limit,
	});
	const nextCursor = items.length ? items[items.length - 1].created_at : null;

	return jsonOk(
		{
			items,
			nextCursor,
			count: items.length,
		},
		{
			headers: {
				"cache-control": "no-store",
			},
		}
	);
}

export async function onRequestPost(context) {
	const auth = await verifyAdminRequest(context);
	if (!auth.ok) return auth.response;
	context.config = auth.config;

	const { request, env } = context;
	const body = await request.json().catch(() => ({}));
	const action = String(body?.action || "")
		.trim()
		.toLowerCase();
	const candidateIds = parseCandidateIds(body?.candidateIds);
	const manualTags = normalizeTagsInput(body?.manualTags || []);
	const reason = String(body?.reason || "")
		.trim()
		.slice(0, 200);
	const continueOnError = body?.continueOnError !== false;

	if (!candidateIds.length) {
		return jsonError(ErrorCode.InvalidRequest, "missing candidateIds", 400);
	}
	if (candidateIds.length > 100) {
		return jsonError(
			ErrorCode.BatchLimitExceeded,
			"too many candidateIds",
			400
		);
	}
	if (action !== "approve" && action !== "reject") {
		return jsonError(
			ErrorCode.InvalidRequest,
			"action must be approve or reject",
			400
		);
	}

	const results = [];
	for (const candidateId of candidateIds) {
		const result =
			action === "approve"
				? await approveBotCandidate({
						context,
						candidateId,
						manualTags,
						reason: reason || "approved-by-admin",
				  })
				: await rejectBotCandidate({
						candidateId,
						env,
						reason: reason || "rejected-by-admin",
				  });

		results.push({ candidateId, ...result });
		if (!result.ok && !continueOnError) break;
	}

	const successCount = results.filter((item) => item.ok).length;
	const failedCount = results.length - successCount;

	return jsonOk(
		{
			action,
			successCount,
			failedCount,
			results,
		},
		{
			headers: {
				"cache-control": "no-store",
			},
		}
	);
}
