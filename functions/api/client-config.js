import { jsonOk } from "../_shared/errors";

export async function onRequestGet(context) {
	const { env } = context;
	const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || "").trim();

	return jsonOk(
		{
			turnstileSiteKey,
		},
		{
			headers: {
				"cache-control": "no-store",
			},
		}
	);
}
