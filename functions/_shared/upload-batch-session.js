const TOKEN_VERSION = 1;

function toBase64UrlFromBytes(bytes) {
	let binary = "";
	for (const value of bytes) {
		binary += String.fromCharCode(value);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function toBase64UrlFromString(value) {
	const bytes = new TextEncoder().encode(value);
	return toBase64UrlFromBytes(bytes);
}

function fromBase64UrlToBytes(value) {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function fromBase64UrlToString(value) {
	const bytes = fromBase64UrlToBytes(value);
	return new TextDecoder().decode(bytes);
}

async function hmacSignBytes(secret, message) {
	const keyData = new TextEncoder().encode(secret);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(message)
	);
	return new Uint8Array(signature);
}

function timingSafeEqualString(left, right) {
	const leftBytes = new TextEncoder().encode(String(left || ""));
	const rightBytes = new TextEncoder().encode(String(right || ""));
	let result = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		const leftValue = leftBytes[index] ?? 0;
		const rightValue = rightBytes[index] ?? 0;
		result |= leftValue ^ rightValue;
	}
	return result === 0;
}

export async function issueBatchSessionToken(config, payload) {
	if (!config.uploadBatchSessionSecret) {
		throw new Error("UPLOAD_BATCH_SESSION_SECRET_MISSING");
	}

	const issuedAt = new Date().toISOString();
	const expiresAt = new Date(
		Date.now() +
			Math.max(config.uploadBatchSessionTtlSeconds || 900, 1) * 1000
	).toISOString();

	const tokenPayload = {
		v: TOKEN_VERSION,
		sid: crypto.randomUUID(),
		batchId: payload.batchId,
		visitorId: payload.visitorId,
		ipHash: payload.ipHash,
		issuedAt,
		expiresAt,
	};

	const payloadEncoded = toBase64UrlFromString(JSON.stringify(tokenPayload));
	const signature = await hmacSignBytes(
		config.uploadBatchSessionSecret,
		payloadEncoded
	);
	const signatureEncoded = toBase64UrlFromBytes(signature);

	return {
		token: `${payloadEncoded}.${signatureEncoded}`,
		tokenId: tokenPayload.sid,
		issuedAt,
		expiresAt,
		payload: tokenPayload,
	};
}

export async function verifyBatchSessionToken(
	config,
	batchSessionToken,
	options = {}
) {
	if (!config.uploadBatchSessionSecret) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_SECRET_MISSING",
		};
	}

	const token = String(batchSessionToken || "").trim();
	if (!token || !token.includes(".")) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_INVALID",
		};
	}

	const [payloadEncoded, signatureEncoded] = token.split(".", 2);
	if (!payloadEncoded || !signatureEncoded) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_INVALID",
		};
	}

	let payload;
	try {
		payload = JSON.parse(fromBase64UrlToString(payloadEncoded));
	} catch {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_INVALID",
		};
	}

	const expectedSignature = toBase64UrlFromBytes(
		await hmacSignBytes(config.uploadBatchSessionSecret, payloadEncoded)
	);
	if (!timingSafeEqualString(signatureEncoded, expectedSignature)) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_INVALID",
		};
	}

	if (payload?.v !== TOKEN_VERSION || !payload?.sid || !payload?.batchId) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_INVALID",
		};
	}

	const expiresAt = new Date(payload.expiresAt).getTime();
	if (!Number.isFinite(expiresAt)) {
		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_EXPIRED",
			payload,
		};
	}

	const nowMs = Date.now();
	if (expiresAt < nowMs) {
		const graceSeconds = Math.max(
			Number(options.allowExpiredWithinSeconds || 0),
			0
		);
		const graceMs = graceSeconds * 1000;
		if (graceMs > 0 && nowMs - expiresAt <= graceMs) {
			return {
				ok: true,
				payload,
				isGraceRenewed: true,
			};
		}

		return {
			ok: false,
			reason: "UPLOAD_BATCH_SESSION_EXPIRED",
			payload,
		};
	}

	return {
		ok: true,
		payload,
	};
}
