function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetry(error) {
	const status = Number(error?.status || 0);
	if (status === 429) return true;
	if (status >= 500) return true;
	if (!status) return true;
	return false;
}

export async function withRetry(
	task,
	{ maxAttempts = 3, backoffMs = 1200, onRetry = () => {} } = {}
) {
	let lastError = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await task();
		} catch (error) {
			lastError = error;
			if (attempt >= maxAttempts || !shouldRetry(error)) {
				throw error;
			}
			onRetry({ attempt, error });
			await sleep(backoffMs * attempt);
		}
	}
	throw lastError || new Error("retry failed");
}
