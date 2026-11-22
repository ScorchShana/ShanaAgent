import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { analyzeGitQuery } from "../../src/security/bash-git-policy.js";
import { createPathPolicy } from "../../src/security/path-policy.js";
import { detectShell } from "../../src/tools/shell.js";
import { cleanupTempDirs, tempDir } from "../tools/helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

function repository() {
  const root = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, "file"), "content");
  git("add", "file");
  return { root, git, policy: createPathPolicy(root) };
}

it("checks the effective index and rechecks environment changes", async () => {
  const { root, policy } = repository();
  const args = ["ls-files", "--cached"];
  const result = await analyzeGitQuery(args, root, policy, "confirm");
  expect(result.decision).toBe("allow");
  vi.stubEnv("GIT_INDEX_FILE", path.join(root, ".git", "local-index"));
  expect((await analyzeGitQuery(args, root, policy, "auto")).decision).toBe("allow");
  vi.stubEnv("GIT_INDEX_FILE", path.join(tempDir(), "index"));
  expect((await analyzeGitQuery(args, root, policy, "auto")).decision).toBe("ask");
  if (result.decision === "allow") await expect(result.revalidate()).rejects.toThrow("Path target changed");
});

it("allows split index only in auto without freshening it during analysis", async () => {
  const { root, git, policy } = repository();
  git("update-index", "--split-index");
  const shared = fs.readdirSync(path.join(root, ".git")).find((name) => name.startsWith("sharedindex."))!;
  const target = path.join(root, ".git", shared);
  fs.utimesSync(target, 1000000, 1000000);
  const before = fs.statSync(target).mtimeMs;
  const args = ["ls-files", "--cached"];
  expect((await analyzeGitQuery(args, root, policy, "confirm")).decision).toBe("ask");
  const result = await analyzeGitQuery(args, root, policy, "auto");
  expect(result.decision).toBe("allow");
  if (result.decision === "allow") await result.revalidate();
  expect(fs.statSync(target).mtimeMs).toBe(before);
  const shell = detectShell();
  const listing = execFileSync(shell.executable, shell.argumentsFor("git ls-files --cached"), {
    cwd: root,
    encoding: "utf8",
  });
  expect(listing.trim()).toBe("file");
  expect(fs.statSync(target).mtimeMs).toBeGreaterThan(before);
  fs.linkSync(target, path.join(tempDir(), "external-name"));
  expect((await analyzeGitQuery(args, root, policy, "auto")).decision).toBe("ask");
});

it("checks both the per-worktree and common metadata directories", async () => {
  const { root, git, policy } = repository();
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const linked = path.join(root, "linked");
  git("worktree", "add", "--detach", linked, "HEAD");
  for (const args of [
    ["rev-parse", "--show-toplevel"],
    ["ls-files", "--cached"],
  ]) {
    expect((await analyzeGitQuery(args, linked, policy, "auto")).decision).toBe("allow");
    expect((await analyzeGitQuery(args, linked, createPathPolicy(linked), "auto")).decision).toBe("ask");
  }
  git("-C", linked, "update-index", "--split-index");
  expect((await analyzeGitQuery(["ls-files", "--cached"], linked, policy, "auto")).decision).toBe("allow");
});

it("recognizes index version 4 and does not treat a filename as a link extension", async () => {
  const { root, git, policy } = repository();
  fs.writeFileSync(path.join(root, "link"), "content");
  git("add", "link");
  git("update-index", "--index-version=4");
  expect((await analyzeGitQuery(["ls-files", "--cached"], root, policy, "confirm")).decision).toBe("allow");
});
