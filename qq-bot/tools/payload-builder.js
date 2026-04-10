import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function splitCsv(input) {
	return String(input || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function buildIngestPayload(event, options = {}) {
	const source =
		String(options.source || "mirai-docker").trim() || "mirai-docker";
	const reviewMode =
		String(options.reviewMode || "pending")
			.trim()
			.toLowerCase() === "auto"
			? "auto"
			: "pending";
	const defaultTags = Array.isArray(options.defaultTags)
		? options.defaultTags
				.map((item) => String(item || "").trim())
				.filter(Boolean)
		: splitCsv(options.defaultTags || "昔涟美图,qq投稿");

	const images = Array.isArray(event?.images)
		? event.images
				.map((image, index) => ({
					clientFileId: String(image?.clientFileId || `img-${index}`),
					imageUrl: String(
						image?.imageUrl || image?.url || ""
					).trim(),
					fileName: String(
						image?.fileName ||
							image?.filename ||
							`image-${index}.jpg`
					).trim(),
					mime: String(image?.mime || "image/jpeg")
						.trim()
						.toLowerCase(),
					tags: Array.isArray(image?.tags)
						? image.tags
								.map((item) => String(item || "").trim())
								.filter(Boolean)
						: [],
				}))
				.filter((item) => item.imageUrl)
		: [];

	return {
		source,
		groupId: String(event?.groupId || "").trim(),
		messageId: String(event?.messageId || "").trim(),
		senderId: String(event?.senderId || "").trim(),
		senderName: String(event?.senderName || "").trim(),
		reviewMode,
		tags: defaultTags,
		images,
	};
}

function runCli() {
	const outputPath = process.argv[2]
		? path.resolve(process.cwd(), process.argv[2])
		: path.resolve(__dirname, "../dist/payload.sample.json");

	const sampleEvent = {
		groupId: "123456",
		messageId: `mirai-${Date.now()}`,
		senderId: "10001",
		senderName: "mirai-user",
		images: [
			{
				url: "https://example.com/image-1.jpg",
				filename: "image-1.jpg",
				mime: "image/jpeg",
				tags: ["投稿"],
			},
		],
	};

	const payload = buildIngestPayload(sampleEvent, {
		source: process.env.CYRENE_SOURCE || "mirai-docker",
		reviewMode: process.env.CYRENE_REVIEW_MODE || "pending",
		defaultTags: process.env.CYRENE_DEFAULT_TAGS || "昔涟美图,qq投稿",
	});

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		`${JSON.stringify(payload, null, 2)}\n`,
		"utf8"
	);
	console.log(`[payload-builder] wrote: ${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	runCli();
}
