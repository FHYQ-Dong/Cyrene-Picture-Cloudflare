import { jsonOk } from "../_shared/errors";

export async function onRequestGet() {
	return jsonOk({ status: "ok", ts: new Date().toISOString() });
}
