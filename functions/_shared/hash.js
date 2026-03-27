export async function sha256HexFromArrayBuffer(buffer) {
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const hex = [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

export function normalizeContentHash(value) {
	const text = String(value || "")
		.trim()
		.toLowerCase();
	if (!text) return "";
	if (text.startsWith("sha256:")) {
		return /^sha256:[a-f0-9]{64}$/.test(text) ? text : "";
	}
	return /^[a-f0-9]{64}$/.test(text) ? `sha256:${text}` : "";
}
