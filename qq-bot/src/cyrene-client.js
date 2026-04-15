export async function getRandomImage(config, tag) {
	const params = new URLSearchParams();
	if (tag) params.set("tag", tag);
	const url = `${config.cyreneApiBaseUrl}/api/random-image?${params}`;

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		config.cyreneTimeoutMs
	);
	try {
		const response = await fetch(url, { signal: controller.signal });
		const json = await response.json().catch(() => null);
		if (!response.ok || !json?.ok) {
			return {
				ok: false,
				status: response.status,
				message: json?.error?.message || `request failed: ${response.status}`,
			};
		}
		return { ok: true, data: json.data };
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function listTags(config) {
	const url = `${config.cyreneApiBaseUrl}/api/tags/list?mediaType=image&limit=100`;
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		config.cyreneTimeoutMs
	);
	try {
		const response = await fetch(url, { signal: controller.signal });
		const json = await response.json().catch(() => null);
		if (!response.ok || !json?.ok) {
			return { ok: false, message: json?.error?.message || "request failed" };
		}
		return { ok: true, items: json.data.items || [] };
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function ingestImages(config, payload) {
	if (!config.cyreneBotIngestToken) {
		throw new Error("CYRENE_BOT_INGEST_TOKEN is required");
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		config.cyreneTimeoutMs
	);
	try {
		const response = await fetch(
			`${config.cyreneApiBaseUrl}/api/bot/ingest-images`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${config.cyreneBotIngestToken}`,
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			}
		);
		const json = await response.json().catch(() => null);
		if (!response.ok || !json?.ok) {
			const error = new Error(
				json?.error?.message || `ingest failed: ${response.status}`
			);
			error.status = response.status;
			error.payload = json;
			throw error;
		}
		return json.data;
	} finally {
		clearTimeout(timeoutId);
	}
}
