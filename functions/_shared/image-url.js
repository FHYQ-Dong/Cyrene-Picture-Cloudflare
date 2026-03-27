export function resolveImageUrl(config, objectKey, storedPublicUrl = "") {
	if (!objectKey) return storedPublicUrl || "";
	if (config.localUploadDirect) {
		return `/api/object?key=${encodeURIComponent(objectKey)}`;
	}
	return storedPublicUrl || `${config.publicImageBaseUrl}/${objectKey}`;
}

export function resolveThumbUrl(
	config,
	thumbObjectKey,
	storedThumbPublicUrl = ""
) {
	if (!thumbObjectKey) return storedThumbPublicUrl || "";
	if (config.localUploadDirect) {
		return `/api/object?key=${encodeURIComponent(thumbObjectKey)}`;
	}
	return (
		storedThumbPublicUrl || `${config.publicImageBaseUrl}/${thumbObjectKey}`
	);
}
