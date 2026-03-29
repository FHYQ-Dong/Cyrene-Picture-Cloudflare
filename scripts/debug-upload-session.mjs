import crypto from "node:crypto";

const baseUrl = String(
	process.env.DEBUG_BASE_URL || "https://cyrene-picture-cloudflare.pages.dev"
).replace(/\/$/, "");
const turnstileToken = String(process.env.TURNSTILE_TOKEN || "").trim();
const uploaderNickname = String(process.env.UPLOADER_NICKNAME || "ttt4").trim();
const batchId = `debug-${crypto.randomUUID()}`;

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

async function main() {
	console.log(`Base URL: ${baseUrl}`);
	console.log(`Uploader nickname: ${uploaderNickname}`);
	console.log(`Batch ID: ${batchId}`);

	const configRes = await requestJson("/api/client-config", {
		method: "GET",
		headers: { accept: "application/json" },
	});
	printStep("client-config", configRes);

	if (!turnstileToken) {
		console.log(
			"\nTURNSTILE_TOKEN 未设置：已完成配置检查。若要继续调试 session，请从浏览器 Turnstile 回调拿到 token 后重试。"
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

	const batchSessionToken = String(
		sessionRes?.payload?.data?.batchSessionToken || ""
	).trim();
	if (!batchSessionToken) {
		console.log(
			"\n未拿到 batchSessionToken，停止。请根据上面的 error.details 排查。"
		);
		process.exit(1);
	}

	const prepareRes = await requestJson("/api/upload-batch/prepare", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"user-agent": "debug-upload-session-script",
		},
		body: JSON.stringify({
			batchId,
			batchSessionToken,
			items: [
				{
					clientFileId: "debug-1",
					filename: "debug.png",
					mime: "image/png",
					size: 123,
					uploaderNickname,
				},
			],
		}),
	});
	printStep("upload-batch/prepare", prepareRes);
}

main().catch((error) => {
	console.error("debug-upload-session failed:", error);
	process.exit(1);
});
