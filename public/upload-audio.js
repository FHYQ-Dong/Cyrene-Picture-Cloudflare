import { applyTheme, siteConfig } from "./site-config.js";

const fileInput = document.getElementById("fileInput");
const audioTitleInput = document.getElementById("audioTitle");
const uploaderNicknameInput = document.getElementById("uploaderNickname");
const tagSelect = document.getElementById("tagSelect");
const newTagInput = document.getElementById("newTagInput");
const addTagButton = document.getElementById("addTagButton");
const selectedTagsElement = document.getElementById("selectedTags");
const uploadButton = document.getElementById("uploadButton");
const uploadSummary = document.getElementById("uploadSummary");
const turnstileWidget = document.getElementById("turnstileWidget");
const turnstileStatus = document.getElementById("turnstileStatus");

const TAG_LIMIT = 10;
let turnstileToken = "";
let turnstileWidgetId = null;
let turnstileSiteKey = "";
let selectedTags = [];
let tagCustomSelect = null;

function closeAllCustomSelects(except = null) {
	document.querySelectorAll(".custom-select.is-open").forEach((node) => {
		if (except && node === except) return;
		node.classList.remove("is-open");
		const trigger = node.querySelector(".custom-select-trigger");
		if (trigger) trigger.setAttribute("aria-expanded", "false");
	});
}

function createCustomSelect(selectEl) {
	if (!selectEl) return null;

	const wrapper = document.createElement("div");
	wrapper.className = "custom-select";

	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "custom-select-trigger";
	trigger.setAttribute("aria-expanded", "false");
	trigger.setAttribute("aria-haspopup", "listbox");

	const list = document.createElement("div");
	list.className = "custom-select-list";
	list.setAttribute("role", "listbox");

	function setTriggerLabel() {
		const selected =
			selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
		trigger.textContent = selected?.textContent || "请选择";
	}

	function choose(value, emitChange = true) {
		if (selectEl.value !== value) {
			selectEl.value = value;
			if (emitChange) {
				selectEl.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}
		setTriggerLabel();
		closeAllCustomSelects();
	}

	function renderOptions() {
		list.innerHTML = "";
		const selectedValue = selectEl.value;

		for (const option of selectEl.options) {
			const optionButton = document.createElement("button");
			optionButton.type = "button";
			optionButton.className = "custom-select-option";
			optionButton.textContent = option.textContent;
			optionButton.dataset.value = option.value;
			optionButton.setAttribute("role", "option");
			optionButton.setAttribute(
				"aria-selected",
				option.value === selectedValue ? "true" : "false"
			);
			if (option.value === selectedValue) {
				optionButton.classList.add("is-selected");
			}
			optionButton.addEventListener("click", () => {
				choose(option.value, true);
				renderOptions();
			});
			list.appendChild(optionButton);
		}
		setTriggerLabel();
	}

	trigger.addEventListener("click", () => {
		const isOpen = wrapper.classList.contains("is-open");
		if (isOpen) {
			closeAllCustomSelects();
			return;
		}
		closeAllCustomSelects(wrapper);
		wrapper.classList.add("is-open");
		trigger.setAttribute("aria-expanded", "true");
	});

	selectEl.addEventListener("change", () => {
		renderOptions();
	});

	selectEl.classList.add("native-select-hidden");
	selectEl.insertAdjacentElement("afterend", wrapper);
	wrapper.appendChild(trigger);
	wrapper.appendChild(list);
	renderOptions();

	return {
		rebuild: renderOptions,
		setValue: (value) => choose(value, false),
	};
}

function normalizeTag(tag) {
	return String(tag || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, " ")
		.slice(0, 30);
}

function removeTag(tag) {
	selectedTags = selectedTags.filter((item) => item !== tag);
	renderSelectedTags();
}

function renderSelectedTags() {
	if (!selectedTagsElement) return;
	selectedTagsElement.innerHTML = "";
	for (const tag of selectedTags) {
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = "selected-tag-chip";
		chip.textContent = `#${tag}`;
		chip.addEventListener("click", () => removeTag(tag));
		selectedTagsElement.appendChild(chip);
	}
}

function addTag(tag) {
	const normalizedTag = normalizeTag(tag);
	if (!normalizedTag) return;
	if (selectedTags.includes(normalizedTag)) return;
	if (selectedTags.length >= TAG_LIMIT) return;
	selectedTags.push(normalizedTag);
	renderSelectedTags();
}

async function loadTags() {
	if (!tagSelect) return;
	const response = await fetch("/api/tags/list?limit=100&mediaType=audio", {
		method: "GET",
		headers: { accept: "application/json" },
	});
	const payload = await response.json().catch(() => null);
	if (!response.ok || !payload?.ok) return;

	const currentValue = tagSelect.value;
	tagSelect.innerHTML = "";
	const defaultOption = document.createElement("option");
	defaultOption.value = "";
	defaultOption.textContent = "从已有标签中选择";
	tagSelect.appendChild(defaultOption);

	for (const item of payload.data?.items || []) {
		const tag = normalizeTag(item.tag);
		if (!tag) continue;
		const option = document.createElement("option");
		option.value = tag;
		option.textContent = `#${tag} (${Number(item.count || 0)})`;
		tagSelect.appendChild(option);
	}

	tagSelect.value = currentValue || "";
	if (tagCustomSelect) {
		tagCustomSelect.rebuild();
	}
}

function bindTagSelectorEvents() {
	if (tagSelect) {
		tagSelect.addEventListener("change", () => {
			if (!tagSelect.value) return;
			addTag(tagSelect.value);
			tagSelect.value = "";
		});
	}

	if (addTagButton) {
		addTagButton.addEventListener("click", () => {
			addTag(newTagInput?.value || "");
			if (newTagInput) newTagInput.value = "";
		});
	}

	if (newTagInput) {
		newTagInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			event.preventDefault();
			addTag(newTagInput.value);
			newTagInput.value = "";
		});
	}
}

function setSummary(text, state = "pending") {
	uploadSummary.textContent = text;
	uploadSummary.classList.remove(
		"summary-pending",
		"summary-success",
		"summary-error"
	);
	uploadSummary.classList.add(`summary-${state}`);
}

function setUploading(isUploading) {
	uploadButton.disabled = isUploading;
	uploadButton.textContent = isUploading ? "上传中..." : "上传音频";
}

function getNicknameValue() {
	const raw = String(uploaderNicknameInput.value || "").trim();
	return raw || siteConfig.defaultUploaderNickname;
}

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
	if (!turnstileSiteKey || !turnstileWidget) {
		turnstileStatus.textContent = "未配置 Turnstile site key";
		return;
	}

	const turnstile = await waitForTurnstile();
	if (!turnstile) {
		turnstileStatus.textContent = "Turnstile 脚本加载失败";
		return;
	}

	turnstileWidgetId = turnstile.render("#turnstileWidget", {
		sitekey: turnstileSiteKey,
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

async function getAudioDurationFromFile(file) {
	return new Promise((resolve) => {
		const objectUrl = URL.createObjectURL(file);
		const audio = document.createElement("audio");
		audio.preload = "metadata";
		audio.onloadedmetadata = () => {
			const duration = Number(audio.duration || 0);
			URL.revokeObjectURL(objectUrl);
			resolve(
				Number.isFinite(duration) && duration > 0 ? duration : null
			);
		};
		audio.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(null);
		};
		audio.src = objectUrl;
	});
}

async function requestUploadUrl({
	file,
	turnstileTokenValue,
	uploaderNickname,
}) {
	const response = await fetch("/api/upload-url", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			filename: file.name,
			mime: file.type,
			size: file.size,
			uploaderNickname,
			turnstileToken: turnstileTokenValue,
		}),
	});
	return response.json();
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

async function completeUpload(payload) {
	const response = await fetch("/api/upload-complete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	return response.json();
}

async function handleUploadClick() {
	const file = fileInput.files?.[0];
	if (!file) {
		setSummary("请先选择一个音频文件", "error");
		return;
	}

	const audioTitle = String(audioTitleInput.value || "").trim();
	if (!audioTitle) {
		setSummary("音频标题不能为空", "error");
		return;
	}

	if (!file.type.startsWith("audio/")) {
		setSummary("请选择有效的音频文件", "error");
		return;
	}

	setUploading(true);
	setSummary("准备上传...", "pending");

	try {
		if (!turnstileToken) {
			turnstileStatus.textContent = "请完成人机验证以继续上传";
		}
		const token = await waitForTurnstileToken();
		if (!token) {
			throw new Error("人机验证超时，请重新验证");
		}
		turnstileToken = "";
		turnstileStatus.textContent = "";

		const uploaderNickname = getNicknameValue();
		const uploadUrlPayload = await requestUploadUrl({
			file,
			turnstileTokenValue: token,
			uploaderNickname,
		});
		if (!uploadUrlPayload?.ok) {
			throw new Error(
				uploadUrlPayload?.error?.message || "申请上传地址失败"
			);
		}

		setSummary("上传文件中...", "pending");
		const uploadData = uploadUrlPayload.data;
		const etag = await uploadFile(uploadData.uploadUrl, file, {
			...(uploadData.requiredHeaders || {}),
			"content-type": file.type,
		});

		const durationSeconds = await getAudioDurationFromFile(file);
		setSummary("写入元数据...", "pending");
		const completePayload = await completeUpload({
			objectKey: uploadData.objectKey,
			mime: file.type,
			size: file.size,
			uploadToken: uploadData.uploadToken || "",
			etag,
			uploaderNickname,
			mediaType: "audio",
			durationSeconds,
			audioTitle,
			tags: [...selectedTags],
		});
		if (!completePayload?.ok) {
			throw new Error(completePayload?.error?.message || "上传完成失败");
		}

		setSummary("上传成功，已发布到音频页", "success");
		fileInput.value = "";
		audioTitleInput.value = "";
		selectedTags = [];
		renderSelectedTags();
		resetTurnstileWidget();
	} catch (error) {
		setSummary(`上传失败：${String(error?.message || error)}`, "error");
	} finally {
		setUploading(false);
	}
}

uploadButton.addEventListener("click", () => {
	handleUploadClick();
});

applyTheme();
bindTagSelectorEvents();
tagCustomSelect = createCustomSelect(tagSelect);
loadTags().catch(() => null);
loadClientConfig().then(() => setupTurnstile());

document.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof Element)) return;
	if (!target.closest(".custom-select")) {
		closeAllCustomSelects();
	}
});
