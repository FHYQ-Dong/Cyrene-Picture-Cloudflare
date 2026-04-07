import { dayBucket, nowIso } from "./identity.js";

export function buildQuotaUpsertStatement(
	db,
	{ bucketDate, scope, scopeKey, addCount, addBytes, updatedAt = nowIso() }
) {
	const normalizedAddCount = Number(addCount || 0);
	const normalizedAddBytes = Number(addBytes || 0);
	if (!bucketDate || !scope || !scopeKey) return null;
	if (normalizedAddCount <= 0 && normalizedAddBytes <= 0) return null;
	return db
		.prepare(
			`INSERT INTO quota_daily (bucket_date, scope, scope_key, upload_count, upload_bytes, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(bucket_date, scope, scope_key)
       DO UPDATE SET upload_count = upload_count + excluded.upload_count,
                     upload_bytes = upload_bytes + excluded.upload_bytes,
                     updated_at = excluded.updated_at`
		)
		.bind(
			bucketDate,
			scope,
			scopeKey,
			normalizedAddCount,
			normalizedAddBytes,
			updatedAt
		);
}

export async function applyQuotaIncrements(
	db,
	increments,
	bucketDate = dayBucket()
) {
	const updatedAt = nowIso();
	const statements = (increments || [])
		.map((item) =>
			buildQuotaUpsertStatement(db, {
				bucketDate,
				scope: item?.scope,
				scopeKey: item?.scopeKey,
				addCount: item?.addCount,
				addBytes: item?.addBytes,
				updatedAt,
			})
		)
		.filter(Boolean);
	if (!statements.length) return;
	if (typeof db.batch === "function") {
		await db.batch(statements);
		return;
	}
	for (const statement of statements) {
		await statement.run();
	}
}

async function upsertQuota(
	db,
	bucketDate,
	scope,
	scopeKey,
	addCount,
	addBytes
) {
	await applyQuotaIncrements(
		db,
		[
			{
				scope,
				scopeKey,
				addCount,
				addBytes,
			},
		],
		bucketDate
	);
}

export async function getQuotaRow(db, bucketDate, scope, scopeKey) {
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

export async function getQuotaRows(db, bucketDate, items) {
	const normalizedItems = Array.isArray(items) ? items : [];
	if (!normalizedItems.length) return [];
	if (typeof db.batch !== "function") {
		return Promise.all(
			normalizedItems.map((item) =>
				getQuotaRow(db, bucketDate, item.scope, item.scopeKey)
			)
		);
	}
	const statements = normalizedItems.map((item) =>
		db
			.prepare(
				`SELECT upload_count, upload_bytes FROM quota_daily WHERE bucket_date = ?1 AND scope = ?2 AND scope_key = ?3`
			)
			.bind(bucketDate, item.scope, item.scopeKey)
	);
	const results = await db.batch(statements);
	return normalizedItems.map((_, index) => {
		const row = results?.[index]?.results?.[0] || null;
		return {
			uploadCount: Number(row?.upload_count || 0),
			uploadBytes: Number(row?.upload_bytes || 0),
		};
	});
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
