import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPolicy, isPathInside, PathPolicyError } from "../../src/security/path-policy.js";
import {
  cleanupTempDirs,
  createDirLink,
  supportsDirectoryLinks,
  supportsFileSymlinks,
  tempDir,
  writeFileAt,
} from "../tools/helpers.js";

afterEach(cleanupTempDirs);

const DIR_LINKS = supportsDirectoryLinks();
const FILE_SYMLINKS = supportsFileSymlinks();

describe("V4 path-policy — 内外部判定", () => {
  it("POSIX 边界：同根、前缀陷阱、父级逃逸、大小写敏感", () => {
    expect(isPathInside("/work", "/work", "linux")).toBe(true);
    expect(isPathInside("/work", "/work/a/b.ts", "linux")).toBe(true);
    expect(isPathInside("/work", "/workshop/a.ts", "linux")).toBe(false);
    expect(isPathInside("/work", "/work/../etc/passwd", "linux")).toBe(false);
    expect(isPathInside("/work", "/Work/a.ts", "linux")).toBe(false);
  });

  it("Windows 大小写不敏感，分隔符混用不误判", () => {
    expect(isPathInside("C:\\Work", "c:\\work\\Sub\\a.ts", "win32")).toBe(true);
    expect(isPathInside("C:\\Work", "C:/Work/Sub/a.ts", "win32")).toBe(true);
    expect(isPathInside("C:\\Work", "C:\\Workshop\\a.ts", "win32")).toBe(false);
    expect(isPathInside("C:\\Work", "D:\\Work\\a.ts", "win32")).toBe(false);
  });

  it("区内相对路径返回规范化绝对路径与真实路径", () => {
    const root = tempDir("shana-ws-");
    writeFileAt(root, "src/a.ts", "x");
    const policy = createPathPolicy(root);
    const resolved = policy.resolve("src/./a.ts");

    expect(resolved.insideWorkspace).toBe(true);
    expect(resolved.exists).toBe(true);
    expect(resolved.isSymlink).toBe(false);
    expect(resolved.danglingSymlink).toBe(false);
    expect(path.resolve(resolved.absolutePath)).toBe(path.join(policy.workspaceRoot, "src", "a.ts"));
    expect(resolved.realPath).toBe(fs.realpathSync.native(path.join(policy.workspaceRoot, "src", "a.ts")));
  });

  it(".. 逃逸到工作区外被标记", () => {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(parent, "outside.txt"), "secret");
    const policy = createPathPolicy(root);

    const resolved = policy.resolve("../outside.txt");
    expect(resolved.insideWorkspace).toBe(false);
    expect(resolved.exists).toBe(true);
  });

  it("同前缀兄弟目录不会被当成区内", () => {
    const parent = tempDir("shana-prefix-");
    const root = path.join(parent, "ws");
    const sibling = path.join(parent, "ws-other");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "x.txt"), "x");
    const policy = createPathPolicy(root);

    expect(policy.resolve("../ws-other/x.txt").insideWorkspace).toBe(false);
  });

  it("不存在的区内新文件仍判定为区内", () => {
    const root = tempDir("shana-ws-");
    const policy = createPathPolicy(root);
    const resolved = policy.resolve("new/deep/file.txt");

    expect(resolved.exists).toBe(false);
    expect(resolved.insideWorkspace).toBe(true);
  });

  it("指向区外的目录链接按外部处理，链接本身标记 symlink", () => {
    if (!DIR_LINKS) return;
    const root = tempDir("shana-ws-");
    const outside = tempDir("shana-out-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    createDirLink(outside, path.join(root, "escape"));
    const policy = createPathPolicy(root);

    const link = policy.resolve("escape");
    expect(link.isSymlink).toBe(true);
    expect(link.insideWorkspace).toBe(false);

    const file = policy.resolve("escape/secret.txt");
    expect(file.exists).toBe(true);
    expect(file.insideWorkspace).toBe(false);
    expect(path.resolve(file.realPath)).toBe(path.resolve(fs.realpathSync.native(outside), "secret.txt"));

    const missing = policy.resolve("escape/new/deep.txt");
    expect(missing.exists).toBe(false);
    expect(missing.insideWorkspace).toBe(false);
  });

  it("工作区根本身是链接时以真实路径为边界", () => {
    if (!DIR_LINKS) return;
    const real = tempDir("shana-real-");
    writeFileAt(real, "a.txt", "a");
    const linkRoot = path.join(tempDir("shana-link-"), "ws");
    createDirLink(real, linkRoot);
    const policy = createPathPolicy(linkRoot);

    expect(policy.workspaceRoot).toBe(fs.realpathSync.native(real));
    expect(policy.resolve("a.txt").insideWorkspace).toBe(true);
  });

  it("悬空文件符号链接按外部处理，不猜测目标", () => {
    if (!FILE_SYMLINKS) return;
    const root = tempDir("shana-ws-");
    const missingTarget = path.join(tempDir("shana-missing-"), "ghost.txt");
    fs.symlinkSync(missingTarget, path.join(root, "dangling.txt"), "file");
    const policy = createPathPolicy(root);

    const resolved = policy.resolve("dangling.txt");
    expect(resolved.isSymlink).toBe(true);
    expect(resolved.danglingSymlink).toBe(true);
    expect(resolved.insideWorkspace).toBe(false);
  });

  it("空路径与 NUL 路径明确拒绝", () => {
    const policy = createPathPolicy(tempDir("shana-ws-"));
    expect(() => policy.resolve("")).toThrow(PathPolicyError);
    expect(policy.resolve("   ").requested).toBe("   ");
    expect(() => policy.resolve("a\0b")).toThrow(PathPolicyError);
  });
});
