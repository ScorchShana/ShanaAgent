import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGlob, validateGlobPattern } from "../../src/tools/glob.js";
import { createPathPolicy } from "../../src/security/path-policy.js";
import type { ToolContext } from "../../src/tools/registry.js";
import { cleanupTempDirs, createDirLink, makeWorkspace, writeFileAt } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

function search(root: string, pattern: string, options: Partial<ToolContext> = {}, directory?: string) {
  const pathPolicy = createPathPolicy(root);
  const context: ToolContext = { workspaceRoot: root, pathPolicy, platform: process.platform, ...options };
  return searchGlob(
    { pattern, ...(directory === undefined ? {} : { path: directory }) },
    pathPolicy.resolve(directory ?? "."),
    context,
  );
}

function fixture() {
  const root = makeWorkspace();
  for (const name of ["a.ts", "b.ts", ".hidden.ts", "sub/c.ts", "sub/deep/d.ts"]) {
    const file = writeFileAt(root, name, "");
    fs.utimesSync(file, 1000, 1000);
  }
  return root;
}

describe("glob confirmed matching", () => {
  it("includes hidden files, scopes patterns and recursively expands literal directories", async () => {
    const root = fixture();
    expect((await search(root, "*.ts")).content).toBe(".hidden.ts\na.ts\nb.ts");
    expect((await search(root, "sub")).content).toBe("sub/c.ts\nsub/deep/d.ts");
    expect((await search(root, "**/*.ts", {}, "sub")).content).toBe("sub/c.ts\nsub/deep/d.ts");
    expect((await search(root, "**/*.ts", {}, path.join(root, "sub"))).content).toBe(
      ["sub/c.ts", "sub/deep/d.ts"].map((p) => path.join(root, p).split(path.sep).join("/")).join("\n"),
    );
  });

  it("sorts by newest mtime then case-sensitive normalized path", async () => {
    const root = fixture();
    fs.utimesSync(path.join(root, "b.ts"), 2000, 2000);
    expect((await search(root, "*.ts")).content).toBe("b.ts\n.hidden.ts\na.ts");
  });

  it("applies parent and nested gitignore rules including explicit files and keeps ordinary build directories", async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, ".git"));
    writeFileAt(root, ".gitignore", "ignored.ts\nsub/parent.ts\n");
    writeFileAt(root, ".git/config", "");
    writeFileAt(root, "sub/.gitignore", "nested.ts\n");
    for (const name of [
      "ignored.ts",
      "sub/parent.ts",
      "sub/nested.ts",
      "sub/keep.ts",
      "node_modules/a.ts",
      "dist/a.ts",
    ])
      writeFileAt(root, name, "");
    expect((await search(root, "ignored.ts")).content).toBe("(No files found)");
    expect((await search(root, "*.ts", {}, "sub")).content).toBe("sub/keep.ts");
    const result = await search(root, "**/*");
    expect(result.content).not.toContain(".git/config");
    expect(result.content).toContain("node_modules/a.ts");
    expect(result.content).toContain("dist/a.ts");
  });

  it("does not return directories or traverse explicit directory links in a pattern", async () => {
    const root = fixture();
    try {
      createDirLink(path.join(root, "sub"), path.join(root, "link"));
    } catch {
      return;
    }
    expect((await search(root, "link/**/*.ts")).content).toBe("(No files found)");
    expect((await search(root, "**/*")).content).not.toContain("link");
    expect((await search(root, "*.ts", {}, "link")).content).toBe("link/c.ts");
  });

  it("returns only authorized file links and leaves directory links unexpanded", async () => {
    const root = fixture();
    const outside = makeWorkspace();
    const outsideFile = writeFileAt(outside, "external.ts", "");
    try {
      fs.symlinkSync(path.join(root, "a.ts"), path.join(root, "alias.ts"), "file");
      fs.symlinkSync(outsideFile, path.join(root, "external.ts"), "file");
    } catch {
      return;
    }
    const result = await search(root, "*.ts");
    expect(result.content).toContain("alias.ts");
    expect(result.content).not.toContain("external.ts");
  });

  it("returns zero matches and validates root failures", async () => {
    const root = fixture();
    expect((await search(root, "missing*")).content).toBe("(No files found)");
    expect((await search(root, "*", {}, "missing")).content).toBe("Error: Path not found.");
    expect((await search(root, "*", {}, "a.ts")).content).toBe("Error: Path is not a directory.");
  });

  it("reports only actual truncation and preserves full paths within the character budget", async () => {
    const root = makeWorkspace();
    for (let i = 0; i < 200; i++) writeFileAt(root, `${String(i).padStart(3, "0")}.txt`, "");
    const complete = await search(root, "*.txt");
    expect(complete.content.split("\n")).toHaveLength(200);
    expect(complete.content).not.toContain("truncated");
    writeFileAt(root, "extra.txt", "");
    expect((await search(root, "*.txt")).content).toContain(
      "\n\n(Results truncated: showing 200 files; narrow path or pattern.)",
    );
  });

  it("matches nested braces and character ranges", async () => {
    const root = fixture();
    expect((await search(root, "{[a-b],{nothing,missing}}.ts")).content).toBe("a.ts\nb.ts");
  });
});

describe("glob pattern safety", () => {
  it.each(["/a", "C:/a", "..", "a/../b", "{a,..}/b", ".{.,x}/a", "{a,/outside}/b"])(
    "rejects unsafe expanded pattern %s",
    (pattern) => {
      expect(validateGlobPattern(pattern)).toContain("must be relative");
    },
  );
  it.each(["!*.ts", "{a,!b}", "@(a|b)", "a/{1..10}.ts", "a\\*.ts", "a\0.ts", ""])(
    "rejects unsupported pattern %s",
    (pattern) => {
      expect(validateGlobPattern(pattern)).toBeTypeOf("string");
    },
  );
  it.each(["**/*.ts", "a..b/*.ts", "{src,{lib,test}}/[a-z]?.ts"])(
    "accepts supported pattern %s",
    (pattern) => {
      expect(validateGlobPattern(pattern)).toBeUndefined();
    },
  );
});

describe("glob failure and cleanup", () => {
  it("cancels before scheduling filesystem operations", async () => {
    const root = fixture();
    const controller = new AbortController();
    controller.abort();
    const spy = vi.spyOn(fs.promises, "stat");
    const result = await search(root, "**/*", { signal: controller.signal });
    expect(result.content).toBe("Error: Cancelled by user.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("discards partial matches on metadata permissions errors", async () => {
    const root = fixture();
    const original = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("b.ts"))
        throw Object.assign(new Error("sensitive detail"), { code: "EACCES" });
      return original(...args);
    });
    const result = await search(root, "*.ts");
    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: Search incomplete: permission denied.");
  });

  it("waits for started IO after timeout and schedules no more filesystem calls", async () => {
    const root = fixture();
    const original = fs.promises.stat.bind(fs.promises);
    let finished = false;
    const spy = vi.spyOn(fs.promises, "stat").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      finished = true;
      return original(...args);
    });
    const result = await search(root, "**/*", { globTimeoutMs: 5 });
    expect(result.content).toBe("Error: Search timed out.");
    expect(finished).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

it("花括号字符类保持字面匹配而不展开", async () => {
  const root = makeWorkspace();
  for (const file of ["{.ts", "}.ts", ",.ts"]) {
    const name = writeFileAt(root, file, "");
    fs.utimesSync(name, 1000, 1000);
  }
  expect((await search(root, "[{,}].ts")).content).toBe(",.ts\n{.ts\n}.ts");
});
