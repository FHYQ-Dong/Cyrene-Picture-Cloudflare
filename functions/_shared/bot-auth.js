import { ErrorCode, jsonError } from "./errors.js";

export function readBearerToken(request) {
	const authorization = String(
		request.headers.get("authorization") || ""
	).trim();
	if (authorization.toLowerCase().startsWith("bearer ")) {
		return authorization.slice(7).trim();
	}
	return "";
}

export function timingSafeEqualString(left, right) {
	const leftBytes = new TextEncoder().encode(String(left || ""));
	const rightBytes = new TextEncoder().encode(String(right || ""));
	let result = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}
	return result === 0;
}

export function ensureBotAuthorized(request, config) {
	const expectedToken = String(config.botIngestToken || "").trim();
	const inputToken = readBearerToken(request);
	if (
		!expectedToken ||
		!inputToken ||
		!timingSafeEqualString(inputToken, expectedToken)
	) {
		return jsonError(ErrorCode.BotUnauthorized, "bot unauthorized", 401);
	}
	return null;
}

export function ensureAllowedGroup(config, groupId) {
	const normalizedGroupId = String(groupId || "").trim();
	if (!normalizedGroupId) {
		return jsonError(ErrorCode.InvalidRequest, "missing groupId", 400);
	}
	const allowSet = config.botIngestAllowedGroups;
	if (
		allowSet instanceof Set &&
		allowSet.size &&
		!allowSet.has(normalizedGroupId)
	) {
		return jsonError(
			ErrorCode.BotGroupNotAllowed,
			"group is not allowed",
			403,
			{ groupId: normalizedGroupId }
		);
	}
	return null;
}
