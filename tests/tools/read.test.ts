import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import { readFileRange, validateReadPathBudget, READ_MAX_LIMIT } from "../../src/tools/read.js";
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

afterEach(cleanupTempDirs);

const DIR_LINKS = supportsDirectoryLinks();

describe("V1 read — 行范围与错误分类", () => {
  it("默认按行读取并带行号前缀", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "basic.txt", "alpha\nbeta\ngamma\n");
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "basic.txt" }));

    expect(result.status).toBe("success");
    expect(result.content).toBe(
      "<path>basic.txt</path>\n<content>\n1: alpha\n2: beta\n3: gamma\n</content>\n(Showing lines 1-3; end of file.)",
    );
  });

  it("offset/limit 按 1 起始行号截取", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "basic.txt", "alpha\nbeta\ngamma\n");
    const result = await makeExecutor(root).execute(
      call("c1", "read", { path: "basic.txt", offset: 2, limit: 1 }),
    );

    expect(result.content).toBe(
      "<path>basic.txt</path>\n<content>\n2: beta\n</content>\n(Showing lines 2-2; line limit reached. Use offset=3 to continue.)",
    );
  });

  it("offset 超出文件末尾给出确定提示", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "basic.txt", "alpha\nbeta\n");
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "basic.txt", offset: 10 }));

    expect(result.status).toBe("success");
    expect(result.content).toContain("No line 10; file has 2 lines.");
    expect(result.content).toContain("2 lines");
  });

  it("空文件返回确定占位", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "empty.txt", "");
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "empty.txt" }));

    expect(result.status).toBe("success");
    expect(result.content).toBe("<path>empty.txt</path>\n<content>\n</content>\n(Empty file.)");
  });

  it("不存在、目录、二进制均返回可区分的 Error", async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, "dir"));
    writeFileAt(root, "binary.bin", Buffer.from([0x61, 0x00, 0x62]));
    const executor = makeExecutor(root);

    const missing = await executor.execute(call("c1", "read", { path: "nope.txt" }));
    expect(missing.status).toBe("error");
    expect(missing.errorCategory).toBe("io");
    expect(missing.content.startsWith("Error: ")).toBe(true);
    expect(missing.content).toBe("Error: File not found.");

    const directory = await executor.execute(call("c2", "read", { path: "dir" }));
    expect(directory.status).toBe("error");
    expect(directory.content).toBe("Error: Path is a directory.");

    const binary = await executor.execute(call("c3", "read", { path: "binary.bin" }));
    expect(binary.status).toBe("error");
    expect(binary.content).toBe("Error: File is not supported text; expected UTF-8 without NUL.");
  });

  it("超长行按确定规则裁剪并标记", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "long.txt", `${"x".repeat(2100)}\nnext\n`);
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "long.txt", limit: 1 }));

    expect(result.status).toBe("success");
    expect(result.content).toContain("x".repeat(2000));
    expect(result.content).toContain("…[truncated]");
    expect(result.content).toContain("line limit reached");
    expect(result.content).not.toContain("x".repeat(2001));
  });

  it("超大输出按总字符上限裁剪，裁剪结果即最终内容", async () => {
    const root = makeWorkspace();
    const lines = Array.from({ length: 120 }, (_, index) => `${index}:${"y".repeat(1000)}`);
    writeFileAt(root, "big.txt", lines.join("\n"));
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "big.txt" }));

    expect(result.status).toBe("success");
    expect(result.content).toContain("char limit reached");
    const renderedLines = result.content.split("\n").filter((line) => /^\d+:/.test(line));
    expect(renderedLines.length).toBeLessThan(120);
    expect(result.content.length).toBeLessThanOrEqual(24_000);
  });

  it("区内链接文件通过真实路径读取，无需审批", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const real = path.join(root, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "a.txt"), "linked-content");
    createDirLink(real, path.join(root, "link"));
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "link/a.txt" }));

    expect(result.status).toBe("success");
    expect(result.content).toContain("linked-content");
  });

  it("外部文件无审批器时拒绝读取", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-external-");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "top-secret");

    const denied = await makeExecutor(root).execute(call("c1", "read", { path: outsideFile }));
    expect(denied.status).toBe("denied");
    expect(denied.errorCategory).toBe("permission");
    expect(denied.content).toBe("Error: Internal error. Stop and ask user.");
  });

  it("外部文件经审批后读取，审批请求携带规范化真实路径", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-external-");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "top-secret");
    const { gate, requests } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("call-7", "read", { path: outsideFile }),
    );

    expect(result.status).toBe("success");
    expect(result.content).toContain("top-secret");
    expect(requests).toHaveLength(1);
    expect(requests[0].toolCallId).toBe("call-7");
    expect(requests[0].toolName).toBe("read");
    if (requests[0].action.type !== "read") throw new Error("expected read action");
    expect(requests[0].action.paths[0].insideWorkspace).toBe(false);
    expect(requests[0].action.paths[0].realPath).toBe(fs.realpathSync.native(outsideFile));
  });
});

describe("V9 read — 参数校验", () => {
  it("limit 超上限、非正整数、未知参数、NUL 均拒绝", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "a");
    const executor = makeExecutor(root);

    const tooLarge = await executor.execute(call("c1", "read", { path: "a.txt", limit: READ_MAX_LIMIT + 1 }));
    expect(tooLarge.status).toBe("error");
    expect(tooLarge.errorCategory).toBe("arguments");
    expect(tooLarge.content).toBe(`Error: limit must be between 1 and ${READ_MAX_LIMIT}. Not executed.`);

    const zero = await executor.execute(call("c2", "read", { path: "a.txt", limit: 0 }));
    expect(zero.content).toBe("Error: limit must be a positive integer. Not executed.");

    const unknown = await executor.execute(call("c3", "read", { path: "a.txt", mode: "binary" }));
    expect(unknown.content).toBe('Error: Unknown argument "mode". Not executed.');

    const nul = await executor.execute(call("c4", "read", { path: "a\0b.txt" }));
    expect(nul.content).toBe("Error: path contains NUL characters. Not executed.");

    const missing = await executor.execute(call("c5", "read", {}));
    expect(missing.content).toBe('Error: Missing required argument "path". Not executed.');
  });

  it("参数错误发生在权限与执行之前，审批器不被调用", async () => {
    const root = makeWorkspace();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("c1", "read", { path: "a.txt", limit: 1.5 }));
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("arguments");
    expect(requests).toHaveLength(0);
  });
});

describe("UTF-8 ground rule", () => {
  it("无效 UTF-8 按二进制拒绝，不做替换字符降级", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "bad.txt", Buffer.from([0x61, 0xff, 0x62]));
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "bad.txt" }));

    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: File is not supported text; expected UTF-8 without NUL.");
    expect(result.content).not.toContain("�");
  });

  it("无效 UTF-8 位于文件尾部时流式读取同样拒绝", async () => {
    const root = makeWorkspace();
    const body = Buffer.concat([Buffer.from("ok line\n".repeat(1000)), Buffer.from([0xff])]);
    writeFileAt(root, "late-bad.txt", body);
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "late-bad.txt" }));

    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: File is not supported text; expected UTF-8 without NUL.");
  });

  it("含 NUL 的合法 UTF-8 仍按二进制拒绝", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "nul.txt", Buffer.from([0x61, 0x00, 0x62]));
    const result = await makeExecutor(root).execute(call("c1", "read", { path: "nul.txt" }));

    expect(result.status).toBe("error");
    expect(result.content).toBe("Error: File is not supported text; expected UTF-8 without NUL.");
  });
});

describe("T13 read engine", () => {
  it("reports EOF at an exact limit and counts Unicode code points without breaking characters", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "unicode.txt", "😀".repeat(2001));
    const result = await readFileRange(
      { path: "unicode.txt", offset: 1, limit: 1 },
      createPathPolicy(root).resolve("unicode.txt"),
    );
    expect(result.content).toBe(
      `<path>unicode.txt</path>\n<content>\n1: ${"😀".repeat(2000)}…[truncated]\n</content>\n(Showing lines 1-1; end of file. 1 line truncated.)`,
    );
  });
});

describe("T13 read scope and budget", () => {
  it("does not validate unread lines beyond the requested continuation", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "partial.txt", Buffer.concat([Buffer.from("first\nsecond\n"), Buffer.from([0xff])]));
    const result = await makeExecutor(root).execute(call("r1", "read", { path: "partial.txt", limit: 1 }));
    expect(result.status).toBe("success");
    expect(result.content).toContain("Use offset=2 to continue.");
  });

  it("discards collected content when a skipped line contains NUL", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "nul-before.txt", "bad\0\nrequested");
    const result = await makeExecutor(root).execute(
      call("r2", "read", { path: "nul-before.txt", offset: 2 }),
    );
    expect(result.content).toBe("Error: File is not supported text; expected UTF-8 without NUL.");
  });

  it("includes the wrapper and continuation status in the exact character budget example", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "data.txt", Array.from({ length: 12 }, () => "a".repeat(2000)).join("\n"));
    const result = await makeExecutor(root).execute(call("r3", "read", { path: "data.txt" }));
    expect(result.content).toBe(
      [
        "<path>data.txt</path>",
        "<content>",
        ...Array.from({ length: 11 }, (_, i) => `${i + 1}: ${"a".repeat(2000)}`),
        "</content>",
        "(Showing lines 1-11; char limit reached. Use offset=12 to continue.)",
      ].join("\n"),
    );
  });
});

it("rejects paths whose escaped wrapper exceeds the total budget before accessing the filesystem", async () => {
  const root = makeWorkspace();
  const result = await makeExecutor(root).execute(call("long-path", "read", { path: "\t".repeat(12_000) }));
  expect(result.content).toBe("Error: path is too long. Not executed.");
});

it("applies the path guard at the escaped output budget boundary", () => {
  expect(validateReadPathBudget({ path: "a".repeat(23_881), offset: 1, limit: 1 })).toBeUndefined();
  expect(validateReadPathBudget({ path: "a".repeat(23_882), offset: 1, limit: 1 })).toBe(
    "path is too long. Not executed.",
  );
  expect(validateReadPathBudget({ path: "\t".repeat(11_940) + "a", offset: 1, limit: 1 })).toBeUndefined();
  expect(validateReadPathBudget({ path: "\t".repeat(11_941), offset: 1, limit: 1 })).toBe(
    "path is too long. Not executed.",
  );
});

it("read delivers the original stat exception only to diagnostics", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "file.txt", "content");
  const cause = Object.assign(new Error("private internal detail"), { code: "EACCES" });
  const onDiagnostic = vi.fn();
  const executor = makeExecutor(root, { onDiagnostic });
  const spy = vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(cause);
  try {
    const result = await executor.execute(call("diag", "read", { path: "file.txt" }));
    expect(result.content).toBe("Error: Permission denied.");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "read.stat", error: cause }));
    expect(result.content).not.toContain("private internal detail");
  } finally {
    spy.mockRestore();
  }
});

it("a failing diagnostic sink cannot replace a read failure", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "file.txt", "content");
  const spy = vi
    .spyOn(fs.promises, "stat")
    .mockRejectedValueOnce(Object.assign(new Error("IO"), { code: "EACCES" }));
  try {
    const result = await makeExecutor(root, {
      onDiagnostic: () => {
        throw new Error("log unavailable");
      },
    }).execute(call("sink", "read", { path: "file.txt" }));
    expect(result.content).toBe("Error: Permission denied.");
  } finally {
    spy.mockRestore();
  }
});
