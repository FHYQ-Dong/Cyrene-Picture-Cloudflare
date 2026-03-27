export async function onRequest() {
	return new Response("not found", {
		status: 404,
		headers: { "cache-control": "no-store" },
	});
}
