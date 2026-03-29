export async function verifyTurnstile(env, token, ip) {
	if (!env.TURNSTILE_SECRET_KEY) {
		return {
			ok: false,
			reason: "missing-secret",
			details: {
				success: false,
				"error-codes": ["missing-input-secret"],
			},
		};
	}

	if (!String(token || "").trim()) {
		return {
			ok: false,
			reason: "missing-response",
			details: {
				success: false,
				"error-codes": ["missing-input-response"],
			},
		};
	}

	const body = new URLSearchParams();
	body.set("secret", env.TURNSTILE_SECRET_KEY);
	body.set("response", token || "");
	if (ip) body.set("remoteip", ip);

	let response;
	try {
		response = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				body,
			}
		);
	} catch (error) {
		return {
			ok: false,
			reason: "network-error",
			details: {
				success: false,
				message: String(error),
			},
		};
	}

	if (!response.ok) {
		return {
			ok: false,
			reason: `http-${response.status}`,
			details: {
				success: false,
				status: response.status,
			},
		};
	}

	const result = await response.json().catch(() => null);
	if (!result) {
		return {
			ok: false,
			reason: "invalid-response",
			details: {
				success: false,
			},
		};
	}

	if (!result.success) {
		const codes = Array.isArray(result["error-codes"])
			? result["error-codes"]
			: [];
		return {
			ok: false,
			reason: String(codes[0] || "turnstile-failed"),
			details: result,
		};
	}

	return { ok: true, details: result };
}
