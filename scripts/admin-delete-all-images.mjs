import fs from "node:fs";

const baseUrl = (
	process.env.DEBUG_BASE_URL || "https://cyrene.fhyq.cloud"
).replace(/\/$/, "");
const listPageLimit = 100;
const uploaderPageLimit = 500;
const bulkDeletePath =
	process.env.ADMIN_BULK_DELETE_PATH || "/api/admin/delete-images";

function readAdminTokenFromDevVars(filePath) {
	const content = fs.readFileSync(filePath, "utf8");
	const match = content.match(/^\s*ADMIN_API_TOKEN\s*=\s*"(.*)"\s*$/m);
	return match?.[1]?.trim() || "";
}

async function requestJson(path, init = {}) {
	const response = await fetch(`${baseUrl}${path}`, init);
	const payload = await response.json().catch(() => null);
	return {
		status: response.status,
		ok: response.ok,
		payload,
	};
}

async function collectAllImageIds() {
	const allIds = [];
	let cursor = "";

	for (;;) {
		const params = new URLSearchParams({
			limit: String(listPageLimit),
			groupBy: "none",
			mediaType: "image",
		});
		if (cursor) {
			params.set("cursor", cursor);
		}

		const result = await requestJson(`/api/list?${params.toString()}`);
		if (!result.ok || !result.payload?.ok) {
			throw new Error(
				`list failed: status=${result.status}, cursor=${
					cursor || "<start>"
				}`
			);
		}

		const items = Array.isArray(result.payload?.data?.items)
			? result.payload.data.items
			: [];
		for (const item of items) {
			if (item?.image_id) {
				allIds.push(String(item.image_id));
			}
		}

		const nextCursor = String(result.payload?.data?.nextCursor || "");
		if (!nextCursor) {
			break;
		}
		cursor = nextCursor;
	}

	return Array.from(new Set(allIds));
}

async function collectAllUploaders() {
	const allUploaders = [];
	let cursor = "";

	for (;;) {
		const params = new URLSearchParams({
			limit: String(uploaderPageLimit),
		});
		if (cursor) {
			params.set("cursor", cursor);
		}

		const result = await requestJson(`/api/uploaders?${params.toString()}`);
		if (!result.ok || !result.payload?.ok) {
			throw new Error(
				`uploaders list failed: status=${result.status}, cursor=${
					cursor || "<start>"
				}`
			);
		}

		const items = Array.isArray(result.payload?.data?.items)
			? result.payload.data.items
			: [];
		for (const item of items) {
			const nickname = String(item?.nickname || "").trim();
			if (nickname) {
				allUploaders.push(nickname);
			}
		}

		const nextCursor = String(result.payload?.data?.nextCursor || "");
		if (!nextCursor) {
			break;
		}
		cursor = nextCursor;
	}

	return Array.from(new Set(allUploaders));
}

async function deleteByUploaderBulk(token, uploaders) {
	const results = [];

	for (let index = 0; index < uploaders.length; index += 1) {
		const uploader = uploaders[index];
		const result = await requestJson(bulkDeletePath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				uploader,
				dryRun: false,
				continueOnError: true,
				reason: "admin bulk cleanup all images by uploader",
			}),
		});

		if (!result.ok || !result.payload?.ok) {
			const message =
				result.payload?.error?.message ||
				`bulk delete failed: status=${result.status}, uploader=${uploader}`;
			throw new Error(message);
		}

		results.push({
			uploader,
			status: result.status,
			payload: result.payload?.data || null,
		});

		process.stdout.write(
			`\rBulk delete by uploader: ${index + 1}/${uploaders.length}`
		);
	}

	process.stdout.write("\n");
	return results;
}

async function countRemainingImages() {
	const params = new URLSearchParams({
		limit: "1",
		groupBy: "none",
		mediaType: "image",
	});
	const result = await requestJson(`/api/list?${params.toString()}`);
	if (!result.ok || !result.payload?.ok) {
		return -1;
	}
	const items = Array.isArray(result.payload?.data?.items)
		? result.payload.data.items
		: [];
	return items.length;
}

async function main() {
	const token = readAdminTokenFromDevVars(".dev.vars");
	if (!token) {
		throw new Error("未在 .dev.vars 中读取到 ADMIN_API_TOKEN");
	}

	const uploaders = await collectAllUploaders();
	const ids = await collectAllImageIds();
	console.log(
		JSON.stringify(
			{
				phase: "collect",
				baseUrl,
				bulkDeletePath,
				uploaderCount: uploaders.length,
				requested: ids.length,
			},
			null,
			2
		)
	);

	if (!ids.length) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					requested: 0,
					deleted: 0,
					failed: 0,
					skipped: 0,
					remainingImagesSampleCount: await countRemainingImages(),
				},
				null,
				2
			)
		);
		return;
	}

	if (!uploaders.length) {
		throw new Error("未获取到 uploader 列表，无法按 uploader 批量删除");
	}

	const bulkResults = await deleteByUploaderBulk(token, uploaders);
	const totalSoftDeleted = bulkResults.reduce((sum, item) => {
		const value = Number(item?.payload?.result?.total_soft_deleted || 0);
		return sum + (Number.isFinite(value) ? value : 0);
	}, 0);
	const totalRefDecremented = bulkResults.reduce((sum, item) => {
		const value = Number(item?.payload?.result?.total_ref_decremented || 0);
		return sum + (Number.isFinite(value) ? value : 0);
	}, 0);

	console.log(
		JSON.stringify(
			{
				ok: true,
				requested: ids.length,
				bulkUploaderCalls: bulkResults.length,
				totalSoftDeleted,
				totalRefDecremented,
				remainingImagesSampleCount: await countRemainingImages(),
			},
			null,
			2
		)
	);
}

main().catch((error) => {
	console.error(
		JSON.stringify(
			{
				ok: false,
				message: String(error?.message || error),
			},
			null,
			2
		)
	);
	process.exit(1);
});
