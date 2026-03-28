import { ErrorCode } from "./errors.js";
import {
	decrementObjectRefCount,
	getImageForDelete,
	getImageObjectById,
	softDeleteImage,
} from "./db.js";

function toBoolean(rawValue, fallback = false) {
	if (rawValue == null) return fallback;
	if (typeof rawValue === "boolean") return rawValue;
	const value = String(rawValue).trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes") return true;
	if (value === "0" || value === "false" || value === "no") return false;
	return fallback;
}

function normalizeReason(rawValue) {
	const text = String(rawValue || "").trim();
	return text.slice(0, 200);
}

function uniqueKeys(keys) {
	const seen = new Set();
	const result = [];
	for (const key of keys) {
		const value = String(key || "").trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

export function parseDeleteRequestOptions(body, fallback = {}) {
	return {
		dryRun: toBoolean(body?.dryRun, fallback.dryRun ?? false),
		reason: normalizeReason(body?.reason || fallback.reason || ""),
		continueOnError: toBoolean(
			body?.continueOnError,
			fallback.continueOnError ?? true
		),
	};
}

async function deleteStorageObjectSafe(
	bucket,
	objectKey,
	storageResult,
	keyName
) {
	if (!bucket || !objectKey) {
		storageResult[keyName] = "skipped";
		return;
	}
	try {
		await bucket.delete(objectKey);
		storageResult[keyName] = "deleted";
	} catch {
		storageResult[keyName] = "failed";
	}
}

export async function deleteOneImage({
	env,
	imageId,
	dryRun = false,
	reason = "",
}) {
	const normalizedImageId = String(imageId || "").trim();
	if (!normalizedImageId) {
		return {
			imageId: normalizedImageId,
			result: "failed",
			errorCode: ErrorCode.InvalidRequest,
			message: "missing imageId",
			db: {
				imageSoftDeleted: false,
				objectRefDecremented: false,
			},
			storage: {
				originObject: "skipped",
				thumbObject: "skipped",
			},
		};
	}

	const image = await getImageForDelete(env.DB, normalizedImageId);
	if (!image) {
		return {
			imageId: normalizedImageId,
			result: "failed",
			errorCode: ErrorCode.ObjectNotFound,
			message: "image not found",
			db: {
				imageSoftDeleted: false,
				objectRefDecremented: false,
			},
			storage: {
				originObject: "skipped",
				thumbObject: "skipped",
			},
		};
	}

	if (image.status !== "active") {
		return {
			imageId: normalizedImageId,
			result: "skipped",
			errorCode: ErrorCode.ImageAlreadyDeleted,
			message: "image already deleted",
			db: {
				imageSoftDeleted: false,
				objectRefDecremented: false,
			},
			storage: {
				originObject: "skipped",
				thumbObject: "skipped",
			},
		};
	}

	const object = image.object_id
		? await getImageObjectById(env.DB, image.object_id)
		: null;
	const estimatedRefCount = Number(object?.ref_count || 0);
	const shouldDeleteStorage = image.object_id && estimatedRefCount <= 1;
	const sharedKeys = uniqueKeys([image.object_key, image.thumb_object_key]);

	if (dryRun) {
		return {
			imageId: normalizedImageId,
			result: "would_delete",
			errorCode: null,
			message: reason ? `dry-run: ${reason}` : "dry-run",
			db: {
				imageSoftDeleted: false,
				objectRefDecremented: !!image.object_id,
			},
			storage: {
				originObject:
					shouldDeleteStorage && sharedKeys.includes(image.object_key)
						? "would_delete"
						: "skipped",
				thumbObject:
					shouldDeleteStorage &&
					image.thumb_object_key &&
					sharedKeys.includes(image.thumb_object_key)
						? "would_delete"
						: "skipped",
			},
		};
	}

	const imageSoftDeleted = await softDeleteImage(env.DB, normalizedImageId);
	if (!imageSoftDeleted) {
		const latest = await getImageForDelete(env.DB, normalizedImageId);
		if (!latest || latest.status !== "active") {
			return {
				imageId: normalizedImageId,
				result: "skipped",
				errorCode: ErrorCode.ImageAlreadyDeleted,
				message: "image already deleted",
				db: {
					imageSoftDeleted: false,
					objectRefDecremented: false,
				},
				storage: {
					originObject: "skipped",
					thumbObject: "skipped",
				},
			};
		}
		return {
			imageId: normalizedImageId,
			result: "failed",
			errorCode: ErrorCode.InternalError,
			message: "failed to soft-delete image",
			db: {
				imageSoftDeleted: false,
				objectRefDecremented: false,
			},
			storage: {
				originObject: "skipped",
				thumbObject: "skipped",
			},
		};
	}

	let objectRefDecremented = false;
	let latestObject = object;
	if (image.object_id) {
		latestObject = await decrementObjectRefCount(env.DB, image.object_id);
		objectRefDecremented = true;
	}

	const storageResult = {
		originObject: "skipped",
		thumbObject: "skipped",
	};

	const latestRefCount = Number(latestObject?.ref_count || 0);
	const allowDeleteStorage = !!image.object_id && latestRefCount <= 0;
	if (allowDeleteStorage) {
		await deleteStorageObjectSafe(
			env.R2,
			image.object_key,
			storageResult,
			"originObject"
		);
		await deleteStorageObjectSafe(
			env.R2,
			image.thumb_object_key,
			storageResult,
			"thumbObject"
		);
	}

	if (
		storageResult.originObject === "failed" ||
		storageResult.thumbObject === "failed"
	) {
		return {
			imageId: normalizedImageId,
			result: "failed",
			errorCode: ErrorCode.PartialDeleteStorageFailed,
			message:
				"image metadata deleted but storage deletion partially failed",
			db: {
				imageSoftDeleted: true,
				objectRefDecremented,
			},
			storage: storageResult,
		};
	}

	return {
		imageId: normalizedImageId,
		result: "deleted",
		errorCode: null,
		message: "ok",
		db: {
			imageSoftDeleted: true,
			objectRefDecremented,
		},
		storage: storageResult,
	};
}

export function normalizeImageIds(rawImageIds) {
	if (!Array.isArray(rawImageIds)) return [];
	return uniqueKeys(rawImageIds.map((value) => String(value || "").trim()));
}
