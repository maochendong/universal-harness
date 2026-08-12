import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// schema.sql is the single source of truth for the graph cache DDL; ship it
// alongside the compiled module so `new URL("./schema.sql", import.meta.url)`
// resolves in both src (tests) and dist (built package).
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(packageRoot, "dist/sqlite"), { recursive: true });
copyFileSync(
  join(packageRoot, "src/sqlite/schema.sql"),
  join(packageRoot, "dist/sqlite/schema.sql"),
);
console.log("Copied sqlite schema into dist/sqlite/schema.sql");
