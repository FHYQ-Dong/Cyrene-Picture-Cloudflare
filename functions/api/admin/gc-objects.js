import { jsonOk, jsonError, ErrorCode } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { getIdentity, sha256Hex } from "../../_shared/identity.js";
import { incrementMinuteCounter } from "../../_shared/rate-limit.js";

function readAdminTokenFromRequest(request) {
	const authorization = String(
		request.headers.get("authorization") || ""
	).trim();
	if (authorization.toLowerCase().startsWith("bearer ")) {
		return authorization.slice(7).trim();
	}
	return String(request.headers.get("x-admin-token") || "").trim();
}

function timingSafeEqualString(left, right) {
	const leftBytes = new TextEncoder().encode(String(left || ""));
	const rightBytes = new TextEncoder().encode(String(right || ""));
	let result = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return result === 0;
}

export async function onRequestPost(context) {
	const { request, env } = context;
	const config = getConfig(env);
	const identity = await getIdentity(request);

	const expectedAdminToken = String(config.adminApiToken || "").trim();
	const inputAdminToken = readAdminTokenFromRequest(request);

	if (
		!expectedAdminToken ||
		!inputAdminToken ||
		!timingSafeEqualString(inputAdminToken, expectedAdminToken)
	) {
		return jsonError(
			ErrorCode.AdminUnauthorized,
			"admin unauthorized",
			401
		);
	}

	const adminTokenHash = await sha256Hex(inputAdminToken);
	const adminRateScope = `admin:${adminTokenHash}:${identity.ipHash}`;
	const adminMinuteCount = await incrementMinuteCounter(
		env.DB,
		"admin_api",
		adminRateScope
	);
	if (adminMinuteCount > Math.max(config.adminApiRateLimitPerMin || 10, 1)) {
		return jsonError(ErrorCode.RateLimited, "admin api rate limited", 429, {
			scope: "admin_api",
		});
	}

	let body = {};
	try {
		body = (await request.json().catch(() => ({}))) || {};
	} catch {
		body = {};
	}

	const limit = Math.min(Math.max(Number(body.limit || 50), 1), 100);

	try {
		const rows = await env.DB.prepare(
			`SELECT object_id, object_key FROM image_objects WHERE ref_count <= 0 LIMIT ?1`
		)
			.bind(limit)
			.all();

		const items = rows.results || [];
		if (items.length === 0) {
			return jsonOk({
				message: "No objects to GC",
				cleaned_count: 0,
			});
		}

		const deleteResults = await Promise.allSettled(
			items.map(async (item) => {
				if (item.object_key && env.R2) {
					await env.R2.delete(item.object_key);
				}
				return item.object_id;
			})
		);

		let cleanedCount = 0;
		let failedCount = 0;

		for (const res of deleteResults) {
			if (res.status === "fulfilled") {
				const objectId = res.value;
				await env.DB.prepare(
					`DELETE FROM image_objects WHERE object_id = ?1 AND ref_count <= 0`
				)
					.bind(objectId)
					.run();
				cleanedCount++;
			} else {
				failedCount++;
			}
		}

		return jsonOk({
			message: "GC completed for this batch",
			cleaned_count: cleanedCount,
			failed_count: failedCount,
			total_found: items.length,
		});
	} catch (error) {
		return jsonError(
			ErrorCode.InternalError,
			String(error?.message || error),
			500
		);
	}
}
