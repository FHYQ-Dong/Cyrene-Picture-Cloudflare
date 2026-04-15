/**
 * Per-user FSM for image collection.
 *
 * States:
 *   idle       → (trigger word) → collecting
 *   collecting → (image message) → collecting (reset timer)
 *   collecting → (non-image message OR timeout) → idle
 */
export class CollectorFSM {
	constructor(timeoutMs = 300000) {
		this._timeoutMs = timeoutMs;
		this._states = new Map();
	}

	_key(groupId, userId) {
		return `${groupId}:${userId}`;
	}

	isCollecting(groupId, userId) {
		const entry = this._states.get(this._key(groupId, userId));
		if (!entry) return false;
		if (Date.now() > entry.expiresAt) {
			this._states.delete(this._key(groupId, userId));
			return false;
		}
		return true;
	}

	activate(groupId, userId, meta = {}) {
		this._states.set(this._key(groupId, userId), {
			expiresAt: Date.now() + this._timeoutMs,
			meta,
		});
	}

	getMeta(groupId, userId) {
		const entry = this._states.get(this._key(groupId, userId));
		if (!entry || Date.now() > entry.expiresAt) return {};
		return entry.meta || {};
	}

	refresh(groupId, userId) {
		const key = this._key(groupId, userId);
		const entry = this._states.get(key);
		if (entry) entry.expiresAt = Date.now() + this._timeoutMs;
	}

	deactivate(groupId, userId) {
		this._states.delete(this._key(groupId, userId));
	}

	cleanup() {
		const now = Date.now();
		for (const [key, entry] of this._states) {
			if (now > entry.expiresAt) this._states.delete(key);
		}
	}
}
