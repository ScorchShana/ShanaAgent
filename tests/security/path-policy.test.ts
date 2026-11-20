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

describe("skills 只读区（insideSkills）", () => {
  function makeRoots(): { ws: string; skills: string } {
    return { ws: tempDir("shana-ws-"), skills: tempDir("shana-skills-") };
  }

  it("skills 区内文件 insideSkills=true 且 insideWorkspace=false；区内文件反之", () => {
    const { ws, skills } = makeRoots();
    writeFileAt(ws, "a.txt", "x");
    const skillFile = writeFileAt(skills, "review/SKILL.md", "body");
    const policy = createPathPolicy(ws, process.platform, skills);
    expect(policy.skillsRoot).toBe(fs.realpathSync.native(skills));

    const inside = policy.resolve(skillFile);
    expect(inside.insideSkills).toBe(true);
    expect(inside.insideWorkspace).toBe(false);
    const workspace = policy.resolve("a.txt");
    expect(workspace.insideSkills).toBe(false);
    expect(workspace.insideWorkspace).toBe(true);
  });

  it("同前缀兄弟目录与 ~/.shana 其他子目录不算 skills 区", () => {
    const parent = tempDir("shana-home-");
    const ws = path.join(parent, "ws");
    fs.mkdirSync(ws);
    const skills = path.join(parent, ".shana", "skills");
    fs.mkdirSync(skills, { recursive: true });
    const sibling = writeFileAt(parent, ".shana/skills-other/x.txt", "x");
    const sessions = writeFileAt(parent, ".shana/sessions/s.jsonl", "{}");
    const logs = writeFileAt(parent, ".shana/logs/d.log", "x");
    const policy = createPathPolicy(ws, process.platform, skills);
    for (const file of [sibling, sessions, logs]) {
      expect(policy.resolve(file).insideSkills).toBe(false);
    }
    expect(policy.resolve(writeFileAt(skills, "review/SKILL.md", "x")).insideSkills).toBe(true);
  });

  it("目录链接逃逸到 skills 区外不豁免", () => {
    if (!DIR_LINKS) return;
    const { ws, skills } = makeRoots();
    const outside = tempDir("shana-out-");
    writeFileAt(outside, "secret.txt", "secret");
    createDirLink(outside, path.join(skills, "escape"));
    const policy = createPathPolicy(ws, process.platform, skills);
    const resolved = policy.resolve(path.join(skills, "escape", "secret.txt"));
    expect(resolved.insideSkills).toBe(false);
    expect(resolved.insideWorkspace).toBe(false);
  });

  it("skills 根本身是链接时以真实路径为边界；缺根回退绝对路径不炸", () => {
    const { ws } = makeRoots();
    const missing = path.join(tempDir("shana-missing-"), "skills");
    const policy = createPathPolicy(ws, process.platform, missing);
    expect(policy.skillsRoot).toBe(path.resolve(missing));
    const file = writeFileAt(missing, "review/SKILL.md", "x");
    expect(policy.resolve(file).insideSkills).toBe(true);

    if (!DIR_LINKS) return;
    const real = tempDir("shana-skills-real-");
    writeFileAt(real, "review/SKILL.md", "x");
    const linkRoot = path.join(tempDir("shana-skills-link-"), "skills");
    createDirLink(real, linkRoot);
    const linked = createPathPolicy(ws, process.platform, linkRoot);
    expect(linked.skillsRoot).toBe(fs.realpathSync.native(real));
    expect(linked.resolve(path.join(linkRoot, "review", "SKILL.md")).insideSkills).toBe(true);
  });

  it("悬空符号链接不算 skills 区", () => {
    if (!FILE_SYMLINKS) return;
    const { ws, skills } = makeRoots();
    const missingTarget = path.join(tempDir("shana-missing-"), "ghost.md");
    fs.symlinkSync(missingTarget, path.join(skills, "dangling.md"), "file");
    const policy = createPathPolicy(ws, process.platform, skills);
    const resolved = policy.resolve(path.join(skills, "dangling.md"));
    expect(resolved.danglingSymlink).toBe(true);
    expect(resolved.insideSkills).toBe(false);
  });
});
