import { getRandomImage, listTags } from "./cyrene-client.js";

/**
 * Command registry. Each command has:
 *   name        — the /command prefix to match
 *   description — shown in help text
 *   handler(ctx) — async function, ctx = { cmd, config, sendMessage }
 *
 * "/添加图片" is handled by the FSM in event-router, not here.
 * It's registered only for help text and command parsing.
 */

const commands = [];

export function registerCommand(def) {
	commands.push(def);
}

export function getCommands() {
	return commands;
}

export function getCommandNames() {
	return commands.map((c) => c.name);
}

export function findHandler(commandName) {
	return commands.find((c) => c.name === commandName)?.handler || null;
}

export function buildHelpText(botQqId) {
	const at = botQqId ? `@bot ` : "";
	const lines = ["可用命令："];
	for (const c of commands) {
		lines.push(
			`\n● ${at}${c.name} ${c.usage || ""}`.trimEnd() +
				`\n  ${c.description}` +
				(Array.isArray(c.example)
					? c.example.map((e) => `\n  例：${at}${e}`).join("")
					: c.example
					? `\n  例：${at}${c.example}`
					: "")
		);
	}
	return lines.join("\n");
}

// ── Built-in commands ──

registerCommand({
	name: "/添加图片",
	usage: "[标签...]",
	description:
		"给图片站投稿。发送本指令之后直接发送图片即可。标签可选，多个标签用空格分隔。",
	example: ["/添加图片", "/添加图片 昔涟美图 风景"],
	// Handled by FSM in event-router, no handler here
	handler: null,
});

registerCommand({
	name: "/随机图片",
	usage: "[标签]",
	description: "随机获取一张图片。标签可选。",
	example: ["/随机图片", "/随机图片 昔涟美图"],
	handler: async ({ cmd, config, sendMessage }) => {
		const result = await getRandomImage(config, cmd.args);
		const target = cmd.messageType === "group" ? cmd.groupId : cmd.userId;

		if (!result.ok) {
			const text = cmd.args
				? `未找到标签「${cmd.args}」的图片`
				: "暂无图片";
			await sendMessage(cmd.messageType, target, text);
			return;
		}

		const imageUrl = result.data.publicUrl.startsWith("http")
			? result.data.publicUrl
			: `${config.cyreneApiBaseUrl}/api/object?key=${encodeURIComponent(
					result.data.objectKey
			  )}`;
		await sendMessage(cmd.messageType, target, [
			{ type: "image", data: { url: imageUrl } },
		]);
		console.log(
			`[qq-bot] /随机图片 ok tag=${cmd.args || "(none)"} id=${
				result.data.imageId
			}`
		);
	},
});

registerCommand({
	name: "/标签列表",
	usage: "",
	description: "展示所有可用标签",
	example: "/标签列表",
	handler: async ({ cmd, config, sendMessage }) => {
		const target = cmd.messageType === "group" ? cmd.groupId : cmd.userId;
		const result = await listTags(config);

		if (!result.ok) {
			await sendMessage(cmd.messageType, target, "获取标签列表失败");
			return;
		}

		if (!result.items.length) {
			await sendMessage(cmd.messageType, target, "暂无标签");
			return;
		}

		const lines = ["标签列表："];
		for (const item of result.items) {
			lines.push(`● ${item.tag}（${item.count} 张）`);
		}
		await sendMessage(cmd.messageType, target, lines.join("\n"));
	},
});

registerCommand({
	name: "/网站",
	usage: "",
	description: "获取昔涟图片站地址",
	example: "/网站",
	handler: async ({ cmd, sendMessage }) => {
		const target = cmd.messageType === "group" ? cmd.groupId : cmd.userId;
		await sendMessage(cmd.messageType, target, "https://cyrene.fhyq.cloud");
	},
});
