import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolExecutor,
  type ToolPermissionDecision,
  type ToolPermissionGate,
} from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { detectShell } from "../../src/tools/shell.js";
import {
  call,
  cleanupTempDirs,
  fakeShellRun,
  gateDecision,
  makeExecutor,
  makeWorkspace,
  readFileAt,
  recordingGate,
  tempDir,
  tick,
  writeFileAt,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const shellName = detectShell(process.platform).kind;

describe("V9 静态注册表与参数校验", () => {
  it("rejects out-of-range numbers before approval without echoing raw parameters", async () => {
    const { gate, requests } = recordingGate("allow");
    const result = await makeExecutor(makeWorkspace(), { permissionGate: gate }).execute({
      type: "toolCall",
      id: "overflow",
      name: "write",
      rawArguments: '{"secret":"synthetic","n":1e400}',
      parse: { status: "invalid", error: "non_finite_number" },
    });
    expect(result.content).toBe("Error: Argument number is out of range. Not executed. Use a finite number.");
    expect(requests).toEqual([]);
  });
  it("六件工具静态注册，参数与描述采用确认规格", () => {
    const executor = makeExecutor(makeWorkspace());
    expect(executor.registry.names()).toEqual(["read", "glob", "grep", "write", "edit", shellName]);
    for (const tool of executor.registry.list()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    expect(executor.registry.get("shell")).toBeUndefined();
  });

  it("imageInput=true 注册七件（view_image 末位），成功透传 images、错误不带", async () => {
    const root = makeWorkspace();
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(2, 16);
    png.writeUInt32BE(1, 20);
    writeFileAt(root, "a.png", png);
    const vision = makeExecutor(root, { imageInput: true });
    expect(vision.registry.names()).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      shellName,
      "view_image",
    ]);
    const ok = await vision.execute(call("c1", "view_image", { path: "a.png" }));
    expect(ok.status).toBe("success");
    expect(ok.images).toEqual([
      { data: png.toString("base64"), mimeType: "image/png", width: 2, height: 1 },
    ]);
    const bad = await vision.execute(call("c2", "view_image", { path: "missing.png" }));
    expect(bad.status).toBe("error");
    expect(bad.images).toBeUndefined();
  });

  it("重复注册被拒绝", () => {
    const registry = makeExecutor(makeWorkspace()).registry;
    const tool = registry.get("read");
    if (!tool) throw new Error("read tool missing");
    expect(() => new ToolRegistry([tool, tool])).toThrow(/duplicate tool registration/);
  });

  it("argumentsError 与未知工具在权限检查前拒绝", async () => {
    const root = makeWorkspace();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const incomplete = await executor.execute({
      id: "c1",
      name: "write",
      type: "toolCall",
      rawArguments: '{"path":',
      parse: { status: "invalid", error: "incomplete" },
    });
    expect(incomplete.status).toBe("error");
    expect(incomplete.errorCategory).toBe("arguments");
    expect(incomplete.content).toBe("Error: Incomplete arguments JSON. Not executed. Resend complete JSON.");

    const unknown = await executor.execute(call("c2", "browse", { url: "x" }));
    expect(unknown.status).toBe("error");
    expect(unknown.errorCategory).toBe("unknown_tool");
    expect(unknown.content).toBe('Error: Unknown tool "browse". Not executed.');

    expect(requests).toHaveLength(0);
  });

  it("非法参数在审批与执行前拒绝，权限钩子不被调用", async () => {
    const root = makeWorkspace();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(
      call("c1", "write", { path: "a.txt", content: "x", mode: "append" }),
    );
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("arguments");
    expect(result.content).toBe('Error: Unknown argument "mode". Not executed.');
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("工具配置在构造时严格校验", () => {
    const root = makeWorkspace();
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new ToolExecutor({
            workspaceRoot: root,
            settings: {
              editMaxFileBytes: value,
              viewImageMaxBytes: 5242880,
              globTimeoutMs: 30000,
              grepStderrMaxChars: 4000,
            },
          }),
      ).toThrow(/editMaxFileBytes/);
    }
  });
});

describe("权限钩子 — 默认策略与外部路径", () => {
  it("区内只读工具默认放行，无需审批器", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "hello");
    const executor = makeExecutor(root);

    const read = await executor.execute(call("c1", "read", { path: "a.txt" }));
    expect(read.status).toBe("success");

    const glob = await executor.execute(call("c2", "glob", { pattern: "*.txt" }));
    expect(glob.status).toBe("success");
    expect(glob.content).toContain("a.txt");

    const grep = await executor.execute(call("c3", "grep", { pattern: "hello" }));
    expect(grep.status).toBe("success");
    expect(grep.content).toContain("a.txt:1: hello");
  });

  it("区内写入类工具默认询问，无审批器时拒绝且不产生副作用", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "a.txt", "original");
    const executor = makeExecutor(root);

    const write = await executor.execute(call("c1", "write", { path: "b.txt", content: "x" }));
    expect(write.status).toBe("denied");
    expect(write.errorCategory).toBe("permission");
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);

    const edit = await executor.execute(
      call("c2", "edit", { path: "a.txt", old_string: "original", new_string: "changed" }),
    );
    expect(edit.status).toBe("denied");
    expect(readFileAt(root, "a.txt")).toBe("original");
  });

  it("审批通过后执行，请求携带工具调用、真实路径与实际操作", async () => {
    const root = makeWorkspace();
    const outside = tempDir("shana-ext-");
    const outsideFile = path.join(outside, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("call-1", "read", { path: outsideFile }));
    expect(result.status).toBe("success");
    expect(result.content).toContain("secret");

    expect(requests).toHaveLength(1);
    expect(requests[0].toolCallId).toBe("call-1");
    expect(requests[0].toolName).toBe("read");
    if (requests[0].action.type !== "read") throw new Error("expected read action");
    expect(requests[0].action.paths[0]).toMatchObject({
      requested: outsideFile,
      insideWorkspace: false,
      exists: true,
    });
    expect(requests[0].action.paths[0].realPath).toBe(fs.realpathSync.native(outsideFile));
  });

  it("拒绝与审批器异常均返回确定 denied，且不执行工具", async () => {
    const root = makeWorkspace();
    const deniedGate = recordingGate("deny").gate;
    const denied = await makeExecutor(root, { permissionGate: deniedGate }).execute(
      call("c1", "write", { path: "a.txt", content: "x" }),
    );
    expect(denied.status).toBe("denied");
    expect(denied.content).toBe("Error: User denied.");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);

    const throwingGate: ToolPermissionGate = async () => {
      throw new Error("approval UI crashed");
    };
    const failed = await makeExecutor(root, { permissionGate: throwingGate }).execute(
      call("c2", "write", { path: "a.txt", content: "x" }),
    );
    expect(failed.status).toBe("denied");
    expect(failed.content).toBe("Error: Internal error. Stop and ask user.");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("Shell 审批请求携带完全相同的命令字符串", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun({ stdout: "ok" });
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, {
      permissionGate: gate,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
    });
    const command = "  echo  hi  ";

    const pending = executor.execute(call("c1", shellName, { command }));
    await tick();
    fake.child.emit("close", 0);
    const result = await pending;

    expect(result.status).toBe("success");
    expect(requests).toHaveLength(1);
    expect(requests[0].action).toEqual({ type: "shell", command });
  });

  it("审批被拒绝不阻断后续工具调用", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "keep.txt", "original");
    const decisions: Array<"allow" | "deny"> = ["deny", "allow"];
    const gate: ToolPermissionGate = async () => gateDecision(decisions.shift() ?? "deny");
    const executor = makeExecutor(root, { permissionGate: gate });

    const denied = await executor.execute(call("c1", "write", { path: "keep.txt", content: "first" }));
    expect(denied.status).toBe("denied");

    const allowed = await executor.execute(
      call("c2", "edit", { path: "keep.txt", old_string: "original", new_string: "second" }),
    );
    expect(allowed.status).toBe("success");
    expect(readFileAt(root, "keep.txt")).toBe("second");
  });
});

describe("V8 取消与待决审批", () => {
  it("执行前已取消 → not_executed，不调用审批器", async () => {
    const root = makeWorkspace();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(call("c1", "write", { path: "a.txt", content: "x" }), {
      signal: controller.signal,
    });

    expect(result.status).toBe("not_executed");
    expect(result.errorCategory).toBe("cancelled");
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("待批期间取消：审批池由审批器唤醒后不再执行工具", async () => {
    const root = makeWorkspace();
    let release: ((decision: ToolPermissionDecision) => void) | undefined;
    const gate: ToolPermissionGate = () =>
      new Promise<ToolPermissionDecision>((resolve) => {
        release = resolve;
      });
    const executor = makeExecutor(root, { permissionGate: gate });
    const controller = new AbortController();

    const pending = executor.execute(call("c1", "write", { path: "a.txt", content: "x" }), {
      signal: controller.signal,
    });
    await tick();
    if (!release) throw new Error("approval gate was not invoked");
    controller.abort();
    release(gateDecision("allow"));
    const result = await pending;

    expect(result.status).toBe("not_executed");
    expect(result.errorCategory).toBe("cancelled");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("审批器因取消唤醒待批 → not_executed，与用户拒绝的 denied 可区分", async () => {
    const root = makeWorkspace();
    const gate: ToolPermissionGate = async () => ({ decision: "cancelled" });
    const result = await makeExecutor(root, { permissionGate: gate }).execute(
      call("c1", "write", { path: "a.txt", content: "x" }),
    );

    expect(result.status).toBe("not_executed");
    expect(result.errorCategory).toBe("cancelled");
    expect(result.content).toBe("Error: Cancelled by user.");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("拒绝原因分别落到确定的 denied 文案，内部不吞类型", async () => {
    const root = makeWorkspace();
    const cases: Array<[ToolPermissionDecision, string]> = [
      [{ decision: "deny", reason: "denied_by_user" }, "Error: User denied."],
      [{ decision: "deny", reason: "no_approver" }, "Error: Internal error. Stop and ask user."],
      [{ decision: "deny", reason: "approver_error" }, "Error: Internal error. Stop and ask user."],
    ];

    for (const [decision, content] of cases) {
      const executor = makeExecutor(root, { permissionGate: async () => decision });
      const result = await executor.execute(call("c1", "write", { path: "a.txt", content: "x" }));
      expect(result.status).toBe("denied");
      expect(result.errorCategory).toBe("permission");
      expect(result.content).toBe(content);
    }
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });
});

it("executor传递write覆盖前取消信号", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "target.txt", "original");
  const controller = new AbortController();
  const original = fs.promises.stat.bind(fs.promises);
  const spy = vi
    .spyOn(fs.promises, "stat")
    .mockImplementation(async (...args: Parameters<typeof fs.promises.stat>) => {
      const result = await original(...args);
      controller.abort();
      return result;
    });
  try {
    const result = await makeExecutor(root, { permissionGate: async () => ({ decision: "allow" }) }).execute(
      call("cancel-write", "write", { path: "target.txt", content: "changed" }),
      { signal: controller.signal },
    );
    expect(result.content).toBe("Error: Cancelled by user.");
    expect(readFileAt(root, "target.txt")).toBe("original");
  } finally {
    spy.mockRestore();
  }
});

it.each(["write-existing", "write-new", "edit"])("审批期间父目录重绑定被拒绝 %s", async (operation) => {
  const root = makeWorkspace();
  const outside = tempDir("shana-rebound-");
  fs.mkdirSync(path.join(root, "sub"));
  const name = operation === "write-new" ? "new.txt" : "target.txt";
  if (operation !== "write-new") {
    writeFileAt(root, "sub/target.txt", "old");
    fs.writeFileSync(path.join(outside, name), "old");
  }
  const executor = makeExecutor(root, {
    permissionGate: async () => {
      fs.renameSync(path.join(root, "sub"), path.join(root, "moved"));
      fs.symlinkSync(outside, path.join(root, "sub"), "junction");
      return { decision: "allow" };
    },
  });
  const tool = operation === "edit" ? "edit" : "write";
  const args =
    tool === "edit"
      ? { path: `sub/${name}`, old_string: "old", new_string: "new" }
      : { path: `sub/${name}`, content: "new" };
  const result = await executor.execute(call("rebind", tool, args));
  expect(result.status).toBe("error");
  expect(result.content).toBe("Error: Path target changed. Stop and ask user.");
  if (operation === "write-new") expect(fs.existsSync(path.join(outside, name))).toBe(false);
  else expect(fs.readFileSync(path.join(outside, name), "utf8")).toBe("old");
});

it("edit提交前路径变化保留错误并避免在重绑定目录执行清理", async () => {
  const root = makeWorkspace();
  const outside = tempDir("shana-rebound-commit-");
  writeFileAt(root, "sub/target.txt", "old");
  fs.writeFileSync(path.join(outside, "target.txt"), "outside");
  const originalOpen = fs.promises.open.bind(fs.promises);
  const warnings: string[] = [];
  const open = vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        fs.renameSync(path.join(root, "sub"), path.join(root, "moved"));
        fs.symlinkSync(outside, path.join(root, "sub"), "junction");
      });
    }
    return handle;
  });
  try {
    const result = await makeExecutor(root, {
      permissionGate: async () => ({ decision: "allow" }),
      onCleanupWarning: (value) => warnings.push(value),
    }).execute(
      call("commit-rebind", "edit", { path: "sub/target.txt", old_string: "old", new_string: "new" }),
    );
    expect(result.content).toBe("Error: Path target changed. Stop and ask user.");
    expect(fs.readFileSync(path.join(outside, "target.txt"), "utf8")).toBe("outside");
    expect(fs.readFileSync(path.join(root, "moved/target.txt"), "utf8")).toBe("old");
    expect(warnings).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, "moved")).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  } finally {
    open.mockRestore();
  }
});

it("文件内容并发变化不会被路径目标检查拒绝", async () => {
  const root = makeWorkspace();
  writeFileAt(root, "target.txt", "old");
  const result = await makeExecutor(root, {
    permissionGate: async () => {
      writeFileAt(root, "target.txt", "changed");
      return { decision: "allow" };
    },
  }).execute(call("content-change", "write", { path: "target.txt", content: "new" }));
  expect(result.status).toBe("success");
  expect(readFileAt(root, "target.txt")).toBe("new");
});

it.each(["read", "glob", "grep"])("区外审批后目标重绑定不返回其他目标内容 %s", async (tool) => {
  const root = makeWorkspace();
  const external = tempDir("shana-read-rebind-");
  const source = path.join(external, "source");
  const other = path.join(external, "other");
  fs.mkdirSync(source);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(source, "target.txt"), "old");
  fs.writeFileSync(path.join(other, "target.txt"), "private");
  const args =
    tool === "read"
      ? { path: path.join(source, "target.txt") }
      : tool === "glob"
        ? { path: source, pattern: "*.txt" }
        : { path: source, pattern: "private" };
  const result = await makeExecutor(root, {
    permissionGate: async () => {
      fs.renameSync(source, path.join(external, "moved"));
      fs.symlinkSync(other, source, "junction");
      return { decision: "allow" };
    },
  }).execute(call("read-rebind", tool, args));
  expect(result.content).toBe("Error: Path target changed. Stop and ask user.");
  expect(result.status).toBe("error");
});

describe("bash 运行中实时输出穿透", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("onToolOutput 携带调用 id 与尾快照，最终内容不变", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const root = makeWorkspace();
    const fake = fakeShellRun();
    const outputs: Array<[string, string]> = [];
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, {
      permissionGate: gate,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
      onToolOutput: (toolCallId, snapshot) => outputs.push([toolCallId, snapshot]),
    });

    const pending = executor.execute(call("c-live", shellName, { command: "long" }));
    await tick();
    fake.child.stdout.write("step1\n");
    vi.advanceTimersByTime(1000);
    expect(outputs).toEqual([["c-live", "step1\n"]]);
    fake.child.emit("close", 0);
    const result = await pending;

    expect(result.status).toBe("success");
    expect(result.content).toBe("Exit code: 0\nStdout:\nstep1\nStderr:\n(no output)");
    vi.advanceTimersByTime(5000);
    expect(outputs).toEqual([["c-live", "step1\n"]]);
  });
});
