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
const MAX_BATCH_ITEMS = 20;

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

function isTerminalStage(stage) {
	return stage === "success" || stage === "failed" || stage === "canceled";
}

function chunkItems(items, chunkSize = MAX_BATCH_ITEMS) {
	const chunks = [];
	for (let index = 0; index < items.length; index += chunkSize) {
		chunks.push(items.slice(index, index + chunkSize));
	}
	return chunks;
}

function summarizeProgress() {
	const entries = Array.from(progressStore.values());
	const total = entries.length;
	const successCount = entries.filter(
		(item) => item.stage === "success"
	).length;
	const failedCount = entries.filter(
		(item) => item.stage === "failed"
	).length;
	const pendingCount = entries.filter(
		(item) => !isTerminalStage(item.stage)
	).length;
	return {
		total,
		successCount,
		failedCount,
		pendingCount,
	};
}

function forceSetPendingToFailed(message) {
	for (const entry of progressStore.values()) {
		if (isTerminalStage(entry.stage)) continue;
		upsertProgress(entry.clientFileId, {
			stage: "failed",
			message,
		});
	}
}

function setUploading(isUploading) {
	uploadButton.disabled = isUploading;
	uploadButton.textContent = isUploading ? "上传中..." : "批量上传";
}

let turnstileToken = "";
let turnstileWidgetId = null;
let turnstileSiteKey = "";
let activeBatchSession = null;

function resetTurnstileWidget() {
	turnstileToken = "";
	if (window.turnstile && turnstileWidgetId != null) {
		window.turnstile.reset(turnstileWidgetId);
	}
}

async function waitForTurnstileToken(timeoutMs = 120000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (turnstileToken) return turnstileToken;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return "";
}

async function getTurnstileTokenForBatch({ refresh = false } = {}) {
	if (refresh) {
		resetTurnstileWidget();
	}

	if (turnstileToken) {
		const token = turnstileToken;
		turnstileToken = "";
		return token;
	}

	turnstileStatus.textContent = "请完成人机验证以继续上传";
	const token = await waitForTurnstileToken();
	if (!token) {
		throw new Error("人机验证超时，请重新验证后重试");
	}
	turnstileStatus.textContent = "";
	turnstileToken = "";
	return token;
}

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
			batchSessionToken: turnstileToken,
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

async function createBatchUploadSession(batchId, token) {
	const response = await fetch("/api/upload-batch/session", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			batchId,
			turnstileToken: token,
		}),
	});
	return response.json();
}

function formatSessionErrorMessage(sessionPayload) {
	const code = String(sessionPayload?.error?.code || "");
	const baseMessage =
		sessionPayload?.error?.message || "创建批次验证会话失败";
	const details = sessionPayload?.error?.details;
	if (code !== "TURNSTILE_INVALID") {
		return baseMessage;
	}

	const errorCodes = Array.isArray(details?.["error-codes"])
		? details["error-codes"]
		: [];
	if (errorCodes.length) {
		return `${baseMessage} [${errorCodes.join(",")}]`;
	}

	if (typeof details === "string" && details) {
		return `${baseMessage} [${details}]`;
	}

	return baseMessage;
}

async function acquireBatchSessionToken(batchId, { refresh = false } = {}) {
	const attemptCreateSession = async (forceRefresh) => {
		const token = await getTurnstileTokenForBatch({
			refresh: forceRefresh,
		});
		return createBatchUploadSession(batchId, token);
	};

	let sessionPayload = await attemptCreateSession(refresh);
	const errorCode = String(sessionPayload?.error?.code || "");
	if (!sessionPayload?.ok && errorCode === "TURNSTILE_INVALID") {
		turnstileStatus.textContent = "人机验证已失效，正在重新验证...";
		sessionPayload = await attemptCreateSession(true);
	}

	if (!sessionPayload?.ok) {
		const message = formatSessionErrorMessage(sessionPayload);
		throw new Error(message);
	}

	activeBatchSession = {
		token: String(sessionPayload.data?.batchSessionToken || "").trim(),
		expiresAt: String(sessionPayload.data?.expiresAt || ""),
	};

	if (!activeBatchSession.token) {
		throw new Error("批次验证会话为空");
	}

	turnstileStatus.textContent = "";
	return activeBatchSession.token;
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

async function getImageDimensionsFromFile(file) {
	if (window.createImageBitmap) {
		try {
			const bitmap = await createImageBitmap(file);
			const width = Number(bitmap.width || 0);
			const height = Number(bitmap.height || 0);
			bitmap.close();
			if (width > 0 && height > 0) {
				return { width, height };
			}
		} catch {
			// ignore and fallback
		}
	}

	return new Promise((resolve) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			const width = Number(image.naturalWidth || 0);
			const height = Number(image.naturalHeight || 0);
			URL.revokeObjectURL(objectUrl);
			if (width > 0 && height > 0) {
				resolve({ width, height });
				return;
			}
			resolve({ width: null, height: null });
		};
		image.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			resolve({ width: null, height: null });
		};
		image.src = objectUrl;
	});
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

async function processUploadChunk(params) {
	const {
		chunk,
		chunkIndex,
		chunkCount,
		hashResultMap,
		uploaderNickname,
		batchId,
		batchSessionToken,
	} = params;

	const hitItems = [];
	const missItems = [];

	for (const item of chunk) {
		const result = hashResultMap.get(item.clientFileId);
		if (result?.exists && result?.objectId) {
			hitItems.push({
				...item,
				result,
			});
			upsertProgress(item.clientFileId, {
				stage: "instant-ready",
				message: `秒传命中（分片 ${chunkIndex}/${chunkCount}）`,
			});
			continue;
		}

		missItems.push(item);
		upsertProgress(item.clientFileId, {
			stage: "preparing",
			message: `申请上传地址（分片 ${chunkIndex}/${chunkCount}）`,
		});
	}

	let preparedItems = [];
	let rejectedByPrepare = [];
	let rotatedBatchSessionToken = batchSessionToken;
	if (missItems.length) {
		const preparePayload = await prepareBatchUpload(
			batchId,
			missItems,
			batchSessionToken
		);
		if (!preparePayload.ok) {
			const errorCode = String(preparePayload?.error?.code || "");
			const retryableSessionError =
				errorCode === "UPLOAD_BATCH_SESSION_EXPIRED" ||
				errorCode === "UPLOAD_BATCH_SESSION_INVALID" ||
				errorCode === "UPLOAD_BATCH_SESSION_MISSING";
			if (retryableSessionError) {
				return {
					ok: false,
					errorCode,
					retryableSessionError: true,
				};
			}
			for (const item of missItems) {
				upsertProgress(item.clientFileId, {
					stage: "failed",
					message:
						preparePayload?.error?.message || "申请上传地址失败",
				});
			}
			return {
				ok: false,
				errorCode,
				retryableSessionError: false,
			};
		}

		rotatedBatchSessionToken =
			String(preparePayload?.data?.nextBatchSessionToken || "").trim() ||
			batchSessionToken;

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
				message: `文件上传中（分片 ${chunkIndex}/${chunkCount}）`,
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
					message: `上传完成，写入记录（分片 ${chunkIndex}/${chunkCount}）`,
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
			width: item.width,
			height: item.height,
			uploaderNickname,
			originalFilename: item.file.name,
		});
		upsertProgress(item.clientFileId, {
			stage: "finalizing",
			message: `秒传命中，写入记录（分片 ${chunkIndex}/${chunkCount}）`,
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
			width: result.item.width,
			height: result.item.height,
			etag: result.etag,
			uploaderNickname,
			originalFilename: result.item.file.name,
		});
	}

	if (!completeItems.length) {
		return {
			ok: true,
			batchSessionToken: rotatedBatchSessionToken,
		};
	}

	const completePayload = await completeBatchUpload(batchId, completeItems);
	if (!completePayload.ok) {
		for (const item of completeItems) {
			upsertProgress(item.clientFileId, {
				stage: "failed",
				message: completePayload?.error?.message || "写入元数据失败",
			});
		}
		return {
			ok: false,
			errorCode: String(completePayload?.error?.code || ""),
			retryableSessionError: false,
		};
	}

	const completeResults = completePayload.data.results || [];
	const completedClientIds = new Set();
	for (const result of completeResults) {
		completedClientIds.add(result.clientFileId);
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

	for (const item of completeItems) {
		if (completedClientIds.has(item.clientFileId)) continue;
		upsertProgress(item.clientFileId, {
			stage: "failed",
			message: "结果缺失，已标记失败",
		});
	}

	return {
		ok: true,
		batchSessionToken: rotatedBatchSessionToken,
	};
}

uploadButton.addEventListener("click", async () => {
	const files = Array.from(fileInput.files || []);
	if (!files.length) {
		setSummary("请先选择至少一张图片", "error");
		return;
	}

	try {
		setUploading(true);
		activeBatchSession = null;
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
			const dimensions = await getImageDimensionsFromFile(current.file);
			current.width = dimensions.width;
			current.height = dimensions.height;
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

		setSummary("创建批次验证会话...", "pending");
		let batchSessionToken = await acquireBatchSessionToken(batchId, {
			refresh: false,
		});

		const chunks = chunkItems(batchItems, MAX_BATCH_ITEMS);
		for (let index = 0; index < chunks.length; index += 1) {
			const chunk = chunks[index];
			setSummary(
				`处理中：分片 ${index + 1}/${chunks.length}（${
					chunk.length
				} 项）`,
				"pending"
			);
			let chunkResult = await processUploadChunk({
				chunk,
				chunkIndex: index + 1,
				chunkCount: chunks.length,
				hashResultMap,
				uploaderNickname,
				batchId,
				batchSessionToken,
			});

			if (chunkResult?.retryableSessionError) {
				setSummary("批次验证已过期，正在重新验证...", "pending");
				batchSessionToken = await acquireBatchSessionToken(batchId, {
					refresh: true,
				});
				chunkResult = await processUploadChunk({
					chunk,
					chunkIndex: index + 1,
					chunkCount: chunks.length,
					hashResultMap,
					uploaderNickname,
					batchId,
					batchSessionToken,
				});
			}

			if (chunkResult?.batchSessionToken) {
				batchSessionToken = chunkResult.batchSessionToken;
			}

			if (!chunkResult?.ok && !chunkResult?.retryableSessionError) {
				continue;
			}
		}

		forceSetPendingToFailed("批次异常收敛：未完成项已标记失败");
		const summary = summarizeProgress();
		setSummary(
			`上传完成：成功 ${summary.successCount}，失败 ${summary.failedCount}`,
			summary.failedCount > 0 ? "error" : "success"
		);

		if (!uploaderNicknameInput.value.trim()) {
			uploaderNicknameInput.placeholder = `已使用默认昵称：${siteConfig.defaultUploaderNickname}`;
		}

		resetTurnstileWidget();
		turnstileStatus.textContent = "";
	} catch (error) {
		setSummary(`上传失败：${String(error)}`, "error");
	} finally {
		activeBatchSession = null;
		setUploading(false);
	}
});

applyTheme();

async function bootstrap() {
	await loadClientConfig();
	await setupTurnstile();
}

bootstrap();
