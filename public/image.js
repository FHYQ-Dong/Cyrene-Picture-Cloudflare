import { applyTheme } from "./site-config.js";

const detail = document.getElementById("detail");
const preview = document.getElementById("preview");
const prevButton = document.getElementById("prevButton");
const nextButton = document.getElementById("nextButton");
const detailLayout = document.getElementById("detailLayout");

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
	const width = Number(data.width || 0);
	const height = Number(data.height || 0);
	const sizeText = width > 0 && height > 0 ? `${width} × ${height}` : "未知";
	detail.innerHTML = `
		<div><strong>上传者：</strong>${data.uploader_nickname || "093"}</div>
		<div><strong>上传时间：</strong>${String(data.created_at || "")
			.replace("T", " ")
			.replace("Z", "")}</div>
		<div><strong>分辨率：</strong>${sizeText}</div>
		<div><strong>图片 ID：</strong>${data.image_id}</div>
	`;

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
	preview.src = data.public_url;
}

applyTheme();
load();
