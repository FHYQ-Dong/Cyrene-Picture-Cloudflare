export async function verifyTurnstile(env, token, ip) {
	if (!env.TURNSTILE_SECRET_KEY) {
		return { ok: false, reason: "missing-secret" };
	}

	const body = new URLSearchParams();
	body.set("secret", env.TURNSTILE_SECRET_KEY);
	body.set("response", token || "");
	if (ip) body.set("remoteip", ip);

	const response = await fetch(
		"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		{
			method: "POST",
			body,
		}
	);

	if (!response.ok) {
		return { ok: false, reason: `http-${response.status}` };
	}

	const result = await response.json();
	return { ok: Boolean(result.success), details: result };
}
