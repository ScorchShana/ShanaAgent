import fs from "node:fs";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import { searchFiles, GREP_MAX_MATCHES } from "../../src/tools/grep.js";
import {
  call,
  cleanupTempDirs,
  createDirLink,
  makeExecutor,
  makeWorkspace,
  recordingGate,
  supportsDirectoryLinks,
  tempDir,
  writeFileAt,
} from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const DIR_LINKS = supportsDirectoryLinks();

function setupWorkspace(): string {
  const root = makeWorkspace();
  writeFileAt(root, "src/a.ts", "const alpha = 1;\nconst beta = 2;\n");
  writeFileAt(root, "src/b.txt", "alpha in text\n");
  return root;
}

describe("V2 grep — 内容搜索与符号链接", () => {
  it("输出 file:line: text，正则与多文件均支持", async () => {
    const root = setupWorkspace();
    const executor = makeExecutor(root);

    const literal = await executor.execute(call("c1", "grep", { pattern: "alpha" }));
    expect(literal.status).toBe("success");
    const lines = literal.content.split("\n");
    expect(lines).toContain("src/a.ts:1: const alpha = 1;");
    expect(lines).toContain("src/b.txt:1: alpha in text");

    const regex = await executor.execute(call("c2", "grep", { pattern: "const (alpha|beta)" }));
    expect(regex.content.split("\n")).toHaveLength(2);

    const scoped = await executor.execute(call("c3", "grep", { pattern: "alpha", path: "src/a.ts" }));
    expect(scoped.content).toBe("src/a.ts:1: const alpha = 1;");
  });

  it("无匹配与非法正则分别返回确定结果", async () => {
    const root = setupWorkspace();
    const executor = makeExecutor(root);

    const none = await executor.execute(call("c1", "grep", { pattern: "zzz" }));
    expect(none.status).toBe("success");
    expect(none.content).toBe("No matches found.");

    const invalid = await executor.execute(call("c2", "grep", { pattern: "(" }));
    expect(invalid.status).toBe("error");
    expect(invalid.errorCategory).toBe("io");
    expect(invalid.content.startsWith("Error: ")).toBe(true);
    expect(invalid.content).toContain("Invalid pattern:");
  });

  it("路径不存在时明确报错", async () => {
    const root = setupWorkspace();
    const result = await makeExecutor(root).execute(
      call("c1", "grep", { pattern: "alpha", path: "missing.txt" }),
    );
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("io");
    expect(result.content).toBe("Error: Path not found.");
  });

  it("默认搜索不跟随目录链接，链接目标内容不出现", async () => {
    if (!DIR_LINKS) return;
    const root = setupWorkspace();
    const outside = tempDir("shana-grep-out-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "alpha secret\n");
    createDirLink(outside, path.join(root, "link"));

    const result = await makeExecutor(root).execute(call("c1", "grep", { pattern: "alpha" }));
    expect(result.status).toBe("success");
    expect(result.content).toContain("src/a.ts");
    expect(result.content).not.toContain("secret");
  });

  it("显式搜索外部链接路径按外部审批，批准后搜索真实目标", async () => {
    if (!DIR_LINKS) return;
    const root = setupWorkspace();
    const outside = tempDir("shana-grep-out-");
    fs.writeFileSync(path.join(outside, "secret.txt"), "alpha secret\n");
    createDirLink(outside, path.join(root, "link"));

    const denied = await makeExecutor(root).execute(call("c1", "grep", { pattern: "alpha", path: "link" }));
    expect(denied.status).toBe("denied");
    expect(denied.errorCategory).toBe("permission");

    const { gate, requests } = recordingGate("allow");
    const allowed = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c2", "grep", { pattern: "alpha", path: "link" }),
    );
    expect(allowed.status).toBe("success");
    expect(allowed.content).toContain("alpha secret");
    expect(requests).toHaveLength(1);
    if (requests[0].action.type !== "read") throw new Error("expected read action");
    expect(requests[0].action.paths[0].insideWorkspace).toBe(false);
  });

  it("外部绝对路径无审批器时拒绝", async () => {
    const root = setupWorkspace();
    const outside = tempDir("shana-grep-ext-");
    fs.writeFileSync(path.join(outside, "x.txt"), "alpha outside\n");

    const denied = await makeExecutor(root).execute(call("c1", "grep", { pattern: "alpha", path: outside }));
    expect(denied.status).toBe("denied");

    const { gate } = recordingGate("allow");
    const allowed = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c2", "grep", { pattern: "alpha", path: outside }),
    );
    expect(allowed.status).toBe("success");
    expect(allowed.content).toContain("alpha outside");
  });

  it("超过匹配上限时截断并注明条数", async () => {
    const root = makeWorkspace();
    const lines = Array.from({ length: GREP_MAX_MATCHES + 50 }, (_, index) => `hit ${index}`);
    writeFileAt(root, "many.txt", `${lines.join("\n")}\n`);

    const result = await makeExecutor(root).execute(
      call("c1", "grep", { pattern: "hit", limit: GREP_MAX_MATCHES }),
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain(`[Results truncated: showing first ${GREP_MAX_MATCHES} matches.]`);
    const matchLines = result.content
      .split("\n")
      .filter((line) => line.includes(`:`) && line.includes(" hit "));
    expect(matchLines).toHaveLength(GREP_MAX_MATCHES);
  });

  it("ripgrep 二进制缺失时明确报错，不静默降级", async () => {
    const root = setupWorkspace();
    const missing = path.join(root, "no-such-rg.exe");
    const result = await makeExecutor(root, { ripgrepPath: missing }).execute(
      call("c1", "grep", { pattern: "alpha" }),
    );
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("io");
    expect(result.content).toBe("Error: Search is unavailable.");
  });
});

describe("V9 grep — 参数校验", () => {
  it("缺少 pattern、空 path、未知参数均拒绝", async () => {
    const root = setupWorkspace();
    const executor = makeExecutor(root);

    const missing = await executor.execute(call("c1", "grep", {}));
    expect(missing.status).toBe("error");
    expect(missing.content).toBe('Error: Missing required argument "pattern". Not executed.');

    const emptyPath = await executor.execute(call("c2", "grep", { pattern: "x", path: "" }));
    expect(emptyPath.content).toBe("Error: path must not be empty. Not executed.");

    const unknown = await executor.execute(call("c3", "grep", { pattern: "x", unknown: "*.ts" }));
    expect(unknown.content).toBe('Error: Unknown argument "unknown". Not executed.');
  });
});

describe("T13 grep budgets and filters", () => {
  it("filters with glob and confirms the extra match before reporting the count limit", async () => {
    const root = setupWorkspace();
    const executor = makeExecutor(root);
    const one = await executor.execute(call("f1", "grep", { pattern: "alpha", glob: "*.ts", limit: 1 }));
    expect(one.content).toBe("src/a.ts:1: const alpha = 1;");
    const more = await executor.execute(call("f2", "grep", { pattern: "alpha", limit: 1 }));
    expect(more.content).toContain("[Results truncated: showing first 1 matches.]");
  });

  it("keeps a late UTF-8 byte match and limits the escaped body to 500 code points", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "late.txt", "中".repeat(1000) + "needle" + "尾".repeat(1000));
    const result = await makeExecutor(root).execute(call("b1", "grep", { pattern: "needle" }));
    expect(result.status).toBe("success");
    expect(result.content).toContain("needle");
    expect(Array.from(result.content.slice("late.txt:1: ".length))).toHaveLength(500);
    expect(result.content).toContain("…[truncated]");
  });

  it("includes the notice in the total budget and omits whole entries", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "data.txt", Array.from({ length: 100 }, () => "a".repeat(500)).join("\n"));
    const result = await makeExecutor(root).execute(call("b2", "grep", { pattern: "a", path: "data.txt" }));
    const expected = [
      ...Array.from({ length: 46 }, (_, i) => `data.txt:${i + 1}: ${"a".repeat(500)}`),
      "[Results truncated: 24000 character limit reached.]",
    ].join("\n");
    expect(result.content).toBe(expected);
  });
});

describe("T13 grep engine", () => {
  it("reports completed zero matches", async () => {
    const root = setupWorkspace();
    const pathPolicy = createPathPolicy(root);
    const result = await searchFiles({ pattern: "nothing" }, pathPolicy.resolve("."), {
      workspaceRoot: root,
      pathPolicy,
      platform: process.platform,
    });
    expect(result.content).toBe("No matches found.");
  });
});

function fakeSearch(stdout: string, stderr: Buffer[], code: number | null = 2): void {
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    setImmediate(() => {
      child.stdout.end(stdout);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.stderr.end();
      setImmediate(() => child.emit("close", code, code === null ? "SIGTERM" : null));
    });
    return child as unknown as childProcess.ChildProcess;
  });
}

function matchEvent(text = "hit"): string {
  const file = { text: "a.txt" };
  return [
    { type: "begin", data: { path: file } },
    {
      type: "match",
      data: {
        path: file,
        line_number: 1,
        lines: { text },
        submatches: [{ start: 0, end: 3, match: { text: "hit" } }],
      },
    },
    { type: "end", data: { path: file, binary_offset: null } },
  ]
    .map((event) => JSON.stringify(event) + "\n")
    .join("");
}

describe("T13 grep failure precedence", () => {
  it("discards matches when malformed JSON is observed after the result limit", async () => {
    const root = setupWorkspace();
    fakeSearch(matchEvent() + matchEvent() + "broken\n", [], 0);
    const result = await makeExecutor(root).execute(call("e1", "grep", { pattern: "hit", limit: 1 }));
    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: Search incomplete: could not decode search output.");
  });

  it("discards matches on an error exit even when a normal limit was reached", async () => {
    const root = setupWorkspace();
    fakeSearch(matchEvent() + matchEvent(), [Buffer.from("permission failure\n")]);
    const result = await makeExecutor(root).execute(call("e2", "grep", { pattern: "hit", limit: 1 }));
    expect(result.status).toBe("error");
    expect(result.content).toBe('Error: Search incomplete: "permission failure\\n".');
  });

  it("bounds escaped diagnostics with complete head and tail Unicode across chunks", async () => {
    const root = setupWorkspace();
    const pathPolicy = createPathPolicy(root);
    const bytes = Buffer.from("HEAD\n" + "😀".repeat(100) + "\nTAIL");
    fakeSearch("", [bytes.subarray(0, 8), bytes.subarray(8, 57), bytes.subarray(57)]);
    const result = await searchFiles({ pattern: "x" }, pathPolicy.resolve("."), {
      workspaceRoot: root,
      pathPolicy,
      platform: process.platform,
      grepStderrMaxChars: 64,
    });
    expect(result.status).toBe("error");
    expect(result.content).toContain("HEAD\\n");
    expect(result.content).toContain("\\nTAIL");
    expect(result.content).toContain("…[stderr truncated]…");
    const diagnostic = result.content.slice("Error: Search incomplete: ".length, -1);
    expect(Array.from(diagnostic)).toHaveLength(64);
    expect(() => JSON.parse(diagnostic)).not.toThrow();
    expect(result.content).not.toContain("�");
  });

  it("rejects non UTF-8 match bytes without returning preceding matches", async () => {
    const root = setupWorkspace();
    const invalid = JSON.stringify({
      type: "match",
      data: { path: { text: "a.txt" }, line_number: 2, lines: { bytes: "/w==" }, submatches: [{ start: 0 }] },
    });
    fakeSearch(matchEvent() + invalid + "\n", [], 0);
    const result = await makeExecutor(root).execute(call("e3", "grep", { pattern: "hit" }));
    expect(result.content).toBe("Error: Search incomplete: could not decode search output.");
  });

  it("ignores binary files containing an apparent text hit", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "binary.dat", "hit\n\0binary");
    const result = await makeExecutor(root).execute(call("e4", "grep", { pattern: "hit" }));
    expect(result.content).toBe("No matches found.");
  });
});

it("discards early text matches when ripgrep identifies binary content later in the file", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "late-binary.dat", "MATCH\nMATCH\n" + "a".repeat(200_000) + "\n\0\n");
  const result = await makeExecutor(root).execute(
    call("binary-late", "grep", { pattern: "MATCH", limit: 1 }),
  );
  expect(result.status).toBe("success");
  expect(result.content).toBe("No matches found.");
});

it("retains the first match after a prefix whose display escapes expand", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "escaped.txt", "\t".repeat(500) + "NEEDLE");
  const result = await makeExecutor(root).execute(call("escape-window", "grep", { pattern: "NEEDLE" }));
  expect(result.status).toBe("success");
  expect(result.content).toContain("NEEDLE");
  expect(Array.from(result.content.slice("escaped.txt:1: ".length)).length).toBeLessThanOrEqual(500);
});

it("ignores undecodable early matches when the same file is later identified as binary", async () => {
  const root = makeWorkspace();
  writeFileAt(
    root,
    "invalid-binary.dat",
    Buffer.concat([
      Buffer.from("MATCH"),
      Buffer.from([0xff]),
      Buffer.from("\n" + "a".repeat(200_000) + "\n\0\n"),
    ]),
  );
  const result = await makeExecutor(root).execute(
    call("invalid-binary", "grep", { pattern: "MATCH", limit: 1 }),
  );
  expect(result.content).toBe("No matches found.");
});

it("grep delivers the original stat exception only to diagnostics", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "file.txt", "content");
  const cause = Object.assign(new Error("private internal detail"), { code: "EACCES" });
  const onDiagnostic = vi.fn();
  const executor = makeExecutor(root, { onDiagnostic });
  const spy = vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(cause);
  try {
    const result = await executor.execute(call("diag", "grep", { path: "file.txt", pattern: "content" }));
    expect(result.content).toBe("Error: Permission denied.");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "grep.stat", error: cause }));
    expect(result.content).not.toContain("private internal detail");
  } finally {
    spy.mockRestore();
  }
});

it("grep forwards stderr stream failures to diagnostics and drops partial results", async () => {
  const root = setupWorkspace();
  const cause = new Error("private stream detail");
  const onDiagnostic = vi.fn();
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    setImmediate(() => {
      child.stdout.write(matchEvent());
      child.stderr.emit("error", cause);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0, null));
    });
    return child as unknown as childProcess.ChildProcess;
  });
  const result = await makeExecutor(root, { onDiagnostic }).execute(
    call("stderr", "grep", { pattern: "hit" }),
  );
  expect(result.content).toBe("Error: Search incomplete: could not decode search output.");
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "grep.stderr", error: cause }));
});

it("grep forwards malformed output exceptions without adding the output to the result", async () => {
  const root = setupWorkspace();
  const onDiagnostic = vi.fn();
  fakeSearch("private invalid event\n", [], 0);
  const result = await makeExecutor(root, { onDiagnostic }).execute(
    call("parse", "grep", { pattern: "hit" }),
  );
  expect(result.content).toBe("Error: Search incomplete: could not decode search output.");
  expect(onDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ stage: "grep.parse", error: expect.any(SyntaxError) }),
  );
});
