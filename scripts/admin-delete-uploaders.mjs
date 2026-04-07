import fs from "node:fs";

const baseUrl = (
	process.env.DEBUG_BASE_URL || "https://cyrene-picture-cloudflare.pages.dev"
).replace(/\/$/, "");
const targetUploaders = ["test", "ttt", "ttt1", "ttt2", "ttt5", "ttt7"];

function readAdminTokenFromDevVars(filePath) {
	const content = fs.readFileSync(filePath, "utf8");
	const match = content.match(/^\s*ADMIN_API_TOKEN\s*=\s*"(.*)"\s*$/m);
	return match?.[1]?.trim() || "";
}

async function requestJson(path, init = {}) {
	const response = await fetch(`${baseUrl}${path}`, init);
	const payload = await response.json().catch(() => null);
	return { status: response.status, ok: response.ok, payload };
}

async function collectUploaderImageIds(uploader) {
	const ids = [];
	let cursor = "";
	for (;;) {
		const params = new URLSearchParams({
			limit: "100",
			groupBy: "none",
			uploader,
		});
		if (cursor) params.set("cursor", cursor);

		const result = await requestJson(`/api/list?${params.toString()}`);
		if (!result.ok || !result.payload?.ok) {
			throw new Error(`list failed for uploader=${uploader}`);
		}

		for (const item of result.payload.data?.items || []) {
			if (item?.image_id) ids.push(String(item.image_id));
		}

		const nextCursor = String(result.payload.data?.nextCursor || "");
		if (!nextCursor) break;
		cursor = nextCursor;
	}
	return ids;
}

async function main() {
	const token = readAdminTokenFromDevVars(".dev.vars");
	if (!token) {
		throw new Error("未在 .dev.vars 中读取到 ADMIN_API_TOKEN");
	}

	const collected = [];
	for (const uploader of targetUploaders) {
		const ids = await collectUploaderImageIds(uploader);
		collected.push(...ids);
	}

	const uniqueIds = Array.from(new Set(collected));
	console.log(
		JSON.stringify(
			{ phase: "collect", requested: uniqueIds.length },
			null,
			2
		)
	);

	if (!uniqueIds.length) {
		console.log(
			JSON.stringify(
				{ ok: true, requested: 0, deleted: 0, failed: 0, skipped: 0 },
				null,
				2
			)
		);
		return;
	}

	const batchSize = 50;
	const allItems = [];
	for (let index = 0; index < uniqueIds.length; index += batchSize) {
		const batch = uniqueIds.slice(index, index + batchSize);
		const result = await requestJson("/api/admin/delete-images", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				imageIds: batch,
				dryRun: false,
				continueOnError: true,
				reason: "cleanup specified uploaders",
			}),
		});

		if (!result.ok || !result.payload?.ok) {
			throw new Error(`delete batch failed at offset=${index}`);
		}

		allItems.push(...(result.payload.data?.items || []));
	}

	const deleted = allItems.filter(
		(item) => item.result === "deleted" || item.result === "would_delete"
	).length;
	const failed = allItems.filter((item) => item.result === "failed").length;
	const skipped = allItems.filter((item) => item.result === "skipped").length;

	const remaining = {};
	for (const uploader of targetUploaders) {
		const params = new URLSearchParams({
			limit: "1",
			groupBy: "none",
			uploader,
		});
		const result = await requestJson(`/api/list?${params.toString()}`);
		remaining[uploader] = Array.isArray(result.payload?.data?.items)
			? result.payload.data.items.length
			: -1;
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				requested: uniqueIds.length,
				deleted,
				failed,
				skipped,
				remaining,
			},
			null,
			2
		)
	);
}

main().catch((error) => {
	console.error(
		JSON.stringify(
			{ ok: false, message: String(error?.message || error) },
			null,
			2
		)
	);
	process.exit(1);
});
