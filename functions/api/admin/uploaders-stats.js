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

	const url = new URL(request.url);
	const limit = Math.min(
		Math.max(Number(url.searchParams.get("limit") || 100), 1),
		500
	);

	try {
		// Group by uploader_nickname
		const uploadersResult = await env.DB.prepare(
			`SELECT 
                                COALESCE(NULLIF(TRIM(uploader_nickname), ''), '093') as uploader,
                                COUNT(image_id) as count,
                                SUM(size_bytes) as total_size_bytes,
                                MAX(created_at) as last_upload
                         FROM images 
                         WHERE status = 'active'
                         GROUP BY COALESCE(NULLIF(TRIM(uploader_nickname), ''), '093')
                         ORDER BY count DESC
                         LIMIT ?1`
		)
			.bind(limit)
			.all();

		return jsonOk(uploadersResult.results || [], {
			headers: {
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
