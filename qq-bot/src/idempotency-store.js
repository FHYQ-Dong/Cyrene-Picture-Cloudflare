export class IdempotencyStore {
	constructor(ttlMs = 900000) {
		this.ttlMs = Math.max(Number(ttlMs || 900000), 60000);
		this.items = new Map();
	}

	has(key) {
		this.gc();
		const entry = this.items.get(String(key || ""));
		if (!entry) return false;
		return entry.expiresAt > Date.now();
	}

	set(key) {
		const normalized = String(key || "").trim();
		if (!normalized) return;
		this.items.set(normalized, {
			expiresAt: Date.now() + this.ttlMs,
		});
	}

	gc() {
		const now = Date.now();
		for (const [key, value] of this.items.entries()) {
			if (!value || value.expiresAt <= now) {
				this.items.delete(key);
			}
		}
	}
}
