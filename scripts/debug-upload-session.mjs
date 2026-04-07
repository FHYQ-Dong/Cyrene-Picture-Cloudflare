import crypto from "node:crypto";

const baseUrl = String(
	process.env.DEBUG_BASE_URL || "https://cyrene-picture-cloudflare.pages.dev"
).replace(/\/$/, "");
const turnstileToken = String(process.env.TURNSTILE_TOKEN || "").trim();
const uploaderNickname = String(process.env.UPLOADER_NICKNAME || "ttt6").trim();
const batchId = `debug-${crypto.randomUUID()}`;
const chunkDelayMs = Math.max(Number(process.env.CHUNK_DELAY_MS || 0), 0);
const chunkCount = Math.max(Number(process.env.CHUNK_COUNT || 3), 1);
const chunkSize = Math.max(Number(process.env.CHUNK_SIZE || 20), 1);
const presetBatchSessionToken = String(
	process.env.BATCH_SESSION_TOKEN || ""
).trim();

async function requestJson(path, init) {
	const response = await fetch(`${baseUrl}${path}`, init);
	const payload = await response.json().catch(() => null);
	return {
		status: response.status,
		ok: response.ok,
		payload,
	};
}

function printStep(title, data) {
	console.log(`\n=== ${title} ===`);
	console.log(JSON.stringify(data, null, 2));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildChunkItems(index) {
	return Array.from({ length: chunkSize }, (_, offset) => ({
		clientFileId: `debug-${index + 1}-${offset + 1}`,
		filename: `debug-${index + 1}-${offset + 1}.png`,
		mime: "image/png",
		size: 123,
		uploaderNickname,
	}));
}

async function main() {
	console.log(`Base URL: ${baseUrl}`);
	console.log(`Uploader nickname: ${uploaderNickname}`);
	console.log(`Batch ID: ${batchId}`);
	console.log(
		`Chunk plan: ${chunkCount} chunks x ${chunkSize} items, delay ${chunkDelayMs}ms`
	);

	const configRes = await requestJson("/api/client-config", {
		method: "GET",
		headers: { accept: "application/json" },
	});
	printStep("client-config", configRes);

	let batchSessionToken = presetBatchSessionToken;
	if (!batchSessionToken) {
		if (!turnstileToken) {
			console.log(
				"\n未设置 TURNSTILE_TOKEN 或 BATCH_SESSION_TOKEN：已完成配置检查。若要继续调试 60 张分片链路，请提供其一。"
			);
			process.exit(0);
		}

		const sessionRes = await requestJson("/api/upload-batch/session", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "debug-upload-session-script",
			},
			body: JSON.stringify({
				batchId,
				turnstileToken,
			}),
		});
		printStep("upload-batch/session", sessionRes);

		batchSessionToken = String(
			sessionRes?.payload?.data?.batchSessionToken || ""
		).trim();
		if (!batchSessionToken) {
			console.log(
				"\n未拿到 batchSessionToken，停止。请根据上面的 error.details 排查。"
			);
			process.exit(1);
		}
	}

	for (let index = 0; index < chunkCount; index += 1) {
		const prepareRes = await requestJson("/api/upload-batch/prepare", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"user-agent": "debug-upload-session-script",
			},
			body: JSON.stringify({
				batchId,
				batchSessionToken,
				items: buildChunkItems(index),
			}),
		});

		printStep(`upload-batch/prepare chunk ${index + 1}`, prepareRes);
		if (!prepareRes.ok || !prepareRes?.payload?.ok) {
			console.log("\n分片调试中断：prepare 失败。");
			process.exit(1);
		}

		const rotatedToken = String(
			prepareRes?.payload?.data?.nextBatchSessionToken || ""
		).trim();
		if (rotatedToken) {
			batchSessionToken = rotatedToken;
		}

		if (chunkDelayMs > 0 && index < chunkCount - 1) {
			console.log(
				`\n等待 ${chunkDelayMs}ms，模拟分片上传耗时（chunk ${
					index + 1
				} -> ${index + 2}）...`
			);
			await sleep(chunkDelayMs);
		}
	}

	console.log("\n分片调试完成：所有 prepare 均成功。\n");
}

main().catch((error) => {
	console.error("debug-upload-session failed:", error);
	process.exit(1);
});
