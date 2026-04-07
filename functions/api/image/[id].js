import { jsonError, jsonOk, ErrorCode } from "../../_shared/errors";
import { getImageById, getImageNeighbors } from "../../_shared/db";
import { getConfig } from "../../_shared/env";
import { resolveImageUrl, resolveThumbUrl } from "../../_shared/image-url";

export async function onRequestGet(context) {
	const { params, env } = context;
	const config = getConfig(env);

	try {
		const imageId = params.id;
		if (!imageId) {
			return jsonError(ErrorCode.InvalidRequest, "missing image id", 400);
		}

		const image = await getImageById(env.DB, imageId);
		const mediaType = String(image?.media_type || "image")
			.trim()
			.toLowerCase();
		if (
			!image ||
			image.status !== "active" ||
			(mediaType && mediaType !== "image")
		) {
			return jsonError(ErrorCode.ObjectNotFound, "image not found", 404);
		}
		const neighbors = await getImageNeighbors(env.DB, image);

		const mapNeighbor = (neighbor) => {
			if (!neighbor) return null;
			const publicUrl = resolveImageUrl(
				config,
				neighbor.object_key,
				neighbor.public_url
			);
			const thumbUrl = resolveThumbUrl(
				config,
				neighbor.thumb_object_key,
				neighbor.thumb_public_url
			);
			return {
				image_id: neighbor.image_id,
				thumb_url: thumbUrl || publicUrl,
			};
		};

		const publicUrl = resolveImageUrl(
			config,
			image.object_key,
			image.public_url
		);
		const thumbUrl = resolveThumbUrl(
			config,
			image.thumb_object_key,
			image.thumb_public_url
		);
		const width = Number(image.width || 0);
		const height = Number(image.height || 0);
		const aspectRatio = width > 0 && height > 0 ? width / height : null;

		return jsonOk(
			{
				...image,
				uploader_nickname: image.uploader_nickname || "093",
				thumb_status: image.thumb_status || "none",
				thumb_url: thumbUrl || publicUrl,
				public_url: publicUrl,
				aspect_ratio: aspectRatio,
				prev: mapNeighbor(neighbors.prev),
				next: mapNeighbor(neighbors.next),
			},
			{
				headers: {
					"cache-control": "no-store",
				},
			}
		);
	} catch {
		return jsonError(ErrorCode.InternalError, "internal error", 500);
	}
}
