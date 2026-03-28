import {
	deleteOneImage,
	parseDeleteRequestOptions,
} from "../../_shared/admin-delete.js";
import { writeAdminActionLog } from "../../_shared/db.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
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
	const requestId = crypto.randomUUID();
	const actionId = crypto.randomUUID();
	const config = getConfig(env);
	const expectedAdminToken = String(config.adminApiToken || "").trim();
	const inputAdminToken = readAdminTokenFromRequest(request);
	const identity = await getIdentity(request);
	let auditStatus = "ok";
	let auditResult = {};
	let auditParams = {};

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

	const imageId = String(body.imageId || "").trim();
	const options = parseDeleteRequestOptions(body, {
		dryRun: false,
		continueOnError: true,
	});
	const dryRunEnabled =
		config.adminDeleteAllowDryRun === true ? options.dryRun : false;
	if (options.dryRun && !dryRunEnabled) {
		return jsonError(
			ErrorCode.InvalidRequest,
			"dryRun is disabled by config",
			400
		);
	}

	auditParams = {
		imageId,
		dryRun: dryRunEnabled,
		reason: options.reason,
		path: new URL(request.url).pathname,
	};

	try {
		if (!imageId) {
			return jsonError(ErrorCode.InvalidRequest, "missing imageId", 400);
		}

		const item = await deleteOneImage({
			env,
			imageId,
			dryRun: dryRunEnabled,
			reason: options.reason,
		});

		auditResult = {
			imageId,
			result: item.result,
			errorCode: item.errorCode || null,
		};

		const statusCode = item.result === "failed" ? 400 : 200;
		if (statusCode !== 200) {
			auditStatus = "error";
		}

		if (statusCode !== 200) {
			return jsonError(
				item.errorCode || ErrorCode.InternalError,
				item.message || "delete failed",
				statusCode,
				{ requestId, actionId, item }
			);
		}

		return jsonOk(
			{
				requestId,
				actionId,
				item,
			},
			{
				headers: {
					"cache-control": "no-store",
				},
			}
		);
	} catch (error) {
		auditStatus = "error";
		auditResult = {
			message: String(error?.message || error),
		};
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	} finally {
		await writeAdminActionLog(env.DB, {
			actionId,
			actionType: "delete_image",
			actorTokenHash: adminTokenHash,
			ipHash: identity.ipHash,
			requestId,
			params: auditParams,
			result: auditResult,
			status: auditStatus,
		}).catch(() => null);
	}
}
