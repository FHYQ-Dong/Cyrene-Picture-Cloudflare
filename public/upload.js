import { applyTheme, siteConfig } from "./site-config.js";

const fileInput = document.getElementById("fileInput");
const uploaderNicknameInput = document.getElementById("uploaderNickname");
const turnstileWidget = document.getElementById("turnstileWidget");
const turnstileStatus = document.getElementById("turnstileStatus");
const uploadButton = document.getElementById("uploadButton");
const uploadSummary = document.getElementById("uploadSummary");
const progressList = document.getElementById("progressList");
const progressStats = document.getElementById("progressStats");

const STAGE_META = {
	pending: { label: "等待中", percent: 0 },
	"hash-checking": { label: "计算哈希", percent: 8 },
	"instant-ready": { label: "秒传命中", percent: 35 },
	preparing: { label: "申请上传", percent: 48 },
	uploading: { label: "上传中", percent: 78 },
	finalizing: { label: "写入元数据", percent: 92 },
	success: { label: "上传成功", percent: 100 },
	failed: { label: "上传失败", percent: 100 },
	canceled: { label: "已取消", percent: 100 },
};

const progressStore = new Map();
const progressElementStore = new Map();

function setSummary(text, state = "pending") {
	uploadSummary.textContent = text;
	uploadSummary.classList.remove(
		"summary-pending",
		"summary-success",
		"summary-error"
	);
	uploadSummary.classList.add(`summary-${state}`);
}

function stageToLabel(stage) {
	return STAGE_META[stage]?.label || "处理中";
}

function stageToPercent(stage) {
	return STAGE_META[stage]?.percent ?? 0;
}

function clearProgressItems() {
	progressStore.clear();
	progressElementStore.clear();
	progressList.innerHTML = "";
	progressStats.textContent = "0/0";
}

function createProgressElement(entry) {
	const item = document.createElement("article");
	item.className = "progress-item";

	const header = document.createElement("div");
	header.className = "progress-item-header";

	const fileName = document.createElement("strong");
	fileName.className = "progress-file-name";
	fileName.textContent = entry.fileName;

	const stage = document.createElement("span");
	stage.className = "progress-stage";

	header.appendChild(fileName);
	header.appendChild(stage);

	const barTrack = document.createElement("div");
	barTrack.className = "progress-bar-track";
	const barFill = document.createElement("div");
	barFill.className = "progress-bar-fill";
	barTrack.appendChild(barFill);

	const footer = document.createElement("div");
	footer.className = "progress-item-footer";

	const message = document.createElement("span");
	message.className = "progress-message";

	const percent = document.createElement("span");
	percent.className = "progress-percent";

	footer.appendChild(message);
	footer.appendChild(percent);

	item.appendChild(header);
	item.appendChild(barTrack);
	item.appendChild(footer);

	return { item, stage, barFill, message, percent };
}

function renderProgressEntry(entry) {
	let elements = progressElementStore.get(entry.clientFileId);
	if (!elements) {
		elements = createProgressElement(entry);
		progressElementStore.set(entry.clientFileId, elements);
		progressList.appendChild(elements.item);
	}

	elements.stage.textContent = stageToLabel(entry.stage);
	elements.percent.textContent = `${entry.percent}%`;
	elements.message.textContent = entry.message || "";
	elements.barFill.style.width = `${entry.percent}%`;
	elements.item.classList.remove(
		"progress-state-pending",
		"progress-state-success",
		"progress-state-failed"
	);
	if (entry.stage === "success") {
		elements.item.classList.add("progress-state-success");
	} else if (entry.stage === "failed") {
		elements.item.classList.add("progress-state-failed");
	} else {
		elements.item.classList.add("progress-state-pending");
	}
}

function refreshProgressStats() {
	const entries = Array.from(progressStore.values());
	const total = entries.length;
	if (!total) {
		progressStats.textContent = "0/0";
		return;
	}

	const success = entries.filter((item) => item.stage === "success").length;
	const failed = entries.filter((item) => item.stage === "failed").length;
	const finished = success + failed;
	progressStats.textContent = `${finished}/${total} · 成功 ${success} · 失败 ${failed}`;
}

function upsertProgress(clientFileId, patch) {
	const current = progressStore.get(clientFileId);
	if (!current) return;

	const nextStage = patch.stage || current.stage;
	const nextPercent =
		typeof patch.percent === "number"
			? patch.percent
			: Math.max(current.percent, stageToPercent(nextStage));

	const next = {
		...current,
		...patch,
		stage: nextStage,
		percent: Math.max(current.percent, nextPercent),
	};

	progressStore.set(clientFileId, next);
	renderProgressEntry(next);
	refreshProgressStats();
}

function initProgressItems(items) {
	clearProgressItems();
	for (const item of items) {
		const entry = {
			clientFileId: item.clientFileId,
			fileName: item.file.name,
			stage: "pending",
			percent: 0,
			message: "等待处理",
		};
		progressStore.set(item.clientFileId, entry);
		renderProgressEntry(entry);
	}
	refreshProgressStats();
}

function setUploading(isUploading) {
	uploadButton.disabled = isUploading;
	uploadButton.textContent = isUploading ? "上传中..." : "批量上传";
}

let turnstileToken = "";
let turnstileWidgetId = null;
let turnstileSiteKey = "";

async function loadClientConfig() {
	try {
		const response = await fetch("/api/client-config", {
			method: "GET",
			headers: { accept: "application/json" },
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok || !payload?.ok) {
			turnstileStatus.textContent = "读取 Turnstile 配置失败";
			return;
		}
		turnstileSiteKey = String(payload.data?.turnstileSiteKey || "").trim();
	} catch {
		turnstileStatus.textContent = "读取 Turnstile 配置失败";
	}
}

async function waitForTurnstile(timeoutMs = 8000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (window.turnstile) return window.turnstile;
		await new Promise((resolve) => setTimeout(resolve, 80));
	}
	return null;
}

async function setupTurnstile() {
	const siteKey = turnstileSiteKey;
	if (!siteKey || !turnstileWidget) {
		turnstileStatus.textContent = "未配置 Turnstile site key";
		return;
	}

	const turnstile = await waitForTurnstile();
	if (!turnstile) {
		turnstileStatus.textContent = "Turnstile 脚本加载失败";
		return;
	}

	turnstileWidgetId = turnstile.render("#turnstileWidget", {
		sitekey: siteKey,
		callback: (token) => {
			turnstileToken = token || "";
			turnstileStatus.textContent = turnstileToken
				? ""
				: "人机验证未完成";
		},
		"expired-callback": () => {
			turnstileToken = "";
			turnstileStatus.textContent = "验证已过期，请重新验证";
		},
		"error-callback": () => {
			turnstileToken = "";
			turnstileStatus.textContent = "验证失败，请重试";
		},
	});

	turnstileStatus.textContent = "";
}

function getNicknameValue() {
	const raw = String(uploaderNicknameInput.value || "").trim();
	return raw || siteConfig.defaultUploaderNickname;
}

async function checkUploadHashes(items) {
	const response = await fetch("/api/upload-hash/check", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			items: items.map((item) => ({
				clientFileId: item.clientFileId,
				fileName: item.file.name,
				mime: item.file.type,
				size: item.file.size,
				contentHash: item.contentHash,
				uploaderNickname: item.uploaderNickname,
				batchId: item.batchId,
			})),
		}),
	});
	return response.json();
}

async function prepareBatchUpload(batchId, items, turnstileToken) {
	const response = await fetch("/api/upload-batch/prepare", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batchId,
			turnstileToken,
			items: items.map((item) => ({
				clientFileId: item.clientFileId,
				filename: item.file.name,
				mime: item.file.type,
				size: item.file.size,
				uploaderNickname: item.uploaderNickname,
			})),
		}),
	});
	return response.json();
}

async function completeBatchUpload(batchId, items) {
	const response = await fetch("/api/upload-batch/complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batchId,
			items,
		}),
	});
	return response.json();
}

async function computeFileHash(file) {
	const buffer = await file.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const hex = [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

async function uploadFile(uploadUrl, file, requiredHeaders) {
	let response;
	try {
		response = await fetch(uploadUrl, {
			method: "PUT",
			headers: requiredHeaders,
			body: file,
		});
	} catch (_error) {
		throw new Error("上传失败：网络或跨域限制");
	}
	if (!response.ok) {
		throw new Error(`上传失败: ${response.status}`);
	}
	return response.headers.get("etag") || "";
}

async function runWithConcurrency(tasks, limit = 2) {
	const results = new Array(tasks.length);
	let cursor = 0;

	async function worker() {
		while (cursor < tasks.length) {
			const current = cursor;
			cursor += 1;
			results[current] = await tasks[current]();
		}
	}

	const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
		worker()
	);
	await Promise.all(workers);
	return results;
}

uploadButton.addEventListener("click", async () => {
	const files = Array.from(fileInput.files || []);
	if (!files.length) {
		setSummary("请先选择至少一张图片", "error");
		return;
	}

	if (!turnstileToken) {
		setSummary("请先完成人机验证", "error");
		return;
	}

	try {
		setUploading(true);
		const batchId = crypto.randomUUID();
		const uploaderNickname = getNicknameValue();
		setSummary(`开始处理 ${files.length} 个文件...`, "pending");

		const batchItems = [];
		for (let index = 0; index < files.length; index += 1) {
			const file = files[index];
			batchItems.push({
				clientFileId: crypto.randomUUID(),
				file,
				contentHash: "",
				uploaderNickname,
				batchId,
			});
		}

		initProgressItems(batchItems);

		for (let index = 0; index < batchItems.length; index += 1) {
			const current = batchItems[index];
			upsertProgress(current.clientFileId, {
				stage: "hash-checking",
				message: `计算哈希中（${index + 1}/${batchItems.length}）`,
			});
			current.contentHash = await computeFileHash(current.file);
		}

		setSummary("执行哈希预检...", "pending");
		const hashCheckPayload = await checkUploadHashes(batchItems);
		if (!hashCheckPayload.ok) {
			for (const item of batchItems) {
				upsertProgress(item.clientFileId, {
					stage: "failed",
					message: "哈希预检失败",
				});
			}
			setSummary("哈希预检失败，请稍后重试", "error");
			return;
		}

		const hashResultMap = new Map(
			(hashCheckPayload.data.results || []).map((item) => [
				item.clientFileId,
				item,
			])
		);

		const hitItems = [];
		const missItems = [];
		for (const item of batchItems) {
			const result = hashResultMap.get(item.clientFileId);
			if (result?.exists && result?.objectId) {
				hitItems.push({
					...item,
					result,
				});
				upsertProgress(item.clientFileId, {
					stage: "instant-ready",
					message: "秒传命中，等待写入",
				});
			} else {
				missItems.push(item);
				upsertProgress(item.clientFileId, {
					stage: "preparing",
					message: "申请上传地址",
				});
			}
		}

		let preparedItems = [];
		let rejectedByPrepare = [];
		if (missItems.length) {
			setSummary("申请批量上传地址...", "pending");
			const preparePayload = await prepareBatchUpload(
				batchId,
				missItems,
				turnstileToken
			);
			if (!preparePayload.ok) {
				for (const item of missItems) {
					upsertProgress(item.clientFileId, {
						stage: "failed",
						message: "申请上传地址失败",
					});
				}
				setSummary("申请上传地址失败，请稍后重试", "error");
				return;
			}
			preparedItems = preparePayload.data.items || [];
			rejectedByPrepare = preparePayload.data.rejectedItems || [];

			for (const rejected of rejectedByPrepare) {
				upsertProgress(rejected.clientFileId, {
					stage: "failed",
					message: rejected.message || "上传准备被拒绝",
				});
			}
		}

		const preparedMap = new Map(
			preparedItems.map((item) => [item.clientFileId, item])
		);
		const uploadTasks = missItems
			.filter((item) => preparedMap.has(item.clientFileId))
			.map((item) => async () => {
				const prepared = preparedMap.get(item.clientFileId);
				upsertProgress(item.clientFileId, {
					stage: "uploading",
					message: "文件上传中",
				});
				try {
					const etag = await uploadFile(
						prepared.uploadUrl,
						item.file,
						prepared.requiredHeaders || {
							"content-type": item.file.type,
						}
					);
					upsertProgress(item.clientFileId, {
						stage: "finalizing",
						message: "上传完成，写入记录",
					});
					return {
						clientFileId: item.clientFileId,
						ok: true,
						etag,
						prepared,
						item,
					};
				} catch (error) {
					upsertProgress(item.clientFileId, {
						stage: "failed",
						message: String(error),
					});
					return {
						clientFileId: item.clientFileId,
						ok: false,
						error: String(error),
					};
				}
			});

		if (uploadTasks.length) {
			setSummary("上传未命中的文件...", "pending");
		}
		const uploadResults = await runWithConcurrency(uploadTasks, 2);

		const completeItems = [];
		for (const item of hitItems) {
			completeItems.push({
				clientFileId: item.clientFileId,
				dedupHit: true,
				dedupObjectId: item.result.objectId,
				contentHash: item.contentHash,
				mime: item.file.type,
				size: item.file.size,
				uploaderNickname,
				originalFilename: item.file.name,
			});
		}

		for (const result of uploadResults) {
			if (!result?.ok) continue;
			completeItems.push({
				clientFileId: result.clientFileId,
				dedupHit: false,
				contentHash: result.item.contentHash,
				uploadToken: result.prepared.uploadToken,
				objectKey: result.prepared.objectKey,
				mime: result.item.file.type,
				size: result.item.file.size,
				etag: result.etag,
				uploaderNickname,
				originalFilename: result.item.file.name,
			});
		}

		for (const item of hitItems) {
			upsertProgress(item.clientFileId, {
				stage: "finalizing",
				message: "秒传命中，写入记录",
			});
		}

		let successCount = 0;
		let failedCount = rejectedByPrepare.length;
		const failedUploads = uploadResults.filter((item) => !item.ok);

		if (completeItems.length) {
			setSummary("批量写入元数据...", "pending");
			const completePayload = await completeBatchUpload(
				batchId,
				completeItems
			);
			if (!completePayload.ok) {
				for (const item of completeItems) {
					upsertProgress(item.clientFileId, {
						stage: "failed",
						message: "写入元数据失败",
					});
				}
				setSummary("写入元数据失败，请稍后重试", "error");
				return;
			}

			const completeResults = completePayload.data.results || [];
			for (const result of completeResults) {
				if (result.ok) {
					upsertProgress(result.clientFileId, {
						stage: "success",
						message: result.dedup_hit ? "秒传完成" : "上传完成",
					});
					continue;
				}
				upsertProgress(result.clientFileId, {
					stage: "failed",
					message: result.message || result.errorCode || "处理失败",
				});
			}

			successCount = completePayload.data.successCount || 0;
			failedCount += completePayload.data.failedCount || 0;
		}

		failedCount += failedUploads.length;
		setSummary(
			`上传完成：成功 ${successCount}，失败 ${failedCount}，秒传命中 ${hitItems.length}`,
			failedCount ? "error" : "success"
		);

		if (!uploaderNicknameInput.value.trim()) {
			uploaderNicknameInput.placeholder = `已使用默认昵称：${siteConfig.defaultUploaderNickname}`;
		}

		turnstileToken = "";
		if (window.turnstile && turnstileWidgetId != null) {
			window.turnstile.reset(turnstileWidgetId);
			turnstileStatus.textContent = "";
		}
	} catch (error) {
		setSummary(`上传失败：${String(error)}`, "error");
	} finally {
		setUploading(false);
	}
});

applyTheme();

async function bootstrap() {
	await loadClientConfig();
	await setupTurnstile();
}

bootstrap();
