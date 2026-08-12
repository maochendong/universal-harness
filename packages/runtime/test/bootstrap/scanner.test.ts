import { afterEach, describe, expect, it } from "vitest";

import { extractReferences, scanWorktree } from "../../src/index.js";
import { cleanupDirectories, makeTempDir, writeTree } from "./helpers.js";

afterEach(cleanupDirectories);

describe("scanWorktree", () => {
  it("classifies files, groups components and detects the stack deterministically", () => {
    const root = makeTempDir("harness-scan-");
    writeTree(root, {
      "package.json": '{"name":"demo","version":"0.0.0"}\n',
      "src/index.ts": "import { helper } from './helper';\nexport const x = helper;\n",
      "src/helper.ts": "export const helper = 1;\n",
      "src/index.test.ts": "import { x } from './index';\n",
      "docs/guide.md": "# Guide\n",
      "README.md": "# Demo\n",
    });

    const scan = scanWorktree(root);
    expect(scan.stack).toEqual({ primary: "node", detected: ["node"] });
    expect(scan.files.map((file) => file.path)).toEqual([
      "README.md",
      "docs/guide.md",
      "package.json",
      "src/helper.ts",
      "src/index.test.ts",
      "src/index.ts",
    ]);
    const byPath = new Map(scan.files.map((file) => [file.path, file]));
    expect(byPath.get("src/index.ts")?.classification).toBe("source");
    expect(byPath.get("src/index.test.ts")?.classification).toBe("test");
    expect(byPath.get("package.json")?.classification).toBe("config");
    expect(byPath.get("README.md")?.classification).toBe("documentation");
    expect(byPath.get("src/index.ts")?.references).toEqual(["./helper"]);
    expect(scan.components).toEqual([{ path: "src", fileCount: 3 }]);
    expect(scan.conflicts).toEqual([]);
    expect(scan.unknownItems).toEqual([]);

    // Same content, second scan: identical observation.
    expect(scanWorktree(root)).toEqual(scan);
  });

  it("detects python and java stacks, generic as fallback", () => {
    const python = makeTempDir("harness-scan-py-");
    writeTree(python, {
      "pyproject.toml": "[project]\nname = 'demo'\n",
      "src/main.py": "import os\nfrom app import util\n",
      "tests/test_main.py": "def test_ok():\n    assert True\n",
    });
    const pythonScan = scanWorktree(python);
    expect(pythonScan.stack).toEqual({ primary: "python", detected: ["python"] });
    const main = pythonScan.files.find((file) => file.path === "src/main.py");
    expect(main?.classification).toBe("source");
    expect(main?.references).toEqual(["app", "os"]);
    expect(
      pythonScan.files.find((file) => file.path === "tests/test_main.py")?.classification,
    ).toBe("test");
    expect(pythonScan.components).toEqual([
      { path: "src", fileCount: 1 },
      { path: "tests", fileCount: 1 },
    ]);

    const java = makeTempDir("harness-scan-java-");
    writeTree(java, {
      "pom.xml": "<project/>\n",
      "src/main/java/app/Main.java": "import java.util.List;\n",
      "src/test/java/app/MainTest.java": "import org.junit.Test;\n",
    });
    const javaScan = scanWorktree(java);
    expect(javaScan.stack).toEqual({ primary: "java", detected: ["java"] });
    expect(
      javaScan.files.find((file) => file.path === "src/main/java/app/Main.java")?.references,
    ).toEqual(["java.util.List"]);
    // Top-level component grouping only.
    expect(javaScan.components).toEqual([{ path: "src", fileCount: 2 }]);

    const generic = makeTempDir("harness-scan-generic-");
    writeTree(generic, { "notes.txt": "hello\n" });
    expect(scanWorktree(generic).stack).toEqual({ primary: "generic", detected: [] });
  });

  it("ignores caches and VCS internals", () => {
    const root = makeTempDir("harness-scan-cache-");
    writeTree(root, {
      "package.json": "{}\n",
      "src/index.ts": "export {};\n",
      "node_modules/leftpad/index.js": "module.exports = 1;\n",
      ".git/refs-heads-main": "abc\n",
      ".venv/lib/python.py": "x = 1\n",
      "dist/bundle.js": "built();\n",
      "__pycache__/main.cpython-313.pyc": "pyc\n",
    });
    const scan = scanWorktree(root);
    expect(scan.files.map((file) => file.path)).toEqual(["package.json", "src/index.ts"]);
  });

  it("reports locator conflicts and unknown items without failing the scan", () => {
    const root = makeTempDir("harness-scan-conflict-");
    writeTree(root, {
      "src/index.ts": "export {};\n",
      "odd#name.ts": "export {};\n",
      "data.xyz": "???\n",
      "logo.png": "a\x00b\n",
    });
    const scan = scanWorktree(root);
    expect(scan.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(scan.conflicts).toEqual([
      { path: "odd#name.ts", reason: expect.stringContaining("illegal_locator") as string },
    ]);
    expect(scan.unknownItems).toEqual([
      { path: "data.xyz", reason: "unrecognized_file_type" },
      { path: "logo.png", reason: "binary_file" },
    ]);
  });

  it("extracts references deterministically per language", () => {
    expect(
      extractReferences(
        "typescript",
        "import a from 'b';\nexport { c } from \"d\";\nimport 'e';\nconst f = require('g');\n",
      ),
    ).toEqual(["b", "d", "e", "g"]);
    expect(extractReferences("python", "import os\nfrom pkg.sub import thing\n")).toEqual([
      "os",
      "pkg.sub",
    ]);
    expect(
      extractReferences("java", "import static java.util.Objects;\nimport java.io.File;\n"),
    ).toEqual(["java.io.File", "java.util.Objects"]);
    expect(extractReferences("markdown", "import x from 'y';")).toEqual([]);
  });
});
