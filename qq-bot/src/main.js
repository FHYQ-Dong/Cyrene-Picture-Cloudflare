import { loadConfig } from "./config.js";
import { createLLBotClient } from "./llbot-client.js";
import { buildIngestPayload, matchCommand } from "./event-router.js";
import { ingestImages } from "./cyrene-client.js";
import { withRetry } from "./retry.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { CollectorFSM } from "./collector-fsm.js";
import { findHandler, buildHelpText } from "./commands.js";

function createIdempotencyKey(payload, index) {
	return `${payload.source}|${payload.groupId}|${payload.messageId}|${payload.senderId}|${index}`;
}

function validateConfig(config) {
	if (!config.llbotWsUrl) throw new Error("LLBOT_WS_URL is required");
	if (!config.botQqId) throw new Error("BOT_QQ_ID is required");
	if (!config.cyreneApiBaseUrl)
		throw new Error("CYRENE_API_BASE_URL is required");
	if (!config.cyreneBotIngestToken)
		throw new Error("CYRENE_BOT_INGEST_TOKEN is required");
}

const config = loadConfig();
validateConfig(config);

const idempotencyStore = new IdempotencyStore(config.idempotencyTtlMs);
const collectorFSM = new CollectorFSM(config.collectorTimeoutMs);

setInterval(() => collectorFSM.cleanup(), 60000);

async function sendMessage(messageType, target, message) {
	const id = Number(target) || target;
	if (messageType === "group") {
		await client.sendAction("send_group_msg", {
			group_id: id,
			message,
		});
	} else {
		await client.sendAction("send_private_msg", {
			user_id: id,
			message,
		});
	}
}

async function handleCommand(cmd) {
	const handler = findHandler(cmd.command);
	if (!handler) return;
	await handler({ cmd, config, sendMessage });
}

async function handleHelp(cmd) {
	const target = cmd.messageType === "group" ? cmd.groupId : cmd.userId;
	await sendMessage(cmd.messageType, target, buildHelpText(config.botQqId));
}

async function handleEvent(event) {
	if (event?.post_type === "message") {
		console.log(
			`[qq-bot] event type=${event.message_type} user=${event.user_id} group=${event.group_id || "-"} msg=${String(event.raw_message || "").slice(0, 50)}`
		);
	}

	const cmd = matchCommand(event, config);
	if (cmd?.type === "command") {
		await handleCommand(cmd);
		return;
	}
	if (cmd?.type === "help") {
		await handleHelp(cmd);
		return;
	}

	const payload = buildIngestPayload(event, config, collectorFSM);
	if (!payload) return;

	payload.images = payload.images.filter((_, index) => {
		const key = createIdempotencyKey(payload, index);
		if (idempotencyStore.has(key)) return false;
		idempotencyStore.set(key);
		return true;
	});

	if (!payload.images.length) return;

	await withRetry(() => ingestImages(config, payload), {
		maxAttempts: config.retryMaxAttempts,
		backoffMs: config.retryBackoffMs,
		onRetry: ({ attempt, error }) => {
			console.warn(
				`[qq-bot] retry attempt=${attempt} group=${
					payload.groupId
				} message=${payload.messageId} error=${String(
					error?.message || error
				)}`
			);
		},
	});

	console.log(
		`[qq-bot] ingest ok group=${payload.groupId} message=${payload.messageId} images=${payload.images.length}`
	);
}

const client = createLLBotClient(config, {
	onEvent: (event) => {
		handleEvent(event).catch((error) => {
			console.error(
				`[qq-bot] failed error=${String(error?.message || error)}`
			);
		});
	},
	onStatus: (status) => {
		console.log(`[qq-bot] llbot status=${status}`);
	},
});

client.start();

process.on("SIGINT", () => {
	client.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	client.stop();
	process.exit(0);
});
