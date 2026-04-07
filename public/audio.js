import { applyTheme } from "./site-config.js";

const groupBySelect = document.getElementById("groupBySelect");
const uploaderFilter = document.getElementById("uploaderFilter");
const tagFilter = document.getElementById("tagFilter");
const refreshButton = document.getElementById("refreshButton");
const loadMoreButton = document.getElementById("loadMoreButton");
const groupContainer = document.getElementById("groupContainer");

let nextCursor = null;
let isLoading = false;
let groupByCustomSelect = null;
let uploaderCustomSelect = null;
let tagCustomSelect = null;
let uploadersLoaded = false;
let tagsLoaded = false;

function parseAsUtcDate(dateText) {
	const raw = String(dateText || "").trim();
	if (!raw) return null;

	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
		const parsed = new Date(`${raw}T00:00:00Z`);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}$/.test(raw)) {
		const parsed = new Date(raw.replace(" ", "T") + "Z");
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) {
		const parsed = new Date(`${raw}Z`);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}

	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateGmt8(dateText) {
	const parsed = parseAsUtcDate(dateText);
	if (!parsed) return "未知日期";
	const gmt8 = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
	return gmt8.toISOString().slice(0, 10);
}

function formatDuration(seconds) {
	const value = Number(seconds || 0);
	if (!Number.isFinite(value) || value <= 0) return "未知时长";
	const total = Math.round(value);
	const mm = Math.floor(total / 60);
	const ss = total % 60;
	return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

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

function groupTitle(groupBy, groupKey) {
	if (groupBy === "uploader") return `上传者：${groupKey}`;
	if (groupBy === "date") return `上传日期：${formatDateGmt8(groupKey)}`;
	return "音频";
}

function createAudioCard(item) {
	const card = document.createElement("article");
	card.className = "audio-card";

	const title = document.createElement("h4");
	title.className = "audio-title";
	title.textContent = item.audio_title || "未命名音频";

	const meta = document.createElement("div");
	meta.className = "audio-meta";
	meta.textContent = `${item.uploader_nickname || "093"} · ${formatDateGmt8(
		item.created_at
	)} · ${formatDuration(item.duration_seconds)}`;

	const player = document.createElement("audio");
	player.controls = true;
	player.preload = "none";
	player.src = item.public_url;

	const tagsWrap = document.createElement("div");
	tagsWrap.className = "image-tags";
	for (const tag of item.tags || []) {
		const tagButton = document.createElement("button");
		tagButton.type = "button";
		tagButton.className = "image-tag-chip";
		tagButton.dataset.tag = tag;
		tagButton.textContent = `#${tag}`;
		tagsWrap.appendChild(tagButton);
	}

	card.appendChild(title);
	card.appendChild(meta);
	card.appendChild(player);
	card.appendChild(tagsWrap);
	return card;
}

function appendGroups(payload, append = false) {
	if (!append) {
		groupContainer.innerHTML = "";
	}

	const itemsById = new Map();
	for (const item of payload.items || []) {
		itemsById.set(item.image_id, item);
	}

	const groups = payload.groups?.length
		? payload.groups
		: [
				{
					groupKey: "全部",
					imageIds: (payload.items || []).map((x) => x.image_id),
				},
		  ];

	for (const group of groups) {
		const section = document.createElement("section");
		section.className = "group-section";

		const heading = document.createElement("h3");
		heading.className = "group-title";
		heading.textContent = groupTitle(payload.groupBy, group.groupKey);

		const list = document.createElement("div");
		list.className = "audio-list";
		for (const imageId of group.imageIds || []) {
			const item = itemsById.get(imageId);
			if (!item) continue;
			list.appendChild(createAudioCard(item));
		}

		section.appendChild(heading);
		section.appendChild(list);
		groupContainer.appendChild(section);
	}
}

function setUploaderFilterOptions(items) {
	const previousValue = uploaderFilter.value;
	uploaderFilter.innerHTML = "";

	const defaultOption = document.createElement("option");
	defaultOption.value = "";
	defaultOption.textContent = "全部上传者";
	uploaderFilter.appendChild(defaultOption);

	const unique = Array.from(
		new Set(
			(items || [])
				.map((item) => String(item || "").trim())
				.filter(Boolean)
		)
	).sort((left, right) => left.localeCompare(right, "zh-CN"));

	for (const nickname of unique) {
		const option = document.createElement("option");
		option.value = nickname;
		option.textContent = nickname;
		uploaderFilter.appendChild(option);
	}

	const hasPrevious = unique.includes(previousValue);
	uploaderFilter.value = hasPrevious ? previousValue : "";

	if (uploaderCustomSelect) {
		uploaderCustomSelect.rebuild();
	}
}

async function fetchUploaders() {
	const response = await fetch("/api/uploaders?limit=1000");
	const result = await response.json();
	if (!result?.ok) {
		throw new Error(result?.error?.message || "load uploaders failed");
	}

	const items = Array.isArray(result?.data?.items) ? result.data.items : [];
	setUploaderFilterOptions(items.map((item) => item.nickname));
	uploadersLoaded = true;
}

function setTagFilterOptions(items) {
	if (!tagFilter) return;
	const previousValue = tagFilter.value;
	tagFilter.innerHTML = "";

	const defaultOption = document.createElement("option");
	defaultOption.value = "";
	defaultOption.textContent = "全部标签";
	tagFilter.appendChild(defaultOption);

	for (const item of items || []) {
		const tag = String(item?.tag || "").trim();
		if (!tag) continue;
		const count = Number(item?.count || 0);
		const option = document.createElement("option");
		option.value = tag;
		option.textContent = `#${tag} (${count})`;
		tagFilter.appendChild(option);
	}

	tagFilter.value = previousValue;
	if (!tagFilter.value && previousValue) {
		const exists = Array.from(tagFilter.options).some(
			(option) => option.value === previousValue
		);
		if (exists) tagFilter.value = previousValue;
	}

	if (tagCustomSelect) {
		tagCustomSelect.rebuild();
	}
}

async function fetchTags() {
	if (!tagFilter) return;
	const response = await fetch("/api/tags/list?limit=100&mediaType=audio");
	const result = await response.json();
	if (!result?.ok) {
		throw new Error(result?.error?.message || "load tags failed");
	}

	const items = Array.isArray(result?.data?.items) ? result.data.items : [];
	setTagFilterOptions(items);
	tagsLoaded = true;
}

async function fetchList({ append = false } = {}) {
	if (isLoading) return;
	isLoading = true;
	loadMoreButton.disabled = true;

	try {
		const params = new URLSearchParams();
		params.set("limit", "20");
		params.set("groupBy", groupBySelect.value);
		params.set("mediaType", "audio");
		if (uploaderFilter.value) params.set("uploader", uploaderFilter.value);
		if (tagFilter?.value) params.set("tag", tagFilter.value);
		if (append && nextCursor) params.set("cursor", nextCursor);

		const response = await fetch(`/api/list?${params.toString()}`);
		const result = await response.json();
		if (!result.ok) {
			groupContainer.textContent = "列表加载失败";
			return;
		}

		const data = result.data || {};
		appendGroups(data, append);

		if (!uploadersLoaded && !append) {
			const fallbackUploaders = (data.items || [])
				.map((item) => (item.uploader_nickname || "093").trim())
				.filter(Boolean);
			setUploaderFilterOptions(fallbackUploaders);
		}

		if (!tagsLoaded && !append && tagFilter) {
			const tagStats = new Map();
			for (const item of data.items || []) {
				for (const tag of item.tags || []) {
					tagStats.set(tag, Number(tagStats.get(tag) || 0) + 1);
				}
			}
			setTagFilterOptions(
				Array.from(tagStats.entries()).map(([tag, count]) => ({
					tag,
					count,
				}))
			);
		}

		nextCursor = data.nextCursor || null;
		loadMoreButton.disabled = !nextCursor;
	} finally {
		isLoading = false;
	}
}

refreshButton.addEventListener("click", () => {
	nextCursor = null;
	fetchList({ append: false });
});

groupBySelect.addEventListener("change", () => {
	nextCursor = null;
	fetchList({ append: false });
});

uploaderFilter.addEventListener("change", () => {
	nextCursor = null;
	fetchList({ append: false });
});

if (tagFilter) {
	tagFilter.addEventListener("change", () => {
		nextCursor = null;
		fetchList({ append: false });
	});
}

loadMoreButton.addEventListener("click", () => {
	if (!nextCursor) return;
	fetchList({ append: true });
});

document.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof Element)) {
		closeAllCustomSelects();
		return;
	}
	if (!target.closest(".custom-select")) {
		closeAllCustomSelects();
	}
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		closeAllCustomSelects();
	}
});

groupByCustomSelect = createCustomSelect(groupBySelect);
uploaderCustomSelect = createCustomSelect(uploaderFilter);
tagCustomSelect = createCustomSelect(tagFilter);

groupContainer.addEventListener("click", (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const tag = target.dataset.tag;
	if (!tag || !tagFilter) return;
	tagFilter.value = tag;
	if (tagCustomSelect) {
		tagCustomSelect.rebuild();
	}
	nextCursor = null;
	fetchList({ append: false });
});

applyTheme();

Promise.allSettled([
	fetchUploaders(),
	fetchTags(),
	fetchList({ append: false }),
]).then((results) => {
	const uploaderResult = results[0];
	if (uploaderResult.status === "rejected") {
		console.warn("load uploaders failed:", uploaderResult.reason);
	}
	const tagResult = results[1];
	if (tagResult.status === "rejected") {
		console.warn("load tags failed:", tagResult.reason);
	}
});
