import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { getNativeModuleCandidates } from "../../../src/tui/framework/native-module-path.ts";

for (const root of ["src", "dist"]) {
  test(`loads native assets beside the embedded ${root} module`, () => {
    const moduleDir = resolve(root, "tui", "framework");
    const nativePath = join("native", "win32", "prebuilds", "win32-x64", "win32-platform.node");
    assert.deepEqual(
      getNativeModuleCandidates(nativePath, {
        moduleUrl: pathToFileURL(join(moduleDir, "native-module-path.js")).href,
      }),
      [join(moduleDir, nativePath)],
    );
  });
}
