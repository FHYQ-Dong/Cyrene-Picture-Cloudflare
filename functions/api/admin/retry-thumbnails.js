import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";
import { getConfig } from "../../_shared/env.js";
import { getIdentity, sha256Hex } from "../../_shared/identity.js";
import { incrementMinuteCounter } from "../../_shared/rate-limit.js";
import { writeAdminActionLog } from "../../_shared/db.js";
import {
	createThumbObjectKey,
	processThumbnailJob,
} from "../../_shared/thumbnail.js";

const MAX_LIMIT = 200;

function normalizeLimit(rawValue) {
	const value = Number(rawValue);
	if (!Number.isFinite(value)) return 50;
	return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function isTruthy(rawValue) {
	const value = String(rawValue || "")
		.trim()
		.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
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

async function listFailedRows(db, limit) {
	const rows = await db
		.prepare(
			`SELECT image_id, object_key, thumb_object_key, created_at
       FROM images
       WHERE thumb_status = 'failed'
       ORDER BY created_at ASC
       LIMIT ?1`
		)
		.bind(limit)
		.all();
	return rows.results || [];
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
	const dryRun = isTruthy(body.dryRun ?? url.searchParams.get("dryRun"));
	auditParams = { limit, dryRun, path: url.pathname };

	try {
		const failedRows = await listFailedRows(env.DB, limit);
		if (!failedRows.length) {
			auditResult = {
				picked: 0,
				processed: 0,
				succeeded: 0,
				failed: 0,
			};
			return jsonOk(
				{
					requestId,
					limit,
					dryRun,
					picked: 0,
					processed: 0,
					succeeded: 0,
					failed: 0,
					items: [],
				},
				{ headers: { "cache-control": "no-store" } }
			);
		}

		if (dryRun) {
			auditResult = {
				picked: failedRows.length,
				processed: 0,
				succeeded: 0,
				failed: 0,
			};
			return jsonOk(
				{
					requestId,
					limit,
					dryRun,
					picked: failedRows.length,
					processed: 0,
					succeeded: 0,
					failed: 0,
					items: failedRows.map((row) => ({
						imageId: row.image_id,
						objectKey: row.object_key,
						thumbObjectKey:
							row.thumb_object_key ||
							createThumbObjectKey(
								row.object_key,
								row.image_id,
								config.thumbnailFormat
							),
						createdAt: row.created_at,
					})),
				},
				{ headers: { "cache-control": "no-store" } }
			);
		}

		const items = [];
		let succeeded = 0;
		let failed = 0;

		for (const row of failedRows) {
			const thumbObjectKey =
				row.thumb_object_key ||
				createThumbObjectKey(
					row.object_key,
					row.image_id,
					config.thumbnailFormat
				);

			try {
				await processThumbnailJob(env, config, {
					imageId: row.image_id,
					objectKey: row.object_key,
					thumbObjectKey,
				});

				const latest = await env.DB.prepare(
					`SELECT thumb_status, thumb_object_key, thumb_public_url, updated_at
           FROM images
           WHERE image_id = ?1`
				)
					.bind(row.image_id)
					.first();

				if (latest?.thumb_status === "ready") {
					succeeded += 1;
					items.push({
						imageId: row.image_id,
						ok: true,
						thumbStatus: latest.thumb_status,
						thumbObjectKey: latest.thumb_object_key,
						thumbPublicUrl: latest.thumb_public_url,
						updatedAt: latest.updated_at,
					});
				} else {
					failed += 1;
					items.push({
						imageId: row.image_id,
						ok: false,
						thumbStatus: latest?.thumb_status || "failed",
					});
				}
			} catch (error) {
				failed += 1;
				items.push({
					imageId: row.image_id,
					ok: false,
					error: String(error?.message || error),
				});
			}
		}

		auditResult = {
			picked: failedRows.length,
			processed: failedRows.length,
			succeeded,
			failed,
		};

		return jsonOk(
			{
				requestId,
				limit,
				dryRun: false,
				picked: failedRows.length,
				processed: failedRows.length,
				succeeded,
				failed,
				items,
			},
			{ headers: { "cache-control": "no-store" } }
		);
	} catch (error) {
		auditStatus = "error";
		auditResult = {
			message: String(error?.message || error),
		};
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	} finally {
		await writeAdminActionLog(env.DB, {
			actionType: "thumbnail_repair",
			actorTokenHash: adminTokenHash,
			ipHash: identity.ipHash,
			requestId,
			params: auditParams,
			result: auditResult,
			status: auditStatus,
		}).catch(() => null);
	}
}
