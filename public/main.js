import { applyTheme } from "./site-config.js";

const groupBySelect = document.getElementById("groupBySelect");
const uploaderFilter = document.getElementById("uploaderFilter");
const refreshButton = document.getElementById("refreshButton");
const loadMoreButton = document.getElementById("loadMoreButton");
const groupContainer = document.getElementById("groupContainer");

let nextCursor = null;
let isLoading = false;
let groupByCustomSelect = null;
let uploaderCustomSelect = null;

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

function getAspectInfo(item) {
	const width = Number(item.width || 0);
	const height = Number(item.height || 0);
	const ratio = Number(item.aspect_ratio || 0);
	const safeRatio =
		ratio > 0 ? ratio : width > 0 && height > 0 ? width / height : 0;

	if (!safeRatio) return { type: "unknown", ratio: 0 };
	if (safeRatio <= 0.8) return { type: "portrait", ratio: safeRatio };
	if (safeRatio >= 1.2) return { type: "landscape", ratio: safeRatio };
	return { type: "square", ratio: safeRatio };
}

function groupTitle(groupBy, groupKey) {
	if (groupBy === "uploader") return `上传者：${groupKey}`;
	if (groupBy === "date") return `上传日期：${groupKey}`;
	return "图片";
}

function createImageCard(item) {
	const card = document.createElement("article");
	const aspect = getAspectInfo(item);
	card.className = `image-card image-ratio-${aspect.type}`;

	const media = document.createElement("div");
	media.className = "image-card-media";
	if (aspect.ratio > 0) {
		media.style.aspectRatio = `${aspect.ratio}`;
	}

	const img = document.createElement("img");
	img.src = item.thumb_url || item.public_url;
	img.alt = item.image_id;
	img.loading = "lazy";

	media.appendChild(img);

	const thumbLink = document.createElement("a");
	thumbLink.className = "image-card-thumb-link";
	thumbLink.href = `/image.html?id=${encodeURIComponent(item.image_id)}`;
	thumbLink.target = "_blank";
	thumbLink.rel = "noopener noreferrer";
	thumbLink.setAttribute("aria-label", "查看图片详情");
	thumbLink.appendChild(media);

	const meta = document.createElement("div");
	meta.className = "image-meta";
	meta.textContent = `${item.uploader_nickname || "093"} · ${String(
		item.created_at || ""
	).slice(0, 10)}`;

	card.appendChild(thumbLink);
	card.appendChild(meta);
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

		const masonry = document.createElement("div");
		masonry.className = "masonry";
		for (const imageId of group.imageIds || []) {
			const item = itemsById.get(imageId);
			if (!item) continue;
			masonry.appendChild(createImageCard(item));
		}

		section.appendChild(heading);
		section.appendChild(masonry);
		groupContainer.appendChild(section);
	}
}

function refreshUploaderFilter(items) {
	const existing = new Set(
		Array.from(uploaderFilter.options)
			.slice(1)
			.map((option) => option.value)
	);
	for (const item of items || []) {
		const nickname = (item.uploader_nickname || "093").trim();
		if (!nickname || existing.has(nickname)) continue;
		existing.add(nickname);
		const option = document.createElement("option");
		option.value = nickname;
		option.textContent = nickname;
		uploaderFilter.appendChild(option);
	}
	if (uploaderCustomSelect) {
		uploaderCustomSelect.rebuild();
	}
}

async function fetchList({ append = false } = {}) {
	if (isLoading) return;
	isLoading = true;
	loadMoreButton.disabled = true;

	try {
		const params = new URLSearchParams();
		params.set("limit", "20");
		params.set("groupBy", groupBySelect.value);
		if (uploaderFilter.value) params.set("uploader", uploaderFilter.value);
		if (append && nextCursor) params.set("cursor", nextCursor);

		const response = await fetch(`/api/list?${params.toString()}`);
		const result = await response.json();
		if (!result.ok) {
			groupContainer.textContent = "列表加载失败";
			return;
		}

		const data = result.data || {};
		appendGroups(data, append);
		refreshUploaderFilter(data.items || []);

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

applyTheme();
fetchList({ append: false });
