import assert from "node:assert/strict";
import { test } from "node:test";

import { greeting } from "../src/greeting.js";

test("greeting returns a deterministic salutation", () => {
  assert.equal(greeting("world"), "hello, world");
});
