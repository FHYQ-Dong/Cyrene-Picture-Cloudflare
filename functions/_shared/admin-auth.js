import { ErrorCode, jsonError } from "./errors.js";
import { getConfig } from "./env.js";
import { getIdentity, sha256Hex } from "./identity.js";
import { incrementMinuteCounter } from "./rate-limit.js";

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

export async function verifyAdminRequest(context) {
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
		return {
			ok: false,
			response: jsonError(
				ErrorCode.AdminUnauthorized,
				"admin unauthorized",
				401
			),
		};
	}

	const adminTokenHash = await sha256Hex(inputAdminToken);
	const adminRateScope = `admin:${adminTokenHash}:${identity.ipHash}`;
	const adminMinuteCount = await incrementMinuteCounter(
		env.DB,
		"admin_api",
		adminRateScope
	);
	if (adminMinuteCount > Math.max(config.adminApiRateLimitPerMin || 10, 1)) {
		return {
			ok: false,
			response: jsonError(
				ErrorCode.RateLimited,
				"admin api rate limited",
				429,
				{ scope: "admin_api" }
			),
		};
	}

	return {
		ok: true,
		config,
		identity,
		adminTokenHash,
	};
}
