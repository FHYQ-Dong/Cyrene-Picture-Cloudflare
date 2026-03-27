export function writeLog(level, context) {
	const payload = {
		timestamp: new Date().toISOString(),
		level,
		...context,
	};
	console.log(JSON.stringify(payload));
}
