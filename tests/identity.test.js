import test from "node:test";
import assert from "node:assert/strict";
import { createObjectKey } from "../functions/_shared/identity.js";

test("createObjectKey generates expected path structure", () => {
	const key = createObjectKey("demo.png");
	assert.match(key, /^public\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+\.png$/i);
});
