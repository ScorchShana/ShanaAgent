import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("copies only runtime binaries and license, replacing stale assets without removing compiled JavaScript", () => {
  const output = mkdtempSync(join(tmpdir(), "shana-build-assets-"));
  const source = fileURLToPath(new URL("../src/tui/framework/", import.meta.url));
  const script = fileURLToPath(new URL("../build-assets.mjs", import.meta.url));
  const assets = [
    "LICENSE",
    "native/darwin/prebuilds/darwin-arm64/darwin-platform.node",
    "native/darwin/prebuilds/darwin-x64/darwin-platform.node",
    "native/linux/prebuilds/linux-arm64/linux-platform-x11.node",
    "native/linux/prebuilds/linux-x64/linux-platform-x11.node",
    "native/win32/prebuilds/win32-arm64/win32-platform.node",
    "native/win32/prebuilds/win32-x64/win32-platform.node",
  ];
  try {
    for (const stale of ["native/win32/src/obsolete.c", "UPSTREAM.md", "SOURCE.md", "native-platform.js"]) {
      mkdirSync(dirname(join(output, stale)), { recursive: true });
      writeFileSync(join(output, stale), "existing");
    }
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [script, output], { cwd: tmpdir() });
      const files = readdirSync(output, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(output.length + 1).replaceAll("\\", "/"));
      expect(files.sort()).toEqual([...assets, "native-platform.js"].sort());
      for (const asset of assets) {
        expect(readFileSync(join(output, asset))).toEqual(readFileSync(join(source, asset)));
      }
      expect(readFileSync(join(output, "native-platform.js"), "utf8")).toBe("existing");
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
