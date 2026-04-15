import { extractImagesFromEvent } from "./image-extractor.js";
import { getCommandNames } from "./commands.js";

function normalizeMessageId(event) {
	return String(event?.message_id || event?.id || "").trim();
}

function normalizeGroupId(event) {
	return String(event?.group_id || "").trim();
}

function normalizeUserId(event) {
	return String(event?.user_id || "").trim();
}

function hasOnlyImages(event) {
	const segments = Array.isArray(event?.message) ? event.message : [];
	if (!segments.length) return false;
	return segments.every((s) => s?.type === "image");
}

/**
 * Detect @mention and extract remaining text.
 * Returns { mentioned: boolean, text: string }
 */
function extractMentionAndText(event, botQqId) {
	if (!botQqId) return { mentioned: false, text: "" };
	const id = String(botQqId);

	// Array format (preferred)
	if (Array.isArray(event?.message)) {
		let mentioned = false;
		const textParts = [];
		for (const seg of event.message) {
			if (seg?.type === "at" && String(seg?.data?.qq) === id) {
				mentioned = true;
				continue;
			}
			if (seg?.type === "text" && seg?.data?.text) {
				textParts.push(seg.data.text);
			}
		}
		return { mentioned, text: textParts.join("").trim() };
	}

	// String fallback
	const raw = String(event?.raw_message || "");
	const cqPattern = `[CQ:at,qq=${id}]`;
	const idx = raw.indexOf(cqPattern);
	if (idx === -1) return { mentioned: false, text: "" };
	return { mentioned: true, text: raw.slice(idx + cqPattern.length).trim() };
}

/**
 * Parse command from text after @mention.
 * Returns { command, args } or null.
 */
function parseCommand(text) {
	const trimmed = String(text || "").trimStart();
	for (const name of getCommandNames()) {
		if (trimmed.startsWith(name)) {
			return { command: name, args: trimmed.slice(name.length).trim() };
		}
	}
	return null;
}

function parseInlineTags(args, defaultTags) {
	const tags = String(args || "")
		.split(/\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
	return tags.length ? tags : defaultTags;
}

function buildPayload(event, config, images, scope, tags) {
	const senderName = String(
		event?.sender?.card || event?.sender?.nickname || ""
	).trim();

	return {
		source: "llbot-onebot",
		reviewMode: config.cyreneReviewMode,
		groupId: scope,
		messageId: normalizeMessageId(event),
		senderId: normalizeUserId(event),
		senderName,
		uploaderNickname: senderName,
		tags: tags || config.cyreneDefaultTags,
		images,
	};
}

function checkWhitelist(event, config) {
	const messageType = event?.message_type;
	const userId = normalizeUserId(event);

	if (messageType === "group") {
		const groupId = normalizeGroupId(event);
		if (!groupId) return null;
		if (config.qqAllowedGroups.size && !config.qqAllowedGroups.has(groupId))
			return null;
		return { messageType, groupId, userId };
	}
	if (messageType === "private") {
		if (!userId) return null;
		if (config.qqAllowedUsers.size && !config.qqAllowedUsers.has(userId))
			return null;
		return { messageType, groupId: "", userId };
	}
	return null;
}

/**
 * Check if event is a command (@mention + recognized command or help).
 * Returns { type, ... } or null.
 */
export function matchCommand(event, config) {
	if (event?.post_type !== "message") return null;

	const wl = checkWhitelist(event, config);
	if (!wl) return null;

	const { mentioned, text } = extractMentionAndText(event, config.botQqId);
	if (!mentioned) return null;

	const parsed = parseCommand(text);

	// /添加图片 is handled by FSM in buildIngestPayload, not here
	if (parsed?.command === "/添加图片") return null;

	// Recognized command with handler
	if (parsed) {
		return {
			type: "command",
			command: parsed.command,
			args: parsed.args,
			messageType: wl.messageType,
			groupId: wl.groupId,
			userId: wl.userId,
		};
	}

	// Unrecognized or empty → help
	return {
		type: "help",
		messageType: wl.messageType,
		groupId: wl.groupId,
		userId: wl.userId,
	};
}

/**
 * Process a message event with @mention command + FSM-based collection.
 *
 * @mention + /添加图片 → activate FSM, collect images if any
 * Image-only message while FSM collecting → collect (no @mention needed)
 * Non-image message while FSM collecting → deactivate
 */
export function buildIngestPayload(event, config, fsm) {
	if (event?.post_type !== "message") return null;

	const wl = checkWhitelist(event, config);
	if (!wl) return null;

	const messageId = normalizeMessageId(event);
	if (!messageId) return null;

	const userId = normalizeUserId(event);
	const scope =
		wl.messageType === "group"
			? normalizeGroupId(event)
			: `private:${userId}`;
	const images = extractImagesFromEvent(event, config.ingestMaxItemsPerMessage);

	// Check for @mention + /添加图片
	const { mentioned, text } = extractMentionAndText(event, config.botQqId);
	const parsed = mentioned ? parseCommand(text) : null;

	if (parsed?.command === "/添加图片") {
		const tags = parseInlineTags(parsed.args, config.cyreneDefaultTags);
		if (fsm) fsm.activate(scope, userId, { tags });
		console.log(
			`[qq-bot] /添加图片 args="${parsed.args}" tags=${JSON.stringify(tags)}`
		);
		if (!images.length) return null;
		return buildPayload(event, config, images, scope, tags);
	}

	if (!fsm) return null;

	// FSM collecting + image-only → collect (no @mention needed)
	if (
		fsm.isCollecting(scope, userId) &&
		images.length &&
		hasOnlyImages(event)
	) {
		fsm.refresh(scope, userId);
		const { tags } = fsm.getMeta(scope, userId);
		return buildPayload(
			event,
			config,
			images,
			scope,
			tags || config.cyreneDefaultTags
		);
	}

	// FSM collecting + non-image → deactivate
	if (fsm.isCollecting(scope, userId)) {
		fsm.deactivate(scope, userId);
	}

	return null;
}
