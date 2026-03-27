import { ErrorCode, jsonError } from "../_shared/errors";
import { getConfig } from "../_shared/env";

export async function onRequestPut(context) {
	const { request, env } = context;
	const config = getConfig(env);

	if (!config.localUploadDirect) {
		return jsonError(
			ErrorCode.InvalidRequest,
			"local direct upload is disabled",
			400
		);
	}

	const url = new URL(request.url);
	const objectKey = (url.searchParams.get("objectKey") || "").trim();
	if (!objectKey) {
		return jsonError(ErrorCode.InvalidRequest, "missing objectKey", 400);
	}

	const mime = (request.headers.get("content-type") || "").toLowerCase();
	if (!config.allowedMime.has(mime)) {
		return jsonError(ErrorCode.MimeNotAllowed, "mime not allowed", 400);
	}

	const body = await request.arrayBuffer();
	if (body.byteLength <= 0 || body.byteLength > config.maxFileSize) {
		return jsonError(
			ErrorCode.UploadSizeExceeded,
			"file size exceeded",
			400
		);
	}

	const putResult = await env.R2.put(objectKey, body, {
		httpMetadata: {
			contentType: mime,
		},
	});

	return new Response(null, {
		status: 200,
		headers: {
			etag: putResult?.etag || "",
		},
	});
}
