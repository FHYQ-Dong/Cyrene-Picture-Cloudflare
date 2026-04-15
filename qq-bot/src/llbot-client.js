import WebSocket from "ws";

export function createLLBotClient(config, { onEvent, onStatus }) {
	let socket = null;
	let reconnectTimer = null;
	let heartbeatTimer = null;
	let stopped = false;

	function cleanupTimers() {
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		reconnectTimer = null;
		heartbeatTimer = null;
	}

	function scheduleReconnect() {
		if (stopped) return;
		onStatus?.("reconnecting");
		reconnectTimer = setTimeout(connect, config.llbotReconnectDelayMs);
	}

	function connect() {
		cleanupTimers();
		socket = new WebSocket(config.llbotWsUrl, {
			headers: config.llbotAccessToken
				? { Authorization: `Bearer ${config.llbotAccessToken}` }
				: undefined,
		});

		socket.on("open", () => {
			onStatus?.("connected");
			heartbeatTimer = setInterval(() => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.ping();
				}
			}, config.llbotHeartbeatIntervalMs);
		});

		socket.on("message", (raw) => {
			try {
				const event = JSON.parse(String(raw || "{}"));
				onEvent?.(event);
			} catch {
				onStatus?.("invalid-event");
			}
		});

		socket.on("close", () => {
			cleanupTimers();
			scheduleReconnect();
		});

		socket.on("error", () => {
			onStatus?.("error");
		});
	}

	return {
		start() {
			stopped = false;
			connect();
		},
		stop() {
			stopped = true;
			cleanupTimers();
			try {
				socket?.close();
			} catch {}
		},
		sendAction(action, params = {}) {
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				return Promise.reject(new Error("websocket not connected"));
			}
			const echo = `${action}-${Date.now()}`;
			socket.send(JSON.stringify({ action, params, echo }));
			return Promise.resolve(echo);
		},
	};
}
