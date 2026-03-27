import { dayBucket, nowIso } from "./identity.js";

async function upsertQuota(
	db,
	bucketDate,
	scope,
	scopeKey,
	addCount,
	addBytes
) {
	await db
		.prepare(
			`INSERT INTO quota_daily (bucket_date, scope, scope_key, upload_count, upload_bytes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(bucket_date, scope, scope_key)
       DO UPDATE SET upload_count = upload_count + excluded.upload_count,
                     upload_bytes = upload_bytes + excluded.upload_bytes,
                     updated_at = excluded.updated_at`
		)
		.bind(bucketDate, scope, scopeKey, addCount, addBytes, nowIso())
		.run();
}

async function getQuotaRow(db, bucketDate, scope, scopeKey) {
	const row = await db
		.prepare(
			`SELECT upload_count, upload_bytes FROM quota_daily WHERE bucket_date = ?1 AND scope = ?2 AND scope_key = ?3`
		)
		.bind(bucketDate, scope, scopeKey)
		.first();
	return {
		uploadCount: Number(row?.upload_count || 0),
		uploadBytes: Number(row?.upload_bytes || 0),
	};
}

export async function checkAndConsumeQuotas(db, identity, fileSize, limits) {
	const bucketDate = dayBucket();

	const visitor = await getQuotaRow(
		db,
		bucketDate,
		"visitor",
		identity.visitorId
	);
	if (
		visitor.uploadCount + 1 > limits.maxVisitorCount ||
		visitor.uploadBytes + fileSize > limits.maxVisitorBytes
	) {
		return { ok: false, scope: "visitor" };
	}

	const ip = await getQuotaRow(db, bucketDate, "ip", identity.ipHash);
	if (
		ip.uploadCount + 1 > limits.maxIpCount ||
		ip.uploadBytes + fileSize > limits.maxIpBytes
	) {
		return { ok: false, scope: "ip" };
	}

	const global = await getQuotaRow(db, bucketDate, "global", "global");
	if (
		global.uploadCount + 1 > limits.maxGlobalCount ||
		global.uploadBytes + fileSize > limits.maxGlobalBytes
	) {
		return { ok: false, scope: "global" };
	}

	await upsertQuota(
		db,
		bucketDate,
		"visitor",
		identity.visitorId,
		1,
		fileSize
	);
	await upsertQuota(db, bucketDate, "ip", identity.ipHash, 1, fileSize);
	await upsertQuota(db, bucketDate, "global", "global", 1, fileSize);

	return { ok: true };
}
