import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "dist", "assets");
mkdirSync(destination, { recursive: true });
cpSync(resolve(root, "assets"), destination, { recursive: true });
console.log("Copied Dashboard assets into dist/assets.");
