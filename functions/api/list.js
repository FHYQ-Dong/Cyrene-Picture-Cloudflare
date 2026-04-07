import { jsonError, jsonOk, ErrorCode } from "../_shared/errors.js";
import {
	getTagsByImageIds,
	normalizeTagName,
	listImages,
} from "../_shared/db.js";
import { getConfig } from "../_shared/env.js";
import { resolveImageUrl, resolveThumbUrl } from "../_shared/image-url.js";

function parseAsUtcDate(dateText) {
	const raw = String(dateText || "").trim();
	if (!raw) return null;

	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		const parsed = new Date(`${raw}T00:00:00Z`);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(raw)) {
		const parsed = new Date(raw.replace(" ", "T") + "Z");
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) {
		const parsed = new Date(`${raw}Z`);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateBucketGmt8(dateText) {
	const parsed = parseAsUtcDate(dateText);
	if (!parsed) return "unknown";
	const gmt8 = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
	return gmt8.toISOString().slice(0, 10);
}

function buildGroups(items, groupBy) {
	if (groupBy === "none") return [];
	const map = new Map();
	for (const item of items) {
		const key =
			groupBy === "uploader"
				? item.uploader_nickname || "093"
				: toDateBucketGmt8(item.created_at);
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
		const mediaTypeRaw = String(
			url.searchParams.get("mediaType") || "image"
		)
			.trim()
			.toLowerCase();
		const mediaType = mediaTypeRaw === "audio" ? "audio" : "image";
		const uploader = (url.searchParams.get("uploader") || "").trim();
		const tag = normalizeTagName(url.searchParams.get("tag") || "");

		const rows = await listImages(
			env.DB,
			limit,
			cursor || null,
			uploader || null,
			mediaType,
			tag || null
		);
		const tagsByImageId = await getTagsByImageIds(
			env.DB,
			rows.map((item) => item.image_id),
			mediaType
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
				tags: tagsByImageId.get(item.image_id) || [],
				media_type: item.media_type || "image",
				uploader_nickname: item.uploader_nickname || "093",
				thumb_status: item.thumb_status || "none",
				thumb_url: thumbUrl || publicUrl,
				public_url: publicUrl,
				aspect_ratio: aspectRatio,
				duration_seconds:
					item.duration_seconds == null
						? null
						: Number(item.duration_seconds),
				audio_title: item.audio_title || null,
			};
		});
		const nextCursor = items.length
			? items[items.length - 1].created_at
			: null;
		const groups = buildGroups(items, groupBy);

		return jsonOk({
			items,
			nextCursor,
			groupBy,
			groups,
			uploader,
			tag,
			mediaType,
		});
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
