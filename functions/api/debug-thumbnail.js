import { jsonError, jsonOk } from "../_shared/errors.js";
import { getConfig } from "../_shared/env.js";

function trimTrailingSlash(url) {
	return String(url || "").replace(/\/+$/, "");
}

function buildResizeUrl(config, objectKey) {
	const resizeBaseUrl = trimTrailingSlash(config.thumbnailResizeBaseUrl);
	const publicImageBaseUrl = trimTrailingSlash(config.publicImageBaseUrl);
	if (!resizeBaseUrl || !publicImageBaseUrl || !objectKey) {
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

export async function onRequestGet(context) {
	const { env, request } = context;
	const url = new URL(request.url);
	const objectKey = String(url.searchParams.get("objectKey") || "").trim();

	if (!objectKey) {
		return jsonError("INVALID_REQUEST", "missing objectKey", 400);
	}

	const expectedToken = String(env.DEBUG_API_TOKEN || "").trim();
	if (expectedToken) {
		const inputToken = String(
			request.headers.get("x-debug-token") || ""
		).trim();
		if (!inputToken || inputToken !== expectedToken) {
			return jsonError("FORBIDDEN", "invalid debug token", 403);
		}
	}

	const config = getConfig(env);
	const resizeUrl = buildResizeUrl(config, objectKey);
	if (!resizeUrl) {
		return jsonError(
			"CONFIG_MISSING",
			"thumbnail resize url unavailable",
			500,
			{
				publicImageBaseUrl: config.publicImageBaseUrl,
				thumbnailResizeBaseUrl: config.thumbnailResizeBaseUrl,
			}
		);
	}

	const result = {
		objectKey,
		resizeUrl,
		publicImageBaseUrl: config.publicImageBaseUrl,
		thumbnailResizeBaseUrl: config.thumbnailResizeBaseUrl,
		headOk: false,
		resizeHttpStatus: null,
		resizeContentType: null,
		resizeByteLength: 0,
		r2PutOk: false,
		r2PutKey: "",
	};

	try {
		const sourceHead = await env.R2.head(objectKey);
		result.headOk = !!sourceHead;
		if (!sourceHead) {
			return jsonError(
				"THUMBNAIL_SOURCE_NOT_FOUND",
				"source object not found",
				404,
				result
			);
		}

		const response = await fetch(resizeUrl, {
			method: "GET",
			headers: { accept: "image/*" },
		});
		result.resizeHttpStatus = response.status;
		result.resizeContentType = response.headers.get("content-type");

		if (!response.ok) {
			const sample = await response.text().catch(() => "");
			return jsonError(
				"THUMBNAIL_FETCH_HTTP_ERROR",
				"resize request failed",
				502,
				{
					...result,
					bodySample: sample.slice(0, 300),
				}
			);
		}

		const buffer = await response.arrayBuffer();
		result.resizeByteLength = buffer.byteLength;
		if (!buffer.byteLength) {
			return jsonError(
				"THUMBNAIL_EMPTY_BODY",
				"resize response empty",
				502,
				result
			);
		}

		const testKey = `thumb/debug/${new Date()
			.toISOString()
			.slice(0, 10)
			.replace(/-/g, "/")}/${crypto.randomUUID()}.${
			config.thumbnailFormat || "webp"
		}`;
		await env.R2.put(testKey, buffer, {
			httpMetadata: {
				contentType:
					result.resizeContentType ||
					(config.thumbnailFormat === "avif"
						? "image/avif"
						: "image/webp"),
			},
		});
		result.r2PutOk = true;
		result.r2PutKey = testKey;

		await env.R2.delete(testKey).catch(() => null);
		return jsonOk(result, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return jsonError("THUMBNAIL_DEBUG_FAILED", "debug check failed", 500, {
			...result,
			message: String(error?.message || error),
			name: error?.name || null,
		});
	}
}
