import { minuteBucket, nowIso } from "./identity.js";

export async function incrementMinuteCounter(db, scope, scopeKey) {
	const bucketMinute = minuteBucket();
	await db
		.prepare(
			`INSERT INTO rate_limits_minute (bucket_minute, scope, scope_key, request_count, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(bucket_minute, scope, scope_key)
       DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at`
		)
		.bind(bucketMinute, scope, scopeKey, nowIso())
		.run();

	const row = await db
		.prepare(
			`SELECT request_count FROM rate_limits_minute WHERE bucket_minute = ?1 AND scope = ?2 AND scope_key = ?3`
		)
		.bind(bucketMinute, scope, scopeKey)
		.first();
	return Number(row?.request_count || 0);
}
