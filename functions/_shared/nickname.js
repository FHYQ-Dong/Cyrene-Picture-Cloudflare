export const DEFAULT_UPLOADER_NICKNAME = "093";

export function normalizeUploaderNickname(input, maxLength = 24) {
	const raw = String(input || "").trim();
	if (!raw) {
		return {
			nickname: DEFAULT_UPLOADER_NICKNAME,
			usedDefault: true,
		};
	}

	const sliced = raw.slice(0, maxLength);
	return {
		nickname: sliced,
		usedDefault: false,
	};
}
