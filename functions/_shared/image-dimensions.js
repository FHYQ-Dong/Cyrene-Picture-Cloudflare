function isPng(bytes) {
	if (bytes.length < 24) return false;
	return (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	);
}

function parsePngDimensions(bytes) {
	const width =
		(bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
	const height =
		(bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
	return width > 0 && height > 0 ? { width, height } : null;
}

function isGif(bytes) {
	if (bytes.length < 10) return false;
	const signature = String.fromCharCode(
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5]
	);
	return signature === "GIF87a" || signature === "GIF89a";
}

function parseGifDimensions(bytes) {
	const width = bytes[6] | (bytes[7] << 8);
	const height = bytes[8] | (bytes[9] << 8);
	return width > 0 && height > 0 ? { width, height } : null;
}

function isJpeg(bytes) {
	return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function parseJpegDimensions(bytes) {
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1];
		offset += 2;

		if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
		if (marker >= 0xd0 && marker <= 0xd7) continue;
		if (offset + 2 > bytes.length) break;

		const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
		if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

		const isSofMarker =
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf);

		if (isSofMarker && segmentLength >= 7) {
			const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
			const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
			if (width > 0 && height > 0) {
				return { width, height };
			}
		}

		offset += segmentLength;
	}

	return null;
}

function isWebp(bytes) {
	if (bytes.length < 16) return false;
	const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
	const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
	return riff === "RIFF" && webp === "WEBP";
}

function parseWebpDimensions(bytes) {
	if (bytes.length < 30) return null;
	const chunkType = String.fromCharCode(
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	);

	if (chunkType === "VP8X" && bytes.length >= 30) {
		const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
		const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
		return width > 0 && height > 0 ? { width, height } : null;
	}

	if (chunkType === "VP8 " && bytes.length >= 30) {
		const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
		const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
		return width > 0 && height > 0 ? { width, height } : null;
	}

	if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
		const bits =
			bytes[21] |
			(bytes[22] << 8) |
			(bytes[23] << 16) |
			(bytes[24] << 24);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		return width > 0 && height > 0 ? { width, height } : null;
	}

	return null;
}

function isAvif(bytes) {
	if (bytes.length < 16) return false;
	const type = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
	if (type !== "ftyp") return false;
	const majorBrand = String.fromCharCode(
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11]
	);
	return majorBrand === "avif" || majorBrand === "avis";
}

function parseAvifDimensions(bytes) {
	const marker = [0x69, 0x73, 0x70, 0x65];
	for (let index = 4; index + 20 < bytes.length; index += 1) {
		if (
			bytes[index] === marker[0] &&
			bytes[index + 1] === marker[1] &&
			bytes[index + 2] === marker[2] &&
			bytes[index + 3] === marker[3]
		) {
			const width =
				(bytes[index + 8] << 24) |
				(bytes[index + 9] << 16) |
				(bytes[index + 10] << 8) |
				bytes[index + 11];
			const height =
				(bytes[index + 12] << 24) |
				(bytes[index + 13] << 16) |
				(bytes[index + 14] << 8) |
				bytes[index + 15];
			if (width > 0 && height > 0) {
				return { width, height };
			}
		}
	}
	return null;
}

export function extractImageDimensionsFromBytes(inputBytes) {
	const bytes =
		inputBytes instanceof Uint8Array
			? inputBytes
			: new Uint8Array(inputBytes || []);
	if (!bytes.length) return null;

	if (isPng(bytes)) return parsePngDimensions(bytes);
	if (isGif(bytes)) return parseGifDimensions(bytes);
	if (isJpeg(bytes)) return parseJpegDimensions(bytes);
	if (isWebp(bytes)) return parseWebpDimensions(bytes);
	if (isAvif(bytes)) return parseAvifDimensions(bytes);

	return null;
}
