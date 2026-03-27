import { ErrorCode, jsonError } from "../_shared/errors";

export async function onRequestGet(context) {
	const { request, env } = context;
	const url = new URL(request.url);
	const objectKey = (url.searchParams.get("key") || "").trim();

	if (!objectKey) {
		return jsonError(ErrorCode.InvalidRequest, "missing key", 400);
	}

	const object = await env.R2.get(objectKey);
	if (!object) {
		return jsonError(ErrorCode.ObjectNotFound, "object not found", 404);
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("cache-control", "public, max-age=31536000, immutable");

	return new Response(object.body, { status: 200, headers });
}
