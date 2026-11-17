import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(new URL("./src/tui/framework/", import.meta.url));
const output = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("./dist/tui/framework/", import.meta.url));
const sourceRelative = relative(output, source);
if (!sourceRelative || (!isAbsolute(sourceRelative) && sourceRelative.split(/[\\/]/)[0] !== "..")) {
  throw new Error("Asset output must not contain the source framework directory");
}
const outputRelative = relative(source, output);
if (!outputRelative || (!isAbsolute(outputRelative) && outputRelative.split(/[\\/]/)[0] !== "..")) {
  throw new Error("Asset output must not be inside the source framework directory");
}

const assets = ["LICENSE"];
for (const platform of ["darwin", "linux", "win32"]) {
  for (const arch of ["arm64", "x64"]) {
    const suffix = platform === "linux" ? "-x11" : "";
    assets.push(`native/${platform}/prebuilds/${platform}-${arch}/${platform}-platform${suffix}.node`);
  }
}
for (const asset of assets) readFileSync(join(source, asset));

rmSync(join(output, "native"), { recursive: true, force: true });
for (const obsolete of ["UPSTREAM.md", "SOURCE.md"]) rmSync(join(output, obsolete), { force: true });
for (const asset of assets) {
  const target = join(output, asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, asset), target);
}
