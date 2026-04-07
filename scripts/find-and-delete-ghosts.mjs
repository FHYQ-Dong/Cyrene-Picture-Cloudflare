import fs from "fs";

// To make this robust and easy to reuse we read the JSON output.
const fileContent = fs.readFileSync("recent_images.json", "utf-8");
const data = JSON.parse(fileContent);
const images = data[0].results;

console.log(`Checking ${images.length} images...`);

const GHOSTS = [];
const ADMIN_API_URL = "https://cyrene.fhyq.cloud/api/admin/delete-images";
const ADMIN_TOKEN = "See you tomorrow, Cyrene.";

async function run() {
	let checked = 0;

	// We can do it concurrently but let's not overwhelm the endpoint, maybe 20 at a time.
	for (let i = 0; i < images.length; i += 20) {
		const batch = images.slice(i, i + 20);
		await Promise.all(
			batch.map(async (img) => {
				try {
					// Check if physical file exists
					const res = await fetch(img.public_url, { method: "HEAD" });
					if (res.status === 404) {
						GHOSTS.push(img.image_id);
						console.log(
							`Ghost detected: ${img.image_id} (${img.public_url})`
						);
					}
				} catch (err) {
					console.error(
						`Fetch error for ${img.public_url}:`,
						err.message
					);
				}
			})
		);
		checked += batch.length;
		process.stdout.write(`\rChecked ${checked}/${images.length}...`);
	}

	console.log(`\n\nFound ${GHOSTS.length} ghosts.`);

	if (GHOSTS.length > 0) {
		console.log("Issuing bulk deletion request to Admin API...");
		const response = await fetch(ADMIN_API_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ADMIN_TOKEN}`,
			},
			body: JSON.stringify({
				imageIds: GHOSTS,
			}),
		});

		const resultBody = await response.text();
		console.log(`Admin API Response (${response.status}):`, resultBody);
	}
}

run().catch(console.error);
