import { minuteBucket, nowIso } from "./identity.js";

export async function getMinuteCounter(
	db,
	scope,
	scopeKey,
	bucketMinute = minuteBucket()
) {
	const row = await db
		.prepare(
			`SELECT request_count FROM rate_limits_minute WHERE bucket_minute = ?1 AND scope = ?2 AND scope_key = ?3`
		)
		.bind(bucketMinute, scope, scopeKey)
		.first();
	return Number(row?.request_count || 0);
}

export function buildMinuteCounterIncrementStatement(
	db,
	{
		scope,
		scopeKey,
		addCount,
		bucketMinute = minuteBucket(),
		updatedAt = nowIso(),
	}
) {
	const normalizedAddCount = Number(addCount || 0);
	if (!scope || !scopeKey || normalizedAddCount <= 0) return null;
	return db
		.prepare(
			`INSERT INTO rate_limits_minute (bucket_minute, scope, scope_key, request_count, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(bucket_minute, scope, scope_key)
       DO UPDATE SET request_count = request_count + excluded.request_count,
                     updated_at = excluded.updated_at`
		)
		.bind(bucketMinute, scope, scopeKey, normalizedAddCount, updatedAt);
}

export async function applyMinuteCounterIncrements(
	db,
	increments,
	bucketMinute = minuteBucket()
) {
	const updatedAt = nowIso();
	const statements = (increments || [])
		.map((item) =>
			buildMinuteCounterIncrementStatement(db, {
				scope: item?.scope,
				scopeKey: item?.scopeKey,
				addCount: item?.addCount,
				bucketMinute,
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

export async function incrementMinuteCounter(db, scope, scopeKey) {
	const bucketMinute = minuteBucket();
	await applyMinuteCounterIncrements(
		db,
		[
			{
				scope,
				scopeKey,
				addCount: 1,
			},
		],
		bucketMinute
	);
	return getMinuteCounter(db, scope, scopeKey, bucketMinute);
}
