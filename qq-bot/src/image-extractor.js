function normalizeUrl(url) {
	const value = String(url || "").trim();
	if (!value) return "";
	if (value.startsWith("http://") || value.startsWith("https://"))
		return value;
	if (value.startsWith("//")) return `https:${value}`;
	return "";
}

function normalizeImageSegment(segment, index) {
	const data = segment?.data || {};
	const imageUrl = normalizeUrl(
		data.url || data.file || data.src || data.image_url || data.origin_url
	);
	if (!imageUrl) return null;

	const mime = String(data.mime || data.content_type || "image/jpeg")
		.trim()
		.toLowerCase();
	const fileName = String(
		data.file_name || data.filename || `image-${index}.jpg`
	).trim();

	return {
		clientFileId: `img-${index}`,
		imageUrl,
		fileName,
		mime,
	};
}

function parseMessageSegments(message) {
	if (Array.isArray(message)) return message;
	if (typeof message === "string") {
		const matches = [...message.matchAll(/\[CQ:image,([^\]]+)\]/g)];
		return matches.map((match) => {
			const attrs = String(match[1] || "").split(",");
			const data = {};
			for (const attr of attrs) {
				const [key, ...rest] = attr.split("=");
				if (!key) continue;
				data[key.trim()] = rest.join("=").trim();
			}
			return { type: "image", data };
		});
	}
	return [];
}

export function extractImagesFromEvent(event, maxItems = 20) {
	const segments = parseMessageSegments(event?.message);
	const images = [];
	for (const segment of segments) {
		if (segment?.type !== "image") continue;
		if (images.length >= maxItems) break;
		const normalized = normalizeImageSegment(segment, images.length);
		if (normalized) images.push(normalized);
	}
	return images;
}
