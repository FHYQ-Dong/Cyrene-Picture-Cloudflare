import { updateThumbnailState } from "./db.js";
import { resolveThumbUrl } from "./image-url.js";
import { writeLog } from "./log.js";

export function createThumbObjectKey(objectKey, imageId, format = "webp") {
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, "/");
	return `thumb/${date}/${imageId}.${format}`;
}

function trimTrailingSlash(url) {
	return String(url || "").replace(/\/+$/, "");
}

function buildResizeUrl(config, objectKey) {
	const resizeBaseUrl = trimTrailingSlash(config.thumbnailResizeBaseUrl);
	const publicImageBaseUrl = trimTrailingSlash(config.publicImageBaseUrl);
	if (!resizeBaseUrl || !publicImageBaseUrl) {
		return "";
	}

	const sourceUrl = `${publicImageBaseUrl}/${objectKey}`;
	const resizeOptions = [
		`width=${Math.max(config.thumbnailWidth || 360, 1)}`,
		`quality=${Math.max(config.thumbnailQuality || 80, 1)}`,
		`format=${config.thumbnailFormat || "webp"}`,
		"fit=scale-down",
	].join(",");

	return `${resizeBaseUrl}/cdn-cgi/image/${resizeOptions}/${sourceUrl}`;
}

async function generateThumbnailWithCloudflareImageResizing(
	env,
	config,
	objectKey,
	thumbObjectKey
) {
	const resizeUrl = buildResizeUrl(config, objectKey);
	if (!resizeUrl) {
		const error = new Error(
			"THUMBNAIL_RESIZE_BASE_URL or PUBLIC_IMAGE_BASE_URL missing"
		);
		error.code = "THUMBNAIL_CONFIG_MISSING";
		error.resizeUrl = resizeUrl;
		throw error;
	}

	const controller = new AbortController();
	const timeoutMs = 10000;
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	let response;
	try {
		response = await fetch(resizeUrl, {
			method: "GET",
			headers: {
				accept: "image/*",
			},
			signal: controller.signal,
		});
	} catch (error) {
		const fetchError = new Error(String(error?.message || error));
		fetchError.code =
			error?.name === "AbortError"
				? "THUMBNAIL_FETCH_TIMEOUT"
				: "THUMBNAIL_FETCH_FAILED";
		fetchError.resizeUrl = resizeUrl;
		fetchError.timeoutMs = timeoutMs;
		throw fetchError;
	} finally {
		clearTimeout(timeoutId);
	}

	if (!response.ok) {
		const error = new Error(
			`thumbnail resize request failed: ${response.status}`
		);
		error.code = "THUMBNAIL_FETCH_HTTP_ERROR";
		error.httpStatus = response.status;
		error.resizeUrl = resizeUrl;
		throw error;
	}

	const body = await response.arrayBuffer();
	if (!body.byteLength) {
		const error = new Error("thumbnail resize response empty");
		error.code = "THUMBNAIL_EMPTY_BODY";
		error.httpStatus = response.status;
		error.resizeUrl = resizeUrl;
		throw error;
	}

	const contentType =
		response.headers.get("content-type") ||
		(config.thumbnailFormat === "avif" ? "image/avif" : "image/webp");

	await env.R2.put(thumbObjectKey, body, {
		httpMetadata: {
			contentType,
		},
	});

	return {
		resizeUrl,
		httpStatus: response.status,
		byteLength: body.byteLength,
		contentType,
	};
}

export async function processThumbnailJob(env, config, payload) {
	const { imageId, objectKey, thumbObjectKey } = payload;

	try {
		const sourceObject = await env.R2.head(objectKey);
		if (!sourceObject) {
			writeLog("warn", {
				route: "thumbnail-job",
				image_id: imageId,
				object_key: objectKey,
				thumb_object_key: thumbObjectKey,
				error_code: "THUMBNAIL_SOURCE_NOT_FOUND",
				message: "source object not found in R2",
			});
			await updateThumbnailState(env.DB, imageId, {
				thumbStatus: "failed",
			});
			return;
		}

		if (config.thumbnailGenerator !== "enabled") {
			writeLog("warn", {
				route: "thumbnail-job",
				image_id: imageId,
				object_key: objectKey,
				thumb_object_key: thumbObjectKey,
				error_code: "THUMBNAIL_GENERATOR_DISABLED",
				message: "thumbnail generator disabled",
			});
			await updateThumbnailState(env.DB, imageId, {
				thumbStatus: "failed",
			});
			return;
		}

		const result = await generateThumbnailWithCloudflareImageResizing(
			env,
			config,
			objectKey,
			thumbObjectKey
		);

		writeLog("info", {
			route: "thumbnail-job",
			image_id: imageId,
			object_key: objectKey,
			thumb_object_key: thumbObjectKey,
			resize_url: result.resizeUrl,
			http_status: result.httpStatus,
			thumb_bytes: result.byteLength,
			thumb_content_type: result.contentType,
		});

		const thumbPublicUrl = resolveThumbUrl(config, thumbObjectKey);
		await updateThumbnailState(env.DB, imageId, {
			thumbObjectKey,
			thumbPublicUrl,
			thumbStatus: "ready",
		});
	} catch (error) {
		writeLog("error", {
			route: "thumbnail-job",
			image_id: imageId,
			object_key: objectKey,
			thumb_object_key: thumbObjectKey,
			error_code: error?.code || "THUMBNAIL_JOB_FAILED",
			http_status: error?.httpStatus || null,
			resize_url: error?.resizeUrl || buildResizeUrl(config, objectKey),
			timeout_ms: error?.timeoutMs || null,
			message: String(error?.message || error),
		});
		await updateThumbnailState(env.DB, imageId, {
			thumbStatus: "failed",
		});
	}
}
