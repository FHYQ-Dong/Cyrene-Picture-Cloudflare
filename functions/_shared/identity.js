export async function sha256Hex(input) {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export async function getIdentity(request) {
	const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
	const userAgent = request.headers.get("User-Agent") || "unknown";
	const identitySource = `${ip}|${userAgent}`;
	const visitorId = await sha256Hex(identitySource);
	const ipHash = await sha256Hex(ip);
	return { ip, visitorId, ipHash };
}

export function nowIso() {
	return new Date().toISOString();
}

export function dayBucket(date = new Date()) {
	return date.toISOString().slice(0, 10);
}

export function minuteBucket(date = new Date()) {
	return date.toISOString().slice(0, 16);
}

export function createObjectKey(filename = "file") {
	const now = new Date();
	const yyyy = String(now.getUTCFullYear());
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const ext = filename.includes(".")
		? filename.split(".").pop().toLowerCase()
		: "bin";
	const uuid = crypto.randomUUID();
	return `public/${yyyy}/${mm}/${dd}/${uuid}.${ext}`;
}
