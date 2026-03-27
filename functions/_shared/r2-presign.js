import { AwsClient } from "aws4fetch";

export async function createPresignedPutUrl(
	env,
	objectKey,
	mime,
	expiresSeconds = 900
) {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const bucket = env.R2_BUCKET_NAME;
	const accessKeyId = env.R2_ACCESS_KEY_ID;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY;

	if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error("Missing R2 signing env vars");
	}

	const originUrl = new URL(
		`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${objectKey}`
	);
	originUrl.searchParams.set("X-Amz-Expires", String(expiresSeconds));
	const signer = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: "s3",
		region: "auto",
	});

	const request = new Request(originUrl.toString(), {
		method: "PUT",
		headers: {
			"content-type": mime,
		},
	});

	const signedRequest = await signer.sign(request, {
		aws: {
			signQuery: true,
			allHeaders: true,
			singleEncode: true,
			appendSessionToken: true,
			datetime: new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
		},
	});

	return {
		uploadUrl: signedRequest.url,
		requiredHeaders: {
			"content-type": mime,
		},
	};
}
