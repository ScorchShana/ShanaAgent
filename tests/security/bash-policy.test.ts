import { execFileSync } from "node:child_process";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeBash } from "../../src/security/bash-policy.js";
import { createPathPolicy } from "../../src/security/path-policy.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "shana-bash-policy-"));
  await fs.mkdir(path.join(root, "docs"));
  for (const file of ["a.txt", "b.txt", "docs/guide.md", "a b.md"])
    await fs.writeFile(path.join(root, file), "ok");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
function analyze(command: string, mode: "confirm" | "auto" = "auto") {
  return analyzeBash(command, { mode, pathPolicy: createPathPolicy(root) });
}
describe("Bash 命令效果", () => {
  it.each([
    "pwd",
    "printf '%s\\n' hello",
    "cat 'a b.md'",
    "wc -l < a.txt",
    "ls docs",
    "grep -nF -- TODO a.txt",
    "grep -i optim",
    "ls -la | grep -i optim",
    "diff -u a.txt b.txt",
    "cmp a.txt b.txt",
    "sha256sum -- a.txt",
    "test -f absent",
    "cut -d , -f 1 a.txt",
    "tr -d '\\r' < a.txt",
    "uniq a.txt",
    "cat a.txt | wc -l",
    "head -n 5 a.txt",
    "tail -n 2 a.txt b.txt",
    "tail -n +2 a.txt",
    "tail -c 3 a.txt",
    "cat a.txt | head -n 1",
    "head",
    "ls docs; wc -l docs/guide.md",
    "cat a.txt; cat b.txt",
    "cat a.txt | wc -l; ls docs",
    "cd -- ./docs && wc -l guide.md",
  ])("只读 %s", async (command) => {
    expect((await analyze(command, "confirm")).decision).toBe("allow");
  });
  it.each([
    "mkdir -p out/a",
    "touch new",
    "cat a.txt > b.txt",
    "printf '%s\\n' hi >> new",
    "uniq a.txt b.txt",
    "cp -- a.txt docs/",
    "cp -- a.txt new",
    "printf '%s\\n' hi | tee -a -- new other",
    "truncate -s 0 -- new",
  ])("区内写入 %s", async (command) => {
    expect((await analyze(command)).decision).toBe("allow");
    expect((await analyze(command, "confirm")).decision).toBe("ask");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("ok");
  });
  it.each([
    "cat a.txt && git fetch",
    "cat *.txt",
    'cat "$HOME/a.txt"',
    "cat '",
    "rm a.txt",
    "mv a.txt b.txt",
    "cp -R docs out",
    "ls -R docs",
    "ln -s a.txt new",
    "sort a.txt",
    "cd docs || wc -l guide.md",
    "cat a.txt > ../out",
    "echo test &",
    "printf -v PATH new",
    "cd -- -",
    "tee --output-error=warn",
    "cat a.txt;",
    "cat a.txt | unknown",
    "grep -i",
    "grep -e pat a.txt",
    "cd docs; wc -l guide.md",
    "cd docs && cat a.txt; wc -l b.txt",
    "ls; cd docs",
    "sort a.txt; ls",
    "cat a.txt;; cat b.txt",
    "tail -f a.txt",
    "tail -F a.txt",
    "head -n",
    "head -n x a.txt",
    "head -n5 a.txt",
    "head -5 a.txt",
    "head -q a.txt",
    "head ../a.txt",
    "head absent",
  ])("人工 %s", async (command) => {
    expect((await analyze(command)).decision).toBe("ask");
  });
  it("分析后重新检查目标类型", async () => {
    const result = await analyze("touch new");
    expect(result.decision).toBe("allow");
    await fs.mkdir(path.join(root, "new"));
    if (result.decision === "allow") await expect(result.revalidate()).rejects.toThrow("Path target changed");
  });
  it("继承启动脚本时询问", async () => {
    vi.stubEnv("BASH_ENV", "startup");
    expect((await analyze("pwd")).decision).toBe("ask");
  });
});

describe("ls 通配符（仅列名字/元数据）", () => {
  it.each(["ls *.md", "ls docs/*", "ls .*", "ls docs/*.md", "ls *.nomatch", "ls a?b"])(
    "只读放行 %s",
    async (command) => {
      expect((await analyze(command, "confirm")).decision).toBe("allow");
      expect((await analyze(command)).decision).toBe("allow");
    },
  );
  it.each(["ls ../*", "ls */x", "ls {a,b}", "ls /*", "ls -R *", 'ls "*.md"', "ls '*.md'"])(
    "询问 %s",
    async (command) => {
      expect((await analyze(command)).decision).toBe("ask");
    },
  );
  it("前缀目录含 - 开头目录项时询问（选项注入缓解）", async () => {
    await fs.writeFile(path.join(root, "-R"), "x");
    expect((await analyze("ls *")).decision).toBe("ask");
    await fs.writeFile(path.join(root, "docs", "-L"), "x");
    expect((await analyze("ls docs/*")).decision).toBe("ask");
  });
  it("revalidate 期间新增 - 开头目录项报路径错误", async () => {
    const result = await analyze("ls *");
    expect(result.decision).toBe("allow");
    await fs.writeFile(path.join(root, "-R"), "x");
    if (result.decision === "allow") await expect(result.revalidate()).rejects.toThrow("Path target changed");
  });
  it("匹配项是指向区外的符号链接时放行（ls 只读链接本体）", async () => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "shana-bash-glob-external-"));
    try {
      await fs.symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      expect((await analyze("ls *")).decision).toBe("allow");
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  });
});

it("checks the final copy destination and every tee operand", async () => {
  expect((await analyze("printf '%s' hi | tee -- new ../other")).decision).toBe("ask");
  await fs.mkdir(path.join(root, "docs", "a.txt"));
  expect((await analyze("cp -- a.txt docs/")).decision).toBe("ask");
});

it("requires approval for an external directory reached through a workspace link", async () => {
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "shana-bash-external-"));
  try {
    await fs.writeFile(path.join(external, "data"), "outside");
    await fs.symlink(external, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect((await analyze("cat linked/data")).decision).toBe("ask");
    expect((await analyze("touch linked/new")).decision).toBe("ask");
  } finally {
    await fs.rm(external, { recursive: true, force: true });
  }
});

it("revalidates the directory used by cd", async () => {
  const result = await analyze("cd docs && wc -l guide.md");
  expect(result.decision).toBe("allow");
  const old = path.join(root, "docs");
  await fs.rename(old, path.join(root, "moved"));
  await fs.writeFile(old, "file");
  if (result.decision === "allow") await expect(result.revalidate()).rejects.toThrow("Path target changed");
});

it.each(["pwd\u00a0", "cat\u000b a.txt", "cat\\ a.txt"])(
  "rejects unsupported token separators",
  async (command) => {
    expect((await analyze(command)).decision).toBe("ask");
  },
);

it("records validated forms and real targets for a pipeline", async () => {
  const result = await analyze("cat a.txt | tee -- new");
  expect(result).toMatchObject({
    decision: "allow",
    commands: ["cat a.txt", "tee -- new"],
    readPaths: [path.join(root, "a.txt")],
    writePaths: [path.join(root, "new")],
  });
});

it("asks for compound writes when a workspace directory participates in command lookup", async () => {
  vi.stubEnv("PATH", path.join(root, "docs") + path.delimiter + process.env.PATH);
  expect((await analyze("touch new && wc -l a.txt")).decision).toBe("ask");
});

it.skipIf(process.platform === "win32")("accepts a verified absolute Bash for probes after cd", async () => {
  vi.stubEnv("PATH", ".:/usr/bin:/bin");
  await fs.writeFile(path.join(root, "docs", "bash"), "", { mode: 0o755 });
  expect((await analyze("cd docs && wc -l guide.md", "confirm")).decision).toBe("allow");
});

it("resolves Git through the actual Bash command path", async () => {
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const command of ["git rev-parse --show-toplevel", "git ls-files --cached"]) {
    const result = await analyze(command);
    expect(result.decision).toBe("allow");
    if (result.decision === "allow") await result.revalidate();
  }
});
