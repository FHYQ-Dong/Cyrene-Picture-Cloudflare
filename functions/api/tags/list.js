import { listTags } from "../../_shared/db.js";
import { ErrorCode, jsonError, jsonOk } from "../../_shared/errors.js";

export async function onRequestGet(context) {
	const { request, env } = context;

	try {
		const url = new URL(request.url);
		const limit = Number(url.searchParams.get("limit") || "100");
		const keyword = String(url.searchParams.get("q") || "").trim();
		const mediaTypeRaw = String(
			url.searchParams.get("mediaType") || "image"
		)
			.trim()
			.toLowerCase();
		const mediaType = mediaTypeRaw === "audio" ? "audio" : "image";

		const rows = await listTags(env.DB, {
			limit,
			keyword,
			mediaType,
		});

		const items = rows.map((row) => ({
			tag: String(row.tag_name || "").trim(),
			count: Number(row.count || 0),
		}));

		return jsonOk({
			items,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
