import { jsonError, jsonOk, ErrorCode } from "../_shared/errors";
import { listImages } from "../_shared/db";
import { getConfig } from "../_shared/env";
import { resolveImageUrl, resolveThumbUrl } from "../_shared/image-url";

function toDateBucket(isoText) {
	return String(isoText || "").slice(0, 10) || "unknown";
}

function buildGroups(items, groupBy) {
	if (groupBy === "none") return [];
	const map = new Map();
	for (const item of items) {
		const key =
			groupBy === "uploader"
				? item.uploader_nickname || "093"
				: toDateBucket(item.created_at);
		if (!map.has(key)) map.set(key, []);
		map.get(key).push(item.image_id);
	}
	return Array.from(map.entries()).map(([groupKey, imageIds]) => ({
		groupKey,
		count: imageIds.length,
		imageIds,
	}));
}

export async function onRequestGet(context) {
	const { request, env } = context;
	const config = getConfig(env);

	try {
		const url = new URL(request.url);
		const limitRaw = Number(url.searchParams.get("limit") || "20");
		const limit = Math.min(Math.max(limitRaw, 1), 100);
		const cursor = url.searchParams.get("cursor");
		const groupByRaw = (url.searchParams.get("groupBy") || "date").trim();
		const groupBy = ["date", "uploader", "none"].includes(groupByRaw)
			? groupByRaw
			: "date";
		const uploader = (url.searchParams.get("uploader") || "").trim();

		const rows = await listImages(
			env.DB,
			limit,
			cursor || null,
			uploader || null
		);
		const items = rows.map((item) => {
			const thumbUrl = resolveThumbUrl(
				config,
				item.thumb_object_key,
				item.thumb_public_url
			);
			const publicUrl = resolveImageUrl(
				config,
				item.object_key,
				item.public_url
			);
			const width = Number(item.width || 0);
			const height = Number(item.height || 0);
			const aspectRatio = width > 0 && height > 0 ? width / height : null;
			return {
				...item,
				uploader_nickname: item.uploader_nickname || "093",
				thumb_status: item.thumb_status || "none",
				thumb_url: thumbUrl || publicUrl,
				public_url: publicUrl,
				aspect_ratio: aspectRatio,
			};
		});
		const nextCursor = items.length
			? items[items.length - 1].created_at
			: null;
		const groups = buildGroups(items, groupBy);

		return jsonOk({ items, nextCursor, groupBy, groups, uploader });
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
