import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPathPolicy } from "../../src/security/path-policy.js";
import { editFileContent } from "../../src/tools/edit.js";
import { writeFileContent } from "../../src/tools/write.js";
import {
  call,
  cleanupTempDirs,
  createDirLink,
  makeExecutor,
  makeWorkspace,
  readFileAt,
  recordingGate,
  supportsDirectoryLinks,
  tempDir,
  writeFileAt,
} from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const DIR_LINKS = supportsDirectoryLinks();

describe("confirmed write/edit semantics", () => {
  it("preserves a file created while approval is pending", async () => {
    const root = makeWorkspace();
    const executor = makeExecutor(root, {
      permissionGate: async () => {
        writeFileAt(root, "shared.txt", "concurrent content");
        return { decision: "allow" };
      },
    });
    const result = await executor.execute(call("race", "write", { path: "shared.txt", content: "new" }));
    expect(result.errorCategory).toBe("path");
    expect(readFileAt(root, "shared.txt")).toBe("concurrent content");
  });

  it("normalizes working content while retaining the original BOM snapshot", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "\uFEFFa\r\nb\rc\uFEFF");
    const result = await editFileContent(
      { path: "a.txt", oldString: "a\rb", newString: "z\r\ny", replaceAll: false },
      createPathPolicy(root).resolve("a.txt"),
    );
    expect(result.content).toBe("Successfully edited a.txt.");
    expect(result.priorContent).toBe("\uFEFFa\r\nb\rc\uFEFF");
    expect(readFileAt(root, "a.txt")).toBe("z\ny\nc\uFEFF");
  });

  it("write directly overwrites and retains an original BOM", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "\uFEFFold");
    const rename = vi.spyOn(fs.promises, "rename");
    const result = await writeFileContent(
      { path: "a.txt", content: "new\r\n" },
      createPathPolicy(root).resolve("a.txt"),
    );
    expect(result.content).toBe("Successfully wrote a.txt.");
    expect(result.priorContent).toBe("\uFEFFold");
    expect(rename).not.toHaveBeenCalled();
  });

  it("rejects identical normalized arguments before matching", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "unrelated");
    const result = await editFileContent(
      { path: "a.txt", oldString: "a\r", newString: "a\n", replaceAll: false },
      createPathPolicy(root).resolve("a.txt"),
    );
    expect(result.content).toBe(
      "Error: old_string and new_string differ only in line endings. The edit tool normalizes line endings to LF.",
    );
  });
});

describe("V3 write — 新建、覆盖与审批", () => {
  it("新建与覆盖，成功文案与字节数确定", async () => {
    const root = makeWorkspace();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const created = await executor.execute(call("c1", "write", { path: "new.txt", content: "hello" }));
    expect(created.status).toBe("success");
    expect(created.content).toBe("Successfully wrote new.txt.");
    expect(readFileAt(root, "new.txt")).toBe("hello");
    expect(requests[0].action).toMatchObject({ type: "write", operation: "create" });

    const overwritten = await executor.execute(call("c2", "write", { path: "new.txt", content: "bye" }));
    expect(overwritten.content).toBe("Successfully wrote new.txt.");
    expect(readFileAt(root, "new.txt")).toBe("bye");
    expect(requests[1].action).toMatchObject({ type: "write", operation: "overwrite" });
  });

  it("空内容与 UTF-8 字节数按实际编码计算", async () => {
    const root = makeWorkspace();
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const empty = await executor.execute(call("c1", "write", { path: "empty.txt", content: "" }));
    expect(empty.content).toBe("Successfully wrote empty.txt.");
    expect(readFileAt(root, "empty.txt")).toBe("");

    const chinese = await executor.execute(call("c2", "write", { path: "cn.txt", content: "你好" }));
    expect(chinese.content).toBe("Successfully wrote cn.txt.");
    expect(readFileAt(root, "cn.txt")).toBe("你好");
  });

  it("父目录缺失与目录目标明确报错", async () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, "dir"));
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const missingParent = await executor.execute(
      call("c1", "write", { path: "missing/new.txt", content: "x" }),
    );
    expect(missingParent.status).toBe("error");
    expect(missingParent.errorCategory).toBe("io");
    expect(missingParent.content).toContain("Parent directory not found.");

    const directory = await executor.execute(call("c2", "write", { path: "dir", content: "x" }));
    expect(directory.status).toBe("error");
    expect(directory.content).toContain("Path is a directory.");
  });

  it("写入成功后不残留临时文件", async () => {
    const root = makeWorkspace();
    const { gate } = recordingGate("allow");
    await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "write", { path: "a.txt", content: "x" }),
    );
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".shana-write-"))).toEqual([]);
  });

  it("无审批器时拒绝写入且不落盘，拒绝结果确定", async () => {
    const root = makeWorkspace();
    const result = await makeExecutor(root).execute(call("c1", "write", { path: "new.txt", content: "x" }));
    expect(result.status).toBe("denied");
    expect(result.errorCategory).toBe("permission");
    expect(result.content).toBe("Error: Internal error. Stop and ask user.");
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("外部写入只发起一次综合审批，携带规范化真实路径与操作", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-write-out-");
    const outsideFile = path.join(outside, "x.txt");
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("call-9", "write", { path: outsideFile, content: "out" }));

    expect(result.status).toBe("success");
    expect(readFileAt(outside, "x.txt")).toBe("out");
    expect(requests).toHaveLength(1);
    expect(requests[0].toolCallId).toBe("call-9");
    if (requests[0].action.type !== "write") throw new Error("expected write action");
    expect(requests[0].action.operation).toBe("create");
    expect(requests[0].action.path.insideWorkspace).toBe(false);
    expect(requests[0].action.path.realPath).toBe(path.join(fs.realpathSync.native(outside), "x.txt"));
  });

  it("经由区内链接写入区外时按外部审批，批准后写入真实目标", async () => {
    if (!DIR_LINKS) return;
    const root = makeWorkspace();
    const outside = tempDir("shana-write-out-");
    createDirLink(outside, path.join(root, "link"));

    const denied = await makeExecutor(root).execute(
      call("c1", "write", { path: "link/y.txt", content: "y" }),
    );
    expect(denied.status).toBe("denied");
    expect(fs.existsSync(path.join(outside, "y.txt"))).toBe(false);

    const { gate } = recordingGate("allow");
    const allowed = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c2", "write", { path: "link/y.txt", content: "y" }),
    );
    expect(allowed.status).toBe("success");
    expect(readFileAt(outside, "y.txt")).toBe("y");
  });
});

describe("V10 写入前快照捕获与 UTF-8 ground rule", () => {
  it("write 覆盖成功时携带写入前全量快照，新建文件快照为空串", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "old line 1\nold line 2\n");
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const overwritten = await executor.execute(call("c1", "write", { path: "file.ts", content: "new" }));
    expect(overwritten.status).toBe("success");
    expect(overwritten.priorContent).toBe("old line 1\nold line 2\n");
    expect(readFileAt(root, "file.ts")).toBe("new");

    const created = await executor.execute(call("c2", "write", { path: "created.txt", content: "x" }));
    expect(created.priorContent).toBe("");
    expect(readFileAt(root, "created.txt")).toBe("x");
  });

  it("edit 成功时携带写入前全量快照（编辑前完整内容）", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "const a = 1;\nconst b = 2;\n");
    const { gate } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: "file.ts", old_string: "const a = 1;", new_string: "const a = 9;" }),
    );

    expect(result.status).toBe("success");
    expect(result.priorContent).toBe("const a = 1;\nconst b = 2;\n");
    expect(readFileAt(root, "file.ts")).toBe("const a = 9;\nconst b = 2;\n");
  });

  it("快照捕获失败即 error 且不写入：目标为无效 UTF-8", async () => {
    const root = makeWorkspace();
    const bytes = Buffer.from([0xff, 0xfe, 0x61]);
    writeFileAt(root, "bad.bin", bytes);
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("c1", "write", { path: "bad.bin", content: "new" }));
    expect(result.status).toBe("error");
    expect(result.content).toContain("File is not supported text; expected UTF-8 without NUL.");
    expect(fs.readFileSync(path.join(root, "bad.bin"))).toEqual(bytes);
  });

  it("POSIX 无读权限触发捕获失败即 error 且不写入", async () => {
    if (process.platform === "win32") return;
    const root = makeWorkspace();
    writeFileAt(root, "locked.txt", "old");
    fs.chmodSync(path.join(root, "locked.txt"), 0o000);
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("c1", "write", { path: "locked.txt", content: "new" }));
    expect(result.status).toBe("error");
    fs.chmodSync(path.join(root, "locked.txt"), 0o600);
    expect(readFileAt(root, "locked.txt")).toBe("old");
  });

  it("edit 目标为无效 UTF-8 时按二进制拒绝且不改动", async () => {
    const root = makeWorkspace();
    const bytes = Buffer.from([0x61, 0xff, 0x62]);
    writeFileAt(root, "bad.txt", bytes);
    const { gate } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: "bad.txt", old_string: "a", new_string: "z" }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toContain("File is not supported text; expected UTF-8 without NUL.");
    expect(fs.readFileSync(path.join(root, "bad.txt"))).toEqual(bytes);
  });
});

describe("V3 edit — 精确替换与 replace_all", () => {
  it("单次精确替换，保持其余内容不变", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "const a = 1;\nconst b = 2;\n");
    const { gate, requests } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: "file.ts", old_string: "const a = 1;", new_string: "const a = 9;" }),
    );

    expect(result.status).toBe("success");
    expect(result.content).toBe("Successfully edited file.ts.");
    expect(readFileAt(root, "file.ts")).toBe("const a = 9;\nconst b = 2;\n");
    if (requests[0].action.type !== "write") throw new Error("expected write action");
    expect(requests[0].action.operation).toBe("edit");
  });

  it("多处匹配且未开启 replace_all 时返回数量，不猜测替换位置", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "x x x");
    const { gate } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: "file.ts", old_string: "x", new_string: "y" }),
    );

    expect(result.status).toBe("error");
    expect(result.content).toContain("3 non-overlapping matches");
    expect(result.content).toContain("replace_all");
    expect(readFileAt(root, "file.ts")).toBe("x x x");
  });

  it("replace_all 全部替换", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "x x x");
    const { gate } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", {
        path: "file.ts",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      }),
    );

    expect(result.status).toBe("success");
    expect(result.content).toBe("Successfully edited file.ts (3 replacements).");
    expect(readFileAt(root, "file.ts")).toBe("y y y");
  });

  it("无匹配、文件缺失、目录与二进制均明确报错", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "abc");
    writeFileAt(root, "binary.bin", Buffer.from([0x61, 0x00, 0x62]));
    fs.mkdirSync(path.join(root, "dir"));
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const none = await executor.execute(
      call("c1", "edit", { path: "file.ts", old_string: "zz", new_string: "y" }),
    );
    expect(none.status).toBe("error");
    expect(none.content).toContain("old_string not found");

    const missing = await executor.execute(
      call("c2", "edit", { path: "nope.ts", old_string: "a", new_string: "b" }),
    );
    expect(missing.content).toContain("File not found");

    const directory = await executor.execute(
      call("c3", "edit", { path: "dir", old_string: "a", new_string: "b" }),
    );
    expect(directory.content).toContain("Path is a directory.");

    const binary = await executor.execute(
      call("c4", "edit", { path: "binary.bin", old_string: "a", new_string: "b" }),
    );
    expect(binary.content).toContain("File is not supported text; expected UTF-8 without NUL.");
    expect(readFileAt(root, "file.ts")).toBe("abc");
  });

  it("成功编辑统一 LF 换行", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "crlf.txt", "a\r\nb\r\n");
    const { gate } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: "crlf.txt", old_string: "a", new_string: "z" }),
    );

    expect(result.status).toBe("success");
    expect(readFileAt(root, "crlf.txt")).toBe("z\nb\n");
  });

  it("无审批器时内部编辑同样被拒绝且文件不变", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "abc");
    const result = await makeExecutor(root).execute(
      call("c1", "edit", { path: "file.ts", old_string: "a", new_string: "z" }),
    );
    expect(result.status).toBe("denied");
    expect(readFileAt(root, "file.ts")).toBe("abc");
  });

  it("外部编辑经审批后执行", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-edit-out-");
    const outsideFile = path.join(outside, "x.txt");
    fs.writeFileSync(outsideFile, "old-content");
    const { gate, requests } = recordingGate("allow");

    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "edit", { path: outsideFile, old_string: "old", new_string: "new" }),
    );

    expect(result.status).toBe("success");
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("new-content");
    expect(requests).toHaveLength(1);
    if (requests[0].action.type !== "write") throw new Error("expected write action");
    expect(requests[0].action.path.insideWorkspace).toBe(false);
  });

  it("空 old_string、未知参数、非布尔 replace_all 均拒绝", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "file.ts", "abc");
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const empty = await executor.execute(
      call("c1", "edit", { path: "file.ts", old_string: "", new_string: "x" }),
    );
    expect(empty.content).toBe("Error: old_string must not be empty. Not executed.");

    const unknown = await executor.execute(
      call("c2", "edit", { path: "file.ts", old_string: "a", new_string: "b", regex: true }),
    );
    expect(unknown.content).toBe('Error: Unknown argument "regex". Not executed.');

    const replaceAll = await executor.execute(
      call("c3", "edit", { path: "file.ts", old_string: "a", new_string: "b", replace_all: "yes" }),
    );
    expect(replaceAll.content).toBe("Error: replace_all must be a boolean. Not executed.");

    expect(requests).toHaveLength(0);
    expect(readFileAt(root, "file.ts")).toBe("abc");
  });
});

describe("edit commit boundaries and file faults", () => {
  function setup(content = "old") {
    const root = makeWorkspace();
    const file = writeFileAt(root, "a.txt", content);
    const target = createPathPolicy(root).resolve("a.txt");
    const args = { path: "a.txt", oldString: "old", newString: "new", replaceAll: false };
    return { root, file, target, args };
  }

  it.each(["open", "writeFile", "sync", "close", "rename"])(
    "%s failure never commits or exposes implementation details",
    async (stage) => {
      const { root, target, args } = setup();
      const fault = Object.assign(new Error("private details"), { code: "ENOSPC" });
      const originalOpen = fs.promises.open.bind(fs.promises);
      const rename = vi.spyOn(fs.promises, "rename");
      if (stage === "rename") rename.mockRejectedValueOnce(fault);
      vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
        if (stage === "open") throw fault;
        const handle = await originalOpen(...params);
        if (stage === "writeFile" || stage === "sync") vi.spyOn(handle, stage).mockRejectedValueOnce(fault);
        if (stage === "close") {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementationOnce(async () => {
            await close();
            throw fault;
          });
        }
        return handle;
      });
      const result = await editFileContent(args, target);
      expect(result.content).toBe("Error: No space left on device.");
      expect(readFileAt(root, "a.txt")).toBe("old");
      expect(fs.readdirSync(root)).toEqual(["a.txt"]);
      if (stage !== "rename") expect(rename).not.toHaveBeenCalled();
    },
  );

  it("waits for writes, syncs, closes, then commits within the target directory", async () => {
    const { root, target, args } = setup();
    const events: string[] = [];
    const originalOpen = fs.promises.open.bind(fs.promises);
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
      expect(path.dirname(String(params[0]))).toBe(root);
      events.push("open");
      const handle = await originalOpen(...params);
      for (const method of ["writeFile", "sync", "close"] as const) {
        const original = handle[method].bind(handle);
        vi.spyOn(handle, method).mockImplementation(async (...values: never[]) => {
          events.push(method);
          return (original as (...args: never[]) => Promise<void>)(...values);
        });
      }
      return handle;
    });
    vi.spyOn(fs.promises, "rename").mockImplementation(async (...params) => {
      events.push("rename");
      return originalRename(...params);
    });
    expect((await editFileContent(args, target)).status).toBe("success");
    expect(events).toEqual(["open", "writeFile", "sync", "close", "rename"]);
  });

  it("cleans up cancellation after write but before rename", async () => {
    const { root, target, args } = setup();
    const controller = new AbortController();
    const originalOpen = fs.promises.open.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename");
    vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
      const handle = await originalOpen(...params);
      const original = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...values) => {
        await original(...values);
        controller.abort();
      });
      return handle;
    });
    const result = await editFileContent(args, target, { signal: controller.signal });
    expect(result).toMatchObject({
      status: "not_executed",
      category: "cancelled",
      content: "Error: Cancelled by user.",
    });
    expect(rename).not.toHaveBeenCalled();
    expect(readFileAt(root, "a.txt")).toBe("old");
    expect(fs.readdirSync(root)).toEqual(["a.txt"]);
  });

  it("write cancelled before opening the file reports not_executed and leaves it untouched", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "old");
    const target = createPathPolicy(root).resolve("a.txt");
    const controller = new AbortController();
    controller.abort();
    const result = await writeFileContent({ path: "a.txt", content: "new" }, target, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({
      status: "not_executed",
      category: "cancelled",
      content: "Error: Cancelled by user.",
    });
    expect(readFileAt(root, "a.txt")).toBe("old");
  });

  it("keeps success after rename has started even when cancellation arrives", async () => {
    const { root, target, args } = setup();
    const controller = new AbortController();
    const originalRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, "rename").mockImplementation(async (...params) => {
      controller.abort();
      await originalRename(...params);
    });
    expect((await editFileContent(args, target, { signal: controller.signal })).status).toBe("success");
    expect(readFileAt(root, "a.txt")).toBe("new");
  });

  it("retains the primary failure while reporting a residual temporary file only to hooks", async () => {
    const { root, target, args } = setup();
    const warnings: string[] = [];
    const diagnostics: unknown[] = [];
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("private"), { code: "EROFS" }),
    );
    vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("private"), { code: "EPERM" }),
    );
    const result = await editFileContent(args, target, {
      onCleanupWarning: (p) => warnings.push(p),
      onDiagnostic: (e) => diagnostics.push(e),
    });
    expect(result.content).toBe("Error: Read-only file system.");
    expect(warnings).toHaveLength(1);
    expect(fs.existsSync(warnings[0]!)).toBe(true);
    expect(path.dirname(warnings[0]!)).toBe(root);
    expect(JSON.stringify(diagnostics)).not.toContain("private");
    expect(readFileAt(root, "a.txt")).toBe("old");
  });

  it("applies one inclusive byte budget to both original and resulting content", async () => {
    const { root, target, args } = setup("éé");
    const open = vi.spyOn(fs.promises, "open");
    const overOriginal = await editFileContent(
      { ...args, oldString: "é", newString: "a", replaceAll: true },
      target,
      { editMaxFileBytes: 3 },
    );
    expect(overOriginal.content).toBe("Error: Existing file exceeds the 3-byte limit.");
    const overResult = await editFileContent(
      { ...args, oldString: "é", newString: "中", replaceAll: true },
      target,
      { editMaxFileBytes: 4 },
    );
    expect(overResult.content).toBe("Error: Resulting file exceeds the 4-byte limit.");
    expect(open).not.toHaveBeenCalled();
    const boundary = await editFileContent(
      { ...args, oldString: "é", newString: "ab", replaceAll: true },
      target,
      { editMaxFileBytes: 4 },
    );
    expect(boundary.status).toBe("success");
    expect(readFileAt(root, "a.txt")).toBe("abab");
  });

  it("counts non-overlapping matches, allows literal replacement metacharacters, and strips final BOM", async () => {
    const { root, target, args } = setup("aaa");
    const result = await editFileContent(
      { ...args, oldString: "aa", newString: "\uFEFF$&", replaceAll: true },
      target,
    );
    expect(result.content).toBe("Successfully edited a.txt (1 replacement).");
    expect(readFileAt(root, "a.txt")).toBe("$&a");
  });

  it.each([
    ["\uD800", "invalid Unicode"],
    ["\0", "NUL characters"],
  ])("rejects %s before any I/O", async (content, reason) => {
    const { target, args } = setup();
    const open = vi.spyOn(fs.promises, "open");
    expect((await writeFileContent({ path: "a.txt", content: content! }, target)).content).toBe(
      `Error: content contains ${reason}.`,
    );
    expect((await editFileContent({ ...args, newString: content! }, target)).content).toBe(
      `Error: new_string contains ${reason}.`,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("counts astral characters as code points", async () => {
    const { target, args } = setup();
    const result = await editFileContent({ ...args, newString: "😀".repeat(100_000) }, target);
    expect(result.status).toBe("success");
    const over = await editFileContent({ ...args, newString: "😀".repeat(100_001) }, target);
    expect(over.content).toBe("Error: new_string exceeds the 100,000-character limit.");
  });

  it("write failures after I/O begins request user intervention once", async () => {
    const { target } = setup();
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
      const handle = await originalOpen(...params);
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(
        Object.assign(new Error("private"), { code: "ENOSPC" }),
      );
      return handle;
    });
    expect((await writeFileContent({ path: "a.txt", content: "new" }, target)).content).toBe(
      "Error: No space left on device. Stop and ask user.",
    );
  });

  it("write open failures do not claim that overwriting began", async () => {
    const { target } = setup();
    vi.spyOn(fs.promises, "open").mockRejectedValueOnce(
      Object.assign(new Error("private"), { code: "EACCES" }),
    );
    expect((await writeFileContent({ path: "a.txt", content: "new" }, target)).content).toBe(
      "Error: Permission denied.",
    );
  });

  it.skipIf(process.platform === "win32")("preserves POSIX permission bits", async () => {
    const { file, target, args } = setup();
    await fs.promises.chmod(file, 0o751);
    expect((await editFileContent(args, target)).status).toBe("success");
    expect((await fs.promises.stat(file)).mode & 0o7777).toBe(0o751);
  });

  it.each(["chmod", "stat", "mismatch"])("POSIX permission %s failures prevent commit", async (stage) => {
    const { root, target, args } = setup();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const originalOpen = fs.promises.open.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename");
    vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
      const handle = await originalOpen(...params);
      vi.spyOn(handle, "chmod").mockImplementation(async () => {
        if (stage === "chmod") throw Object.assign(new Error(), { code: "EACCES" });
      });
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        if (stage === "stat") throw Object.assign(new Error(), { code: "EACCES" });
        return { mode: 0 } as fs.Stats;
      });
      return handle;
    });
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      const result = await editFileContent(args, target);
      expect(result.content).toBe("Error: Permission denied.");
      expect(rename).not.toHaveBeenCalled();
      expect(fs.readdirSync(root)).toEqual(["a.txt"]);
      expect(readFileAt(root, "a.txt")).toBe("old");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });

  it("a failed cleanup retains cancellation and exposes its path only to warning hooks", async () => {
    const { target, args } = setup();
    const controller = new AbortController();
    const warnings: string[] = [];
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (...params) => {
      const handle = await originalOpen(...params);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        controller.abort();
      });
      return handle;
    });
    vi.spyOn(fs.promises, "unlink").mockRejectedValueOnce(Object.assign(new Error(), { code: "EPERM" }));
    expect(
      (
        await editFileContent(args, target, {
          signal: controller.signal,
          onCleanupWarning: (p) => warnings.push(p),
        })
      ).content,
    ).toBe("Error: Cancelled by user.");
    expect(warnings).toHaveLength(1);
    expect(fs.existsSync(warnings[0]!)).toBe(true);
  });

  it("measures a concurrently grown original with bounded reads", async () => {
    const { target, args } = setup("old".repeat(1000));
    const originalStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(async (...params) => {
      const stats = await originalStat(...params);
      return Object.assign(stats, { size: 3 });
    });
    const readFile = vi.spyOn(fs.promises, "readFile");
    const createStream = vi.spyOn(fs, "createReadStream");
    const result = await editFileContent(args, target, { editMaxFileBytes: 3 });
    expect(result.content).toBe("Error: Existing file exceeds the 3-byte limit.");
    expect(readFile).not.toHaveBeenCalled();
    expect(createStream).toHaveBeenCalledWith(target.realPath, { start: 0, end: 3 });
    expect(createStream.mock.results[0]!.value.bytesRead).toBe(4);
  });

  it("rejects an expanding result before replacement construction", async () => {
    const { target, args } = setup("oldoldold");
    const split = vi.spyOn(String.prototype, "split");
    const replaceAll = vi.spyOn(String.prototype, "replaceAll");
    const result = await editFileContent(
      { ...args, newString: "x".repeat(100_000), replaceAll: true },
      target,
      { editMaxFileBytes: 9 },
    );
    expect(result.content).toBe("Error: Resulting file exceeds the 9-byte limit.");
    expect(split.mock.calls.some((args) => args[0] === "old")).toBe(false);
    expect(replaceAll.mock.calls.some((args) => args[0] === "old")).toBe(false);
  });

  it("uses final BOM removal when predicting the inclusive result budget", async () => {
    const { root, target, args } = setup("aa");
    const result = await editFileContent({ ...args, oldString: "aa", newString: "\uFEFFab" }, target, {
      editMaxFileBytes: 2,
    });
    expect(result.status).toBe("success");
    expect(readFileAt(root, "a.txt")).toBe("ab");
    writeFileAt(root, "a.txt", "aa\uFEFF");
    const deletion = await editFileContent(
      { ...args, oldString: "a", newString: "", replaceAll: true },
      target,
      { editMaxFileBytes: 5 },
    );
    expect(deletion.status).toBe("success");
    expect(readFileAt(root, "a.txt")).toBe("");
  });
});
