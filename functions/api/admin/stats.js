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

export async function onRequestGet(context) {
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

	try {
		const totalRecordsResult = await env.DB.prepare(
			`SELECT COUNT(*) as count FROM images WHERE status = 'active'`
		).first();

		const totalSizeResult = await env.DB.prepare(
			`SELECT SUM(size_bytes) as total_size FROM image_objects WHERE ref_count > 0`
		).first();

		const mediaTypesResult = await env.DB.prepare(
			`SELECT COALESCE(NULLIF(TRIM(media_type), ''), 'image') as type, COUNT(*) as count 
                         FROM images 
                         WHERE status = 'active' 
                         GROUP BY COALESCE(NULLIF(TRIM(media_type), ''), 'image')`
		).all();

		const mediaTypes = {};
		for (const row of mediaTypesResult.results || []) {
			mediaTypes[row.type] = row.count;
		}

		return jsonOk(
			{
				total_records: totalRecordsResult.count || 0,
				total_size_bytes: totalSizeResult.total_size || 0,
				media_types: mediaTypes,
			},
			{
				headers: {
					"cache-control": "no-store",
				},
			}
		);
	} catch (error) {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
