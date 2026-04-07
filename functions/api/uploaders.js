import { ErrorCode, jsonError, jsonOk } from "../_shared/errors.js";
import { listDistinctUploaders } from "../_shared/db.js";

export async function onRequestGet(context) {
	const { request, env } = context;

	try {
		const url = new URL(request.url);
		const limitRaw = Number(url.searchParams.get("limit") || "200");
		const limit = Math.min(Math.max(limitRaw, 1), 1000);
		const cursor = String(url.searchParams.get("cursor") || "").trim();

		const rows = await listDistinctUploaders(env.DB, limit, cursor || null);
		const items = rows
			.map((row) => ({
				nickname: String(row?.nickname || "").trim(),
			}))
			.filter((row) => row.nickname);

		const nextCursor =
			items.length >= limit ? items[items.length - 1].nickname : null;

		return jsonOk({
			items,
			nextCursor,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
