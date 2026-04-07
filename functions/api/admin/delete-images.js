import {
	deleteOneImage,
	normalizeImageIds,
	parseDeleteRequestOptions,
} from "../../_shared/admin-delete.js";
import { writeAdminActionLog } from "../../_shared/db.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { getIdentity, sha256Hex, nowIso } from "../../_shared/identity.js";
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

function summarizeDeleteItems(items) {
	const summary = {
		total: items.length,
		succeeded: 0,
		failed: 0,
		skipped: 0,
	};
	for (const item of items) {
		if (item.result === "deleted" || item.result === "would_delete") {
			summary.succeeded += 1;
			continue;
		}
		if (item.result === "skipped") {
			summary.skipped += 1;
			continue;
		}
		summary.failed += 1;
	}
	return summary;
}

export async function onRequestPost(context) {
	const { request, env } = context;
	const startedAt = Date.now();
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

	const imageIds = normalizeImageIds(body.imageIds);
	const uploader = String(body.uploader || "").trim();
	const options = parseDeleteRequestOptions(body, {
		dryRun: false,
		continueOnError: true,
	});
	const dryRunEnabled =
		config.adminDeleteAllowDryRun === true ? options.dryRun : false;
	const maxItems = Math.max(config.adminDeleteBatchMaxItems || 50, 1);

	if (options.dryRun && !dryRunEnabled) {
		return jsonError(
			ErrorCode.InvalidRequest,
			"dryRun is disabled by config",
			400
		);
	}
	if (!imageIds.length && !uploader) {
		return jsonError(
			ErrorCode.InvalidRequest,
			"imageIds or uploader must be provided",
			400
		);
	}
	if (imageIds.length > maxItems) {
		return jsonError(
			ErrorCode.BatchLimitExceeded,
			`imageIds exceeds max limit: ${maxItems}`,
			400,
			{ maxItems }
		);
	}

	auditParams = {
		count: imageIds.length || 0,
		uploader: uploader || null,
		dryRun: dryRunEnabled,
		continueOnError: options.continueOnError,
		reason: options.reason,
		path: new URL(request.url).pathname,
	};

	try {
		if (uploader) {
			const result = {
				total_soft_deleted: 0,
				total_ref_decremented: 0,
				total_tag_mappings_deleted: 0,
			};
			if (!dryRunEnabled) {
				const ts = nowIso();
				const updateObjects = await env.DB.prepare(
					`
						UPDATE image_objects
						SET ref_count = CASE WHEN ref_count > 0 THEN ref_count - 1 ELSE 0 END,
								updated_at = ?2
						WHERE object_id IN (
								SELECT object_id FROM images
								WHERE uploader_nickname = ?1 AND status = 'active' AND object_id IS NOT NULL
						)
				`
				)
					.bind(uploader, ts)
					.run();
				result.total_ref_decremented =
					updateObjects?.meta?.changes || 0;

				const updateImages = await env.DB.prepare(
					`
						UPDATE images
						SET status = 'deleted', updated_at = ?2
						WHERE uploader_nickname = ?1 AND status = 'active'
				`
				)
					.bind(uploader, ts)
					.run();
				result.total_soft_deleted = updateImages?.meta?.changes || 0;

				const deleteTags = await env.DB.prepare(
					`
						DELETE FROM item_tags
						WHERE image_id IN (
							SELECT image_id FROM images
							WHERE uploader_nickname = ?1 AND status = 'deleted' AND updated_at = ?2
						)
				`
				)
					.bind(uploader, ts)
					.run()
					.catch(() => null);
				result.total_tag_mappings_deleted =
					deleteTags?.meta?.changes || 0;
			} else {
				const countRes = await env.DB.prepare(
					`SELECT COUNT(*) as count FROM images WHERE uploader_nickname = ?1 AND status = 'active'`
				)
					.bind(uploader)
					.first();
				result.would_delete = countRes?.count || 0;
			}

			auditResult = result;
			return jsonOk(
				{
					requestId,
					actionId,
					uploader,
					result,
				},
				{ headers: { "cache-control": "no-store" } }
			);
		}

		const items = [];
		for (const imageId of imageIds) {
			const item = await deleteOneImage({
				env,
				imageId,
				dryRun: dryRunEnabled,
				reason: options.reason,
			});
			items.push(item);
			if (!options.continueOnError && item.result === "failed") {
				break;
			}
		}

		const summary = summarizeDeleteItems(items);
		summary.durationMs = Date.now() - startedAt;

		auditResult = {
			summary,
			errorCodes: items.reduce((acc, item) => {
				if (!item.errorCode) return acc;
				acc[item.errorCode] = (acc[item.errorCode] || 0) + 1;
				return acc;
			}, {}),
		};
		if (summary.failed > 0) {
			auditStatus = "error";
		}

		return jsonOk(
			{
				requestId,
				actionId,
				summary,
				items,
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
			actionType: "delete_images_batch",
			actorTokenHash: adminTokenHash,
			ipHash: identity.ipHash,
			requestId,
			params: auditParams,
			result: auditResult,
			status: auditStatus,
		}).catch(() => null);
	}
}
