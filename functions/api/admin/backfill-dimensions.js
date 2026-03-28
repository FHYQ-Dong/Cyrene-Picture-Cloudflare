import {
	listImagesForDimensionBackfill,
	updateImageDimensions,
	writeAdminActionLog,
} from "../../_shared/db.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { extractImageDimensionsFromBytes } from "../../_shared/image-dimensions.js";
import { getIdentity, sha256Hex } from "../../_shared/identity.js";
import { incrementMinuteCounter } from "../../_shared/rate-limit.js";

const MAX_LIMIT = 200;

function normalizeLimit(rawValue) {
	const value = Number(rawValue);
	if (!Number.isFinite(value)) return 50;
	return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function isTruthy(rawValue, fallback = false) {
	if (rawValue == null) return fallback;
	const value = String(rawValue).trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes") return true;
	if (value === "0" || value === "false" || value === "no") return false;
	return fallback;
}

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

async function readObjectHeadBytes(env, objectKey) {
	const object = await env.R2.get(objectKey, {
		range: {
			offset: 0,
			length: 262144,
		},
	});
	if (!object) return null;
	const bytes = await object.arrayBuffer();
	return new Uint8Array(bytes);
}

async function resolveDimensionsFromObject(env, row) {
	if (!row?.object_key) {
		return {
			ok: false,
			errorCode: ErrorCode.ObjectNotFound,
			message: "missing object key",
		};
	}

	const bytes = await readObjectHeadBytes(env, row.object_key);
	if (!bytes || !bytes.length) {
		return {
			ok: false,
			errorCode: ErrorCode.ObjectNotFound,
			message: "object not found",
		};
	}

	const dimensions = extractImageDimensionsFromBytes(bytes);
	if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
		return {
			ok: false,
			errorCode: ErrorCode.InvalidRequest,
			message: "unsupported image format for dimension extraction",
		};
	}

	return {
		ok: true,
		width: dimensions.width,
		height: dimensions.height,
	};
}

export async function onRequestPost(context) {
	const { request, env } = context;
	const requestId = crypto.randomUUID();
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

	const url = new URL(request.url);
	const limit = normalizeLimit(body.limit ?? url.searchParams.get("limit"));
	const dryRun = isTruthy(
		body.dryRun ?? url.searchParams.get("dryRun"),
		true
	);
	const onlyMissing = isTruthy(
		body.onlyMissing ?? url.searchParams.get("onlyMissing"),
		true
	);
	auditParams = { limit, dryRun, onlyMissing, path: url.pathname };

	try {
		const rows = await listImagesForDimensionBackfill(
			env.DB,
			limit,
			onlyMissing
		);
		if (!rows.length) {
			auditResult = {
				picked: 0,
				processed: 0,
				updated: 0,
				failed: 0,
			};
			return jsonOk({
				requestId,
				limit,
				dryRun,
				onlyMissing,
				picked: 0,
				processed: 0,
				updated: 0,
				failed: 0,
				items: [],
			});
		}

		const items = [];
		let updated = 0;
		let failed = 0;

		for (const row of rows) {
			try {
				const resolved = await resolveDimensionsFromObject(env, row);
				if (!resolved.ok) {
					failed += 1;
					items.push({
						imageId: row.image_id,
						ok: false,
						errorCode: resolved.errorCode,
						message: resolved.message,
					});
					continue;
				}

				if (!dryRun) {
					const changed = await updateImageDimensions(
						env.DB,
						row.image_id,
						resolved.width,
						resolved.height
					);
					if (!changed) {
						failed += 1;
						items.push({
							imageId: row.image_id,
							ok: false,
							errorCode: ErrorCode.InternalError,
							message: "failed to update image dimensions",
						});
						continue;
					}
				}

				updated += 1;
				items.push({
					imageId: row.image_id,
					ok: true,
					width: resolved.width,
					height: resolved.height,
					action: dryRun ? "would_update" : "updated",
				});
			} catch (error) {
				failed += 1;
				items.push({
					imageId: row.image_id,
					ok: false,
					errorCode: ErrorCode.InternalError,
					message: String(error?.message || error),
				});
			}
		}

		auditResult = {
			picked: rows.length,
			processed: rows.length,
			updated,
			failed,
		};
		if (failed > 0) {
			auditStatus = "error";
		}

		return jsonOk(
			{
				requestId,
				limit,
				dryRun,
				onlyMissing,
				picked: rows.length,
				processed: rows.length,
				updated,
				failed,
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
			actionType: "backfill_dimensions",
			actorTokenHash: adminTokenHash,
			ipHash: identity.ipHash,
			requestId,
			params: auditParams,
			result: auditResult,
			status: auditStatus,
		}).catch(() => null);
	}
}
