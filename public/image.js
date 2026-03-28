import { applyTheme } from "./site-config.js";

const detail = document.getElementById("detail");
const preview = document.getElementById("preview");
const prevButton = document.getElementById("prevButton");
const nextButton = document.getElementById("nextButton");
const detailLayout = document.getElementById("detailLayout");
let currentDetailData = null;

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

function formatDateTimeGmt8(dateText) {
	const parsed = parseAsUtcDate(dateText);
	if (!parsed) return "未知";
	const gmt8 = new Date(parsed.getTime() + 8 * 60 * 60 * 1000);
	const iso = gmt8.toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function getAspectType(data) {
	const width = Number(data.width || 0);
	const height = Number(data.height || 0);
	const ratio = Number(data.aspect_ratio || 0);
	const safeRatio =
		ratio > 0 ? ratio : width > 0 && height > 0 ? width / height : 0;

	if (!safeRatio) return "unknown";
	if (safeRatio <= 0.8) return "portrait";
	if (safeRatio >= 1.2) return "landscape";
	return "square";
}

function navigateToImage(imageId) {
	window.location.href = `/image.html?id=${encodeURIComponent(imageId)}`;
}

function bindNeighborButton(button, neighbor) {
	if (!button) return;
	if (!neighbor || !neighbor.image_id) {
		button.disabled = true;
		button.onclick = null;
		return;
	}
	button.disabled = false;
	button.onclick = () => navigateToImage(neighbor.image_id);
}

function resolveDisplayDimensions(data) {
	const width = Number(data?.width || 0);
	const height = Number(data?.height || 0);
	if (width > 0 && height > 0) {
		return { width, height };
	}

	const naturalWidth = Number(preview?.naturalWidth || 0);
	const naturalHeight = Number(preview?.naturalHeight || 0);
	if (naturalWidth > 0 && naturalHeight > 0) {
		return {
			width: naturalWidth,
			height: naturalHeight,
		};
	}

	return { width: null, height: null };
}

function renderDetailPanel(data) {
	const dimensions = resolveDisplayDimensions(data);
	const sizeText =
		dimensions.width && dimensions.height
			? `${dimensions.width} × ${dimensions.height}`
			: "未知";

	detail.innerHTML = `
		<div><strong>上传者：</strong>${data.uploader_nickname || "093"}</div>
		<div><strong>上传时间：</strong>${formatDateTimeGmt8(data.created_at)}</div>
		<div><strong>分辨率：</strong>${sizeText}</div>
		<div><strong>图片 ID：</strong>${data.image_id}</div>
	`;
}

async function load() {
	const url = new URL(window.location.href);
	const id = url.searchParams.get("id");
	if (!id) {
		detail.textContent = "缺少 id";
		return;
	}

	const response = await fetch(`/api/image/${encodeURIComponent(id)}`);
	const payload = await response.json();
	if (!payload.ok) {
		detail.textContent = JSON.stringify(payload, null, 2);
		return;
	}

	const data = payload.data;
	currentDetailData = data;
	renderDetailPanel(data);

	if (detailLayout) {
		detailLayout.classList.remove(
			"detail-ratio-unknown",
			"detail-ratio-portrait",
			"detail-ratio-square",
			"detail-ratio-landscape"
		);
		detailLayout.classList.add(`detail-ratio-${getAspectType(data)}`);
	}

	bindNeighborButton(prevButton, data.prev);
	bindNeighborButton(nextButton, data.next);
	preview.onload = () => {
		if (!currentDetailData) return;
		renderDetailPanel(currentDetailData);
	};
	preview.src = data.public_url;
}

applyTheme();
load();
