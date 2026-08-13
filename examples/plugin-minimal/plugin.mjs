#!/usr/bin/env node
// Minimal plugin example (plan Task 24): one tool provider executed as a
// minimized subprocess. It reads a JSON request from the file path given as
// the first argument and writes exactly one JSON result line to stdout. The
// plugin declares no resources and needs no environment; the host runs it
// with a scrubbed environment, a timeout and an output cap.

import { readFileSync } from "node:fs";

function fail(message) {
  process.stdout.write(`${JSON.stringify({ status: "error", error: message })}\n`);
  process.exit(1);
}

const requestPath = process.argv[2];
if (requestPath === undefined) fail("usage: plugin.mjs <request-file>");

let request;
try {
  request = JSON.parse(readFileSync(requestPath, "utf8"));
} catch {
  fail("request file is not readable JSON");
}

if (typeof request !== "object" || request === null || typeof request.text !== "string") {
  fail('request must be an object with a string "text" field');
}

process.stdout.write(
  `${JSON.stringify({ status: "ok", capability: "tool.echo", echo: request.text })}\n`,
);
