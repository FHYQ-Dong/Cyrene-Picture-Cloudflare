import {
	addTagsToImage,
	createOrReuseImageObject,
	createUploadEvent,
	getImageObjectByHash,
	upsertImageMetadata,
} from "./db.js";
import { ErrorCode } from "./errors.js";
import { sha256HexFromArrayBuffer } from "./hash.js";
import { createObjectKey } from "./identity.js";
import { resolveImageUrl } from "./image-url.js";
import { normalizeUploaderNickname } from "./nickname.js";
import { createThumbObjectKey, processThumbnailJob } from "./thumbnail.js";

function selectMime(itemMime, responseMime) {
	const fallback = String(responseMime || "")
		.trim()
		.toLowerCase()
		.split(";")[0];
	const preferred = String(itemMime || "")
		.trim()
		.toLowerCase();
	const mime = preferred || fallback;
	if (!mime.startsWith("image/")) return "";
	return mime;
}

export async function fetchImageBytes(url, maxSize) {
	const response = await fetch(url, {
		method: "GET",
		headers: { accept: "image/*" },
	});
	if (!response.ok) {
		throw new Error(`download failed: ${response.status}`);
	}
	const contentLength = Number(response.headers.get("content-length") || 0);
	if (contentLength > 0 && contentLength > maxSize) {
		throw new Error("file size exceeded");
	}
	const buffer = await response.arrayBuffer();
	if (!buffer.byteLength) throw new Error("empty image body");
	if (buffer.byteLength > maxSize) {
		throw new Error("file size exceeded");
	}
	return {
		buffer,
		mime: response.headers.get("content-type") || "",
	};
}

export async function ingestRemoteImageToLibrary({
	env,
	config,
	waitUntil,
	imageUrl,
	fileName,
	itemMime,
	uploaderNickname,
	tags,
	sourceBatchId,
	sourceClientFileId,
}) {
	const downloaded = await fetchImageBytes(imageUrl, config.maxFileSize);
	const mime = selectMime(itemMime, downloaded.mime);
	if (!mime || !config.allowedMime.has(mime) || !mime.startsWith("image/")) {
		return {
			ok: false,
			errorCode: ErrorCode.MimeNotAllowed,
			message: "mime not allowed",
		};
	}

	const contentHash = await sha256HexFromArrayBuffer(downloaded.buffer);
	const normalizedNickname = normalizeUploaderNickname(
		uploaderNickname,
		config.uploaderNicknameMaxLength
	).nickname;

	let object = await getImageObjectByHash(env.DB, contentHash);
	let dedupHit = Boolean(object && Number(object.ref_count) > 0);
	let uploadedObjectKey = "";
	let uploadedEtag = "";

	if (!dedupHit) {
		uploadedObjectKey = createObjectKey(fileName || "qq-image.jpg");
		const putResult = await env.R2.put(
			uploadedObjectKey,
			downloaded.buffer,
			{
				httpMetadata: { contentType: mime },
			}
		);
		uploadedEtag = String(putResult?.etag || "").trim();
		object = await createOrReuseImageObject(env.DB, {
			objectId: crypto.randomUUID(),
			contentHash,
			objectKey: uploadedObjectKey,
			mime,
			size: downloaded.buffer.byteLength,
			etag: uploadedEtag,
		});
		if (object?.object_key !== uploadedObjectKey) {
			dedupHit = true;
			await env.R2.delete(uploadedObjectKey).catch(() => null);
		}
	}

	if (!object?.object_id || !object?.object_key) {
		return {
			ok: false,
			errorCode: ErrorCode.InternalError,
			message: "failed to resolve image object",
		};
	}

	const imageId = crypto.randomUUID();
	const uploadEventId = crypto.randomUUID();
	const thumbObjectKey = createThumbObjectKey(
		object.object_key,
		imageId,
		config.thumbnailFormat || "webp"
	);
	const publicUrl = resolveImageUrl(config, object.object_key);

	await createUploadEvent(env.DB, {
		uploadEventId,
		objectId: object.object_id,
		sourceBatchId,
		sourceClientFileId,
		uploaderNickname: normalizedNickname,
		uploadMode: dedupHit ? "instant" : "normal",
	});

	await upsertImageMetadata(env.DB, {
		imageId,
		objectId: object.object_id,
		uploadEventId,
		contentHash,
		uploadMode: dedupHit ? "instant" : "normal",
		objectKey: object.object_key,
		publicUrl,
		thumbObjectKey,
		thumbPublicUrl: "",
		thumbStatus: config.thumbnailEnabled ? "pending" : "none",
		mediaType: "image",
		mime,
		size: Number(object.size_bytes || downloaded.buffer.byteLength),
		uploaderNickname: normalizedNickname,
		status: "active",
	});

	await addTagsToImage(env.DB, imageId, tags, "image");

	if (
		config.thumbnailEnabled &&
		config.thumbnailGenerator === "enabled" &&
		!dedupHit
	) {
		waitUntil?.(
			processThumbnailJob(env, config, {
				imageId,
				objectKey: object.object_key,
				thumbObjectKey,
			})
		);
	}

	return {
		ok: true,
		imageId,
		objectId: object.object_id,
		contentHash,
		dedupHit,
		publicUrl,
		tags,
	};
}
