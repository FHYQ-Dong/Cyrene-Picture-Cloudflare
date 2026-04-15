import test from "node:test";
import assert from "node:assert/strict";
import { buildIngestPayload, matchCommand } from "../src/event-router.js";
import { CollectorFSM } from "../src/collector-fsm.js";

const baseConfig = {
	cyreneReviewMode: "pending",
	cyreneDefaultTags: ["昔涟美图"],
	botQqId: "12345",
	qqAllowedGroups: new Set(["g-1"]),
	qqAllowedUsers: new Set(["u-1"]),
	ingestMaxItemsPerMessage: 20,
};

function atSegment(qq = "12345") {
	return { type: "at", data: { qq } };
}

function textSegment(text) {
	return { type: "text", data: { text } };
}

function imageSegment(url = "https://example.com/a.jpg") {
	return { type: "image", data: { url, file_name: "a.jpg", mime: "image/jpeg" } };
}

function groupEvent(message, overrides = {}) {
	return {
		post_type: "message",
		message_type: "group",
		group_id: "g-1",
		message_id: "m-1",
		user_id: "u-1",
		raw_message: "",
		sender: { nickname: "tester" },
		message,
		...overrides,
	};
}

function privateEvent(message, overrides = {}) {
	return {
		post_type: "message",
		message_type: "private",
		message_id: "m-1",
		user_id: "u-1",
		raw_message: "",
		sender: { nickname: "tester" },
		message,
		...overrides,
	};
}

// --- matchCommand tests ---

test("matchCommand: @bot + /随机图片 returns command", () => {
	const event = groupEvent([atSegment(), textSegment(" /随机图片 昔涟美图")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd.type, "command");
	assert.equal(cmd.command, "/随机图片");
	assert.equal(cmd.args, "昔涟美图");
});

test("matchCommand: @bot + /随机图片 without tag", () => {
	const event = groupEvent([atSegment(), textSegment(" /随机图片")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd.type, "command");
	assert.equal(cmd.command, "/随机图片");
	assert.equal(cmd.args, "");
});

test("matchCommand: @bot + unrecognized text returns help", () => {
	const event = groupEvent([atSegment(), textSegment(" 你好")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd.type, "help");
});

test("matchCommand: @bot with no text returns help", () => {
	const event = groupEvent([atSegment()]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd.type, "help");
});

test("matchCommand: @bot + /添加图片 returns null (handled by buildIngestPayload)", () => {
	const event = groupEvent([atSegment(), textSegment(" /添加图片")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd, null);
});

test("matchCommand: no @mention returns null", () => {
	const event = groupEvent([textSegment("hello")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd, null);
});

test("matchCommand: @wrong bot returns null", () => {
	const event = groupEvent([atSegment("99999"), textSegment(" /随机图片")]);
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd, null);
});

test("matchCommand: disallowed group returns null", () => {
	const event = groupEvent([atSegment(), textSegment(" /随机图片")], { group_id: "g-deny" });
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd, null);
});

// --- buildIngestPayload tests ---

test("@bot + /添加图片 with image returns payload", () => {
	const fsm = new CollectorFSM(300000);
	const event = groupEvent([atSegment(), textSegment(" /添加图片 昔涟表情包"), imageSegment()]);
	const payload = buildIngestPayload(event, baseConfig, fsm);
	assert.ok(payload);
	assert.deepEqual(payload.tags, ["昔涟表情包"]);
	assert.equal(payload.images.length, 1);
	assert.equal(fsm.isCollecting("g-1", "u-1"), true);
});

test("@bot + /添加图片 without image activates FSM, returns null", () => {
	const fsm = new CollectorFSM(300000);
	const event = groupEvent([atSegment(), textSegment(" /添加图片")]);
	const payload = buildIngestPayload(event, baseConfig, fsm);
	assert.equal(payload, null);
	assert.equal(fsm.isCollecting("g-1", "u-1"), true);
});

test("@bot + /添加图片 without tags uses defaults", () => {
	const fsm = new CollectorFSM(300000);
	const event = groupEvent([atSegment(), textSegment(" /添加图片"), imageSegment()]);
	const payload = buildIngestPayload(event, baseConfig, fsm);
	assert.ok(payload);
	assert.deepEqual(payload.tags, ["昔涟美图"]);
});

test("FSM collecting: image-only message without @mention is captured", () => {
	const fsm = new CollectorFSM(300000);

	// Activate FSM
	buildIngestPayload(
		groupEvent([atSegment(), textSegment(" /添加图片 测试")]),
		baseConfig, fsm
	);
	assert.equal(fsm.isCollecting("g-1", "u-1"), true);

	// Image-only, no @mention
	const payload = buildIngestPayload(
		groupEvent([imageSegment("https://example.com/b.jpg")], { message_id: "m-2" }),
		baseConfig, fsm
	);
	assert.ok(payload);
	assert.deepEqual(payload.tags, ["测试"]);
	assert.equal(fsm.isCollecting("g-1", "u-1"), true);
});

test("FSM collecting: non-image message deactivates", () => {
	const fsm = new CollectorFSM(300000);

	buildIngestPayload(
		groupEvent([atSegment(), textSegment(" /添加图片")]),
		baseConfig, fsm
	);

	buildIngestPayload(
		groupEvent([textSegment("done")], { message_id: "m-2" }),
		baseConfig, fsm
	);
	assert.equal(fsm.isCollecting("g-1", "u-1"), false);
});

test("no @mention and no FSM returns null", () => {
	const fsm = new CollectorFSM(300000);
	const event = groupEvent([imageSegment()]);
	const payload = buildIngestPayload(event, baseConfig, fsm);
	assert.equal(payload, null);
});

test("private: @bot + /添加图片 works", () => {
	const fsm = new CollectorFSM(300000);
	const event = privateEvent([atSegment(), textSegment(" /添加图片"), imageSegment()]);
	const payload = buildIngestPayload(event, baseConfig, fsm);
	assert.ok(payload);
	assert.equal(payload.groupId, "private:u-1");
});

test("string format fallback: CQ:at detection works", () => {
	const event = groupEvent("not-an-array", {
		raw_message: "[CQ:at,qq=12345] /随机图片 风景",
		message: "[CQ:at,qq=12345] /随机图片 风景",
	});
	const cmd = matchCommand(event, baseConfig);
	assert.equal(cmd.type, "command");
	assert.equal(cmd.command, "/随机图片");
	assert.equal(cmd.args, "风景");
});
