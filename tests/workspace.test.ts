import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveWorkspaceIdentity, normalizeWorkspacePath } from "../src/workspace.js";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-ws-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("workspace identity", () => {
  it("同一工作区多次推导得到相同 id", () => {
    const dir = makeTempDir();
    const first = deriveWorkspaceIdentity(dir);
    const second = deriveWorkspaceIdentity(dir);
    expect(first.id).toBe(second.id);
  });

  it("尾部分隔符不影响 id", () => {
    const dir = makeTempDir();
    const plain = deriveWorkspaceIdentity(dir);
    const withSep = deriveWorkspaceIdentity(dir + path.sep);
    expect(plain.id).toBe(withSep.id);
  });

  it("不同工作区 id 不同", () => {
    const a = makeTempDir();
    const b = makeTempDir();
    expect(deriveWorkspaceIdentity(a).id).not.toBe(deriveWorkspaceIdentity(b).id);
  });

  it("id 形如 <slug>-<hash> 且 slug 来自目录名", () => {
    const parent = makeTempDir();
    const dir = path.join(parent, "MyProject");
    fs.mkdirSync(dir);
    const identity = deriveWorkspaceIdentity(dir);
    expect(identity.id).toMatch(/^myproject-[0-9a-f]{12}$/);
    expect(identity.hash).toHaveLength(12);
  });

  it("Windows 下大小写不敏感推导一致", () => {
    if (process.platform !== "win32") return;
    const dir = makeTempDir();
    const upper = dir.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`).toUpperCase();
    expect(deriveWorkspaceIdentity(dir).id).toBe(deriveWorkspaceIdentity(upper).id);
  });

  it("符号链接经 realpath 解析后与原路径 id 相同", () => {
    const real = makeTempDir();
    const link = path.join(makeTempDir(), "link");
    try {
      fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // 无 symlink 权限的环境跳过
    }
    expect(deriveWorkspaceIdentity(link).id).toBe(deriveWorkspaceIdentity(real).id);
  });

  it("Windows 路径规范化：反斜杠、大小写、尾部分隔符", () => {
    const normalized = normalizeWorkspacePath("C:\\Foo\\Bar\\\\", "win32");
    expect(normalized).toBe("c:/foo/bar");
  });
});
