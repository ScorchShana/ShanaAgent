import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHELL_TIMEOUT_MS } from "../../src/llm/settings-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  detectShell,
  terminateProcessTree,
  runShellCommand,
  shellResultToOutcome,
  SHELL_KILL_CONFIRM_TIMEOUT_MS,
  SHELL_LIVE_OUTPUT_INTERVAL_MS,
  SHELL_LIVE_OUTPUT_MAX_CHARS,
  SHELL_SWEEP_TIMEOUT_MS,
  type SpawnProcess,
} from "../../src/tools/shell.js";
import {
  call,
  cleanupTempDirs,
  fakeChild,
  fakeShellRun,
  makeExecutor,
  makeWorkspace,
  recordingGate,
  tick,
  writeFileAt,
  type FakeShellRun,
} from "./helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

afterEach(cleanupTempDirs);

const shellName = detectShell(process.platform).kind;
const shellDescriptor = detectShell(process.platform);

function makeShellExecutor(
  root: string,
  fake: FakeShellRun,
  options: { killConfirmTimeoutMs?: number } = {},
) {
  const { gate } = recordingGate("allow");
  return makeExecutor(root, {
    permissionGate: gate,
    spawnProcess: fake.spawnProcess,
    terminateTree: fake.terminateTree,
    ...options,
  });
}

describe("V6 Shell 环境检测与注册表", () => {
  it("Windows 使用 Git Bash，其余平台使用系统 Bash", () => {
    const windows = detectShell("win32");
    expect(windows.kind).toBe("bash");
    expect(windows.executable).toMatch(/[/\\]Git[/\\]bin[/\\]bash\.exe$/i);
    expect(windows.argumentsFor("echo hi")).toEqual(["-c", "echo hi"]);
    expect(detectShell("linux")).toMatchObject({ kind: "bash", executable: "bash" });
  });

  it("注册表恰好包含六件工具且只有一个 Shell，无动态注册接口", () => {
    const windows = new ToolRegistry([]);
    expect(windows.names()).toEqual([]);

    const root = makeWorkspace();
    const executor = makeExecutor(root);
    expect(executor.registry.names()).toEqual(["read", "glob", "grep", "write", "edit", shellName]);
    expect(executor.registry.names().filter((name) => name === "bash" || name === "powershell")).toHaveLength(
      1,
    );
    const otherShell = shellName === "bash" ? "powershell" : "bash";
    expect(executor.registry.get(otherShell)).toBeUndefined();
    expect("register" in executor.registry).toBe(false);

    const readTool = executor.registry.get("read");
    if (!readTool) throw new Error("read tool missing");
    expect(() => new ToolRegistry([readTool, readTool])).toThrow(/duplicate tool registration/);
  });

  it("默认超时为 120000ms，终止确认等待有显式常量", () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(120_000);
    expect(SHELL_KILL_CONFIRM_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("V1/V6 Shell 真实执行", () => {
  it("成功执行，cwd 固定为工作区根，命令字面量进入审批请求", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "cwd.js", "process.stdout.write(process.cwd());\n");
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("c1", shellName, { command: "node cwd.js" }));

    expect(result.status).toBe("success");
    const reported = fs.realpathSync.native(result.content.split("Stdout:\n")[1].split("\nStderr:")[0]);
    expect(path.resolve(reported)).toBe(path.resolve(fs.realpathSync.native(root)));
    expect(requests[0].action).toEqual({ type: "shell", command: "node cwd.js" });

    const echo = await executor.execute(call("c2", shellName, { command: "echo hello" }));
    expect(echo.status).toBe("success");
    expect(echo.content).toBe("Exit code: 0\nStdout:\nhello\nStderr:\n(no output)");
  });

  it("非零退出码保持成功并报告退出码，stderr 被保留", async () => {
    const root = makeWorkspace();
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const failed = await executor.execute(call("c1", shellName, { command: "exit 3" }));
    expect(failed.status).toBe("success");
    expect(failed.content).toContain("Exit code: 3");

    const stderrCommand = "printf 'oops\\n' 1>&2";
    const stderr = await executor.execute(call("c2", shellName, { command: stderrCommand }));
    expect(stderr.status).toBe("success");
    expect(stderr.content).toContain("Stderr:");
    expect(stderr.content).toContain("oops");
  });

  it("超大 stdout 按上限裁剪，裁剪结果即最终内容", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "emit.js", 'process.stdout.write("x".repeat(20000));\n');
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const result = await executor.execute(call("c1", shellName, { command: "node emit.js" }));
    expect(result.status).toBe("success");
    expect(result.content).toContain("…[4000 chars truncated]…");
    expect(result.content.length).toBeLessThan(17_000);
  });
});

describe("V7 Shell 超时", () => {
  it("确认终止 → timeout 状态与终止详情", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun({ stdout: "partial", kill: "terminated" });
    const executor = makeShellExecutor(root, fake, { killConfirmTimeoutMs: 50 });

    const result = await executor.execute(call("c1", shellName, { command: "long", timeout: 1 }));

    expect(result.status).toBe("timeout");
    expect(result.termination).toEqual({ trigger: "timeout", kill: "terminated" });
    expect(result.content).toContain("Command timed out after 1s; process termination confirmed.");
    expect(result.content).toContain("partial");
    expect(fake.terminationCalls).toHaveLength(1);
    expect(fake.terminationCalls[0].confirmTimeoutMs).toBe(50);
  });

  it("无法确认终止 → unknown，并如实说明进程可能仍在运行", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun({ stdout: "partial", kill: "unconfirmed" });
    const executor = makeShellExecutor(root, fake);

    const result = await executor.execute(call("c1", shellName, { command: "long", timeout: 1 }));

    expect(result.status).toBe("unknown");
    expect(result.termination).toEqual({ trigger: "timeout", kill: "unconfirmed" });
    expect(result.content).toContain("termination could not be confirmed");
    expect(result.content).toContain("side effects are unknown");
    expect(result.content).not.toContain("was terminated");
  });

  it("终止失败与终止器抛错 → unknown/kill failed", async () => {
    const root = makeWorkspace();
    for (const kill of ["failed", "throw"] as const) {
      const fake = fakeShellRun({ kill });
      const executor = makeShellExecutor(root, fake);
      const result = await executor.execute(call("c1", shellName, { command: "long", timeout: 1 }));
      expect(result.status).toBe("unknown");
      expect(result.termination).toEqual({ trigger: "timeout", kill: "failed" });
    }
  }, 10_000);

  it("真实超时：进程树被终止后返回确定超时结果", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "sleep.js", "setTimeout(() => {}, 60000);\n");
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });

    const started = Date.now();
    const result = await executor.execute(call("c1", shellName, { command: "node sleep.js", timeout: 1 }));

    expect(result.status).toBe("timeout");
    expect(result.termination).toEqual({ trigger: "timeout", kill: "terminated" });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);
});

describe("V8 Shell 取消", () => {
  it("取消前未启动时直接返回 not_executed 且不 spawn", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun();
    const executor = makeShellExecutor(root, fake);
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(call("c1", shellName, { command: "echo hi" }), {
      signal: controller.signal,
    });

    expect(result.status).toBe("not_executed");
    expect(result.errorCategory).toBe("cancelled");
    expect(fake.spawnCalls).toHaveLength(0);
    expect(fake.terminationCalls).toHaveLength(0);
  });

  it("取消请求终止进程树，确认终止的返回三态之一", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun({ stdout: "working", kill: "terminated" });
    const executor = makeShellExecutor(root, fake);
    const controller = new AbortController();

    const pending = executor.execute(call("c1", shellName, { command: "long", timeout: 1 }), {
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    const result = await pending;

    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("cancelled");
    expect(result.termination).toEqual({ trigger: "cancelled", kill: "terminated" });
    expect(result.content).toContain("process termination confirmed");
    expect(result.content).toContain("partially executed");
    expect(result.content).toContain("Verify its effects");
    expect(result.content).toContain("working");
    expect(fake.terminationCalls).toHaveLength(1);
    expect(fake.terminationCalls[0].confirmTimeoutMs).toBe(SHELL_KILL_CONFIRM_TIMEOUT_MS);
  });

  it("取消且无法确认终止 → unknown", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun({ kill: "unconfirmed" });
    const executor = makeShellExecutor(root, fake);
    const controller = new AbortController();

    const pending = executor.execute(call("c1", shellName, { command: "long", timeout: 1 }), {
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    const result = await pending;

    expect(result.status).toBe("unknown");
    expect(result.termination).toEqual({ trigger: "cancelled", kill: "unconfirmed" });
    expect(result.content).toContain("side effects are unknown");
  });

  it("真实取消：终止真实进程树并返回终止确认", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "sleep.js", "setTimeout(() => {}, 60000);\n");
    const { gate } = recordingGate("allow");
    const executor = makeExecutor(root, { permissionGate: gate });
    const controller = new AbortController();

    const pending = executor.execute(call("c1", shellName, { command: "node sleep.js", timeout: 1 }), {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort();
    const result = await pending;

    expect(result.errorCategory).toBe("cancelled");
    expect(result.termination).toEqual({ trigger: "cancelled", kill: "terminated" });
    expect(result.status).toBe("error");
  }, 20_000);

  it("runShellCommand 对已取消信号不启动进程", async () => {
    const root = makeWorkspace();
    const controller = new AbortController();
    controller.abort();
    const run = await runShellCommand("echo hi", {
      cwd: root,
      shell: shellDescriptor,
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    expect(run).toMatchObject({ status: "cancelled", started: false, stdout: "", stderr: "" });
    expect(shellResultToOutcome(run, 1_000).status).toBe("not_executed");
  });
});

describe("V8/V9 Shell 失败与权限", () => {
  it("无审批器时不执行 Shell，拒绝结果确定", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun();
    const executor = makeExecutor(root, { spawnProcess: fake.spawnProcess });

    const result = await executor.execute(call("c1", shellName, { command: "echo hi" }));

    expect(result.status).toBe("denied");
    expect(result.errorCategory).toBe("permission");
    expect(fake.spawnCalls).toHaveLength(0);
    expect(fake.terminationCalls).toHaveLength(0);
  });

  it("spawn 同步抛错与异步 error 均转为明确错误", async () => {
    const root = makeWorkspace();
    const { gate } = recordingGate("allow");
    const throwing = (() => {
      throw new Error("spawn ENOENT");
    }) as unknown as SpawnProcess;
    const syncFailure = await makeExecutor(root, { permissionGate: gate, spawnProcess: throwing }).execute(
      call("c1", shellName, { command: "echo hi" }),
    );
    expect(syncFailure.status).toBe("error");
    expect(syncFailure.errorCategory).toBe("shell");
    expect(syncFailure.content).toContain("Cannot start the shell. Stop and ask user.");

    const child = fakeChild();
    Object.assign(child, { pid: undefined });
    const fakeSpawn = (() => child) as unknown as SpawnProcess;
    const pending = makeExecutor(root, { permissionGate: gate, spawnProcess: fakeSpawn }).execute(
      call("c2", shellName, { command: "echo hi" }),
    );
    await tick();
    child.emit("error", new Error("spawn ENOENT"));
    const asyncFailure = await pending;
    expect(asyncFailure.status).toBe("error");
    expect(asyncFailure.content).toContain("Cannot start the shell. Stop and ask user.");
  });

  it("参数错误发生在权限与执行前", async () => {
    const root = makeWorkspace();
    const fake = fakeShellRun();
    const { gate, requests } = recordingGate("allow");
    const executor = makeExecutor(root, {
      permissionGate: gate,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
    });

    const missing = await executor.execute(call("c1", shellName, {}));
    expect(missing.status).toBe("error");
    expect(missing.errorCategory).toBe("arguments");
    expect(missing.content).toBe('Error: Missing required argument "command". Not executed.');

    const unknown = await executor.execute(call("c2", shellName, { command: "echo hi", cwd: ".." }));
    expect(unknown.content).toBe('Error: Unknown argument "cwd". Not executed.');

    expect(requests).toHaveLength(0);
    expect(fake.spawnCalls).toHaveLength(0);
  });

  it("未注册的 Shell 名称被拒绝", async () => {
    const root = makeWorkspace();
    const otherShell = shellName === "bash" ? "powershell" : "bash";
    const result = await makeExecutor(root).execute(call("c1", otherShell, { command: "echo hi" }));
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe("unknown_tool");
    expect(result.content).toBe(`Error: Unknown tool "${otherShell}". Not executed.`);
  });
});

describe("bash 独立流与异常终态", () => {
  it("保留仅空白的流且始终展示两个区块", () => {
    expect(
      shellResultToOutcome(
        { status: "exited", started: true, exitCode: 0, stdout: " ", stderr: "\n", truncated: false },
        120000,
      ).content,
    ).toBe("Exit code: 0\nStdout:\n \nStderr:\n\n");
  });

  it("异常退出只使用真实信号并转义", async () => {
    const child = fakeChild();
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 1000,
      spawnProcess: (() => child) as unknown as SpawnProcess,
    });
    child.emit("close", null, "SIGTERM");
    const outcome = shellResultToOutcome(await pending, 1000);
    expect(outcome.content).toBe(
      'Error: Command terminated by signal "SIGTERM".\nStdout:\n(no output)\nStderr:\n(no output)',
    );
  });

  it("两个流分别保留头尾并正确计算省略字符数", async () => {
    const child = fakeChild();
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 1000,
      spawnProcess: (() => child) as unknown as SpawnProcess,
    });
    child.stdout.write("a".repeat(10000) + "x".repeat(9) + "z".repeat(6000));
    child.stderr.write("b".repeat(2400) + "y".repeat(7) + "q".repeat(1600));
    child.emit("close", 0);
    const result = await pending;
    expect(result.stdout).toBe("a".repeat(10000) + "…[9 chars truncated]…" + "z".repeat(6000));
    expect(result.stderr).toBe("b".repeat(2400) + "…[7 chars truncated]…" + "q".repeat(1600));
  });
});

describe("bash 启动原因与内部异常收尾", () => {
  it.each([
    ["EACCES", "Cannot start the shell. Permission denied."],
    ["EIO", "Cannot start the shell. Stop and ask user."],
    ["ENOENT", "Shell is unavailable. Stop and ask user."],
  ])("按实际启动错误%s分类而不回显系统异常", async (code, reason) => {
    const result = await runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: { ...shellDescriptor, executable: path.join(makeWorkspace(), "missing-bash.exe") },
      timeoutMs: 1000,
      spawnProcess: (() => {
        throw Object.assign(new Error("private detail"), { code });
      }) as unknown as SpawnProcess,
    });
    expect(shellResultToOutcome(result, 1000).content).toBe(
      `Error: ${reason}\nStdout:\n(no output)\nStderr:\n(no output)`,
    );
  });

  it.each(["terminated", "unconfirmed"] as const)("内部流异常先收尾，终止结果%s", async (kill) => {
    const fake = fakeShellRun({ kill });
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 1000,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
    });
    fake.child.stdout.write("started\n");
    fake.child.stdout.emit("error", new Error("private detail"));
    const outcome = shellResultToOutcome(await pending, 1000);
    expect(outcome.status).toBe(kill === "terminated" ? "error" : "unknown");
    expect(outcome.content).toBe(
      `Error: ${kill === "terminated" ? "Internal error. Stop and ask user." : "Process termination could not be confirmed; side effects are unknown."}\nStdout:\nstarted\nStderr:\n(no output)`,
    );
    expect(fake.terminationCalls).toHaveLength(1);
  });
});

it("启动前描述符内部异常返回Internal error并保持空流", async () => {
  const result = await runShellCommand("x", {
    cwd: makeWorkspace(),
    shell: {
      ...shellDescriptor,
      argumentsFor: () => {
        throw new Error("private detail");
      },
    },
    timeoutMs: 1000,
  });
  expect(shellResultToOutcome(result, 1000).content).toBe(
    "Error: Internal error. Stop and ask user.\nStdout:\n(no output)\nStderr:\n(no output)",
  );
});

it("启动不存在或非目录的cwd时不误报Shell不存在", async () => {
  const root = makeWorkspace();
  const file = writeFileAt(root, "file", "x");
  for (const [cwd, reason] of [
    [path.join(root, "missing"), "Working directory not found."],
    [file, "Working path is not a directory."],
  ]) {
    const result = await runShellCommand("x", {
      cwd,
      shell: shellDescriptor,
      timeoutMs: 1000,
      spawnProcess: (() => {
        throw Object.assign(new Error("private detail"), { code: "ENOENT" });
      }) as unknown as SpawnProcess,
    });
    expect(shellResultToOutcome(result, 1000).content).toBe(
      `Error: ${reason}\nStdout:\n(no output)\nStderr:\n(no output)`,
    );
  }
});

it("分块UTF8按流解码且正常完成不被随后取消改写", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const pending = runShellCommand("x", {
    cwd: makeWorkspace(),
    shell: shellDescriptor,
    timeoutMs: 1000,
    signal: controller.signal,
    spawnProcess: (() => child) as unknown as SpawnProcess,
  });
  const bytes = Buffer.from("你好😀");
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.emit("close", 0);
  controller.abort();
  expect(shellResultToOutcome(await pending, 1000)).toEqual({
    status: "success",
    content: "Exit code: 0\nStdout:\n你好😀\nStderr:\n(no output)",
  });
});

describe("进程树终止确认不以父进程退出替代", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([{ exitCode: 0 }, { signalCode: "SIGTERM" }])(
    "父已退出但未close仍尝试终止POSIX组且不确认整个树结束：%j",
    async (fields) => {
      const child = fakeChild();
      Object.assign(child, fields);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("no group"), { code: "ESRCH" });
      });
      const outcome = await terminateProcessTree(child, { platform: "linux", confirmTimeoutMs: 10 });
      expect(outcome).toBe("unconfirmed");
      expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
    },
  );

  it("在同步kill触发close之前注册等待，且组消失后才确认", async () => {
    const child = fakeChild();
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        child.emit("close", null);
        return true;
      }
      throw Object.assign(new Error("no group"), { code: "ESRCH" });
    });
    expect(await terminateProcessTree(child, { platform: "linux", confirmTimeoutMs: 10 })).toBe("terminated");
  });

  it("收到close但POSIX组仍存在时不能确认终止", async () => {
    const child = fakeChild();
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") child.emit("close", null);
      return true;
    });
    expect(await terminateProcessTree(child, { platform: "linux", confirmTimeoutMs: 10 })).toBe(
      "unconfirmed",
    );
  });

  it("Windows父已退出后不对可能复用的PID调用taskkill", async () => {
    const child = fakeChild();
    Object.assign(child, { exitCode: 0 });
    expect(await terminateProcessTree(child, { platform: "win32", confirmTimeoutMs: 10 })).toBe(
      "unconfirmed",
    );
  });
});

it.each([0, 1])("Windows taskkill退出%s时必须同时验证成功与close", async (code) => {
  const child = fakeChild();
  const spawn = routeSpawn({
    powershell: () => autoChild("", 1),
    taskkill: () => {
      queueMicrotask(() => child.emit("close", null));
      return autoChild("", code);
    },
  });
  try {
    const pending = terminateProcessTree(child, { platform: "win32", confirmTimeoutMs: 10 });
    expect(await pending).toBe(code === 0 ? "terminated" : "failed");
    expect(spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  } finally {
    spawn.mockRestore();
  }
});

it("取消之后父close也不能绕过进程树确认", async () => {
  const fake = fakeShellRun({ kill: "unconfirmed" });
  const controller = new AbortController();
  const pending = runShellCommand("x", {
    cwd: makeWorkspace(),
    shell: shellDescriptor,
    timeoutMs: 1000,
    signal: controller.signal,
    spawnProcess: fake.spawnProcess,
    terminateTree: fake.terminateTree,
    killConfirmTimeoutMs: 10,
  });
  controller.abort();
  fake.child.emit("close", 0);
  const result = await pending;
  expect(fake.terminationCalls).toHaveLength(1);
  expect(shellResultToOutcome(result, 1000).status).toBe("unknown");
});

describe("取消生效前进程已退出按真实结果返回", () => {
  it.each([0, 2])("进程已退出（退出码 %i）时取消 → 确定退出结果，不尝试终止", async (code) => {
    const fake = fakeShellRun({ kill: "unconfirmed" });
    const controller = new AbortController();
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 1000,
      signal: controller.signal,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
      killConfirmTimeoutMs: 10,
    });
    fake.child.stdout.write("done\n");
    fake.child.exitCode = code;
    controller.abort();
    const result = await pending;
    expect(fake.terminationCalls).toHaveLength(0);
    expect(result.status).toBe("exited");
    expect(result.kill).toBeUndefined();
    expect(shellResultToOutcome(result, 1000)).toEqual({
      status: "success",
      content: `Exit code: ${code}\nStdout:\ndone\nStderr:\n(no output)`,
    });
  });

  it("进程已被信号终止时取消 → 真实信号结果，不尝试终止", async () => {
    const fake = fakeShellRun({ kill: "unconfirmed" });
    const controller = new AbortController();
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 1000,
      signal: controller.signal,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
      killConfirmTimeoutMs: 10,
    });
    fake.child.signalCode = "SIGTERM";
    controller.abort();
    const result = await pending;
    expect(fake.terminationCalls).toHaveLength(0);
    expect(result.status).toBe("exited");
    expect(shellResultToOutcome(result, 1000)).toEqual({
      status: "error",
      category: "shell",
      content: 'Error: Command terminated by signal "SIGTERM".\nStdout:\n(no output)\nStderr:\n(no output)',
    });
  });
});

it("bash forwards spawn exceptions to diagnostics without exposing them to the model", async () => {
  const root = makeWorkspace();
  const cause = Object.assign(new Error("private shell detail"), { code: "ENOENT" });
  const onDiagnostic = vi.fn();
  const { gate } = recordingGate("allow");
  const executor = makeExecutor(root, {
    onDiagnostic,
    permissionGate: gate,
    spawnProcess: (() => {
      throw cause;
    }) as SpawnProcess,
  });
  const result = await executor.execute(call("diag", "bash", { command: "echo secret" }));
  expect(result.status).toBe("error");
  expect(result.content).not.toContain("private shell detail");
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "bash.spawn", error: cause }));
});

it("bash forwards stream and termination exceptions while preserving unknown status", async () => {
  const fake = fakeShellRun();
  const streamCause = new Error("private stream error");
  const terminationCause = new Error("private kill error");
  const onDiagnostic = vi.fn();
  const pending = runShellCommand("x", {
    cwd: makeWorkspace(),
    shell: shellDescriptor,
    timeoutMs: 1000,
    spawnProcess: fake.spawnProcess,
    killConfirmTimeoutMs: 1,
    terminateTree: async () => {
      throw terminationCause;
    },
    onDiagnostic,
  });
  fake.child.stdout.emit("error", streamCause);
  const outcome = shellResultToOutcome(await pending, 1000);
  expect(outcome.status).toBe("unknown");
  expect(onDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ stage: "bash.stream", error: streamCause }),
  );
  expect(onDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({ stage: "bash.terminate", error: terminationCause }),
  );
  expect(outcome.content).not.toContain("private");
});

type SpawnHandler = (args: readonly string[]) => ReturnType<typeof fakeChild>;

function routeSpawn(handlers: { taskkill?: SpawnHandler; powershell?: SpawnHandler; bash?: SpawnHandler }) {
  return vi.spyOn(childProcess, "spawn").mockImplementation(((
    executable: string,
    args: readonly string[],
  ) => {
    const key = /taskkill/i.test(executable)
      ? "taskkill"
      : /powershell/i.test(executable)
        ? "powershell"
        : "bash";
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected spawn: ${executable}`);
    return handler(args);
  }) as unknown as typeof childProcess.spawn);
}

function autoChild(stdout: string, code = 0): ReturnType<typeof fakeChild> {
  const child = fakeChild();
  if (stdout) child.stdout.write(stdout);
  setTimeout(() => child.emit("close", code), 0);
  return child;
}

const CIM_BASH_CHILD = JSON.stringify([{ ProcessId: 777, Name: "bash.exe" }]);
const SNAPSHOT_OUTPUT = "R 100\nD 100 777 bash\nD 101 888 bash\nD 102 999 node\n";

describe("T22 Windows MSYS2 快照与 orphan 清扫", () => {
  afterEach(() => vi.restoreAllMocks());

  it("清扫预算有显式命名常量", () => {
    expect(SHELL_SWEEP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("快路径：快照+taskkill+close 即 terminated，不起 orphan 清扫", async () => {
    const child = fakeChild();
    let bashCalls = 0;
    const spawn = routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: () => {
        bashCalls += 1;
        return autoChild(SNAPSHOT_OUTPUT);
      },
      taskkill: () => {
        queueMicrotask(() => child.emit("close", null));
        return autoChild("", 0);
      },
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
    });
    expect(outcome).toBe("terminated");
    expect(bashCalls).toBe(1);
    expect(spawn).toHaveBeenCalledWith(
      "C:/Git/bin/bash.exe",
      ["-s", "777"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("taskkill ok 但 close 未观察到 → orphan 清扫后 close 确认 terminated", async () => {
    const child = fakeChild();
    const bashArgs: Array<readonly string[]> = [];
    const onDiagnostic = vi.fn();
    const spawn = routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: (args) => {
        bashArgs.push(args);
        if (bashArgs.length === 1) return autoChild(SNAPSHOT_OUTPUT);
        const helper = autoChild("K 888 0\nK 999 128\nS 2 0 0\n");
        helper.once("close", () => setTimeout(() => child.emit("close", null), 0));
        return helper;
      },
      taskkill: () => autoChild("", 0),
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
      onDiagnostic,
    });
    expect(outcome).toBe("terminated");
    expect(bashArgs).toHaveLength(2);
    expect(bashArgs[1]).toEqual(["-s", "101:888:bash", "102:999:node"]);
    const stages = onDiagnostic.mock.calls.map(([event]) => `${event.stage}:${event.code}`);
    expect(stages).toEqual(
      expect.arrayContaining([
        "bash.terminate.snapshot:ok",
        "bash.terminate.taskkill:ok",
        "bash.terminate.close:timeout",
        "bash.terminate.sweep:ok",
        "bash.terminate.sweep.close:observed",
      ]),
    );
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("secret-command");
    expect(spawn).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "4321", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it("快照 root_not_found → 无快照可用，close 未观察到时 unconfirmed 且不起清扫", async () => {
    const child = fakeChild();
    let bashCalls = 0;
    const onDiagnostic = vi.fn();
    routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: () => {
        bashCalls += 1;
        return autoChild("E root_not_found\n");
      },
      taskkill: () => autoChild("", 0),
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
      onDiagnostic,
    });
    expect(outcome).toBe("unconfirmed");
    expect(bashCalls).toBe(1);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "bash.terminate.snapshot", code: "root_not_found" }),
    );
  });

  it("orphan 清扫超时 → taskkill 回收辅助 bash 并 unconfirmed", async () => {
    const child = fakeChild();
    const taskkillPids: string[] = [];
    const onDiagnostic = vi.fn();
    routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: (args) => {
        if (args[1] === "777") return autoChild(SNAPSHOT_OUTPUT);
        return fakeChild();
      },
      taskkill: (args) => {
        taskkillPids.push(args[1]);
        return autoChild("", 0);
      },
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      sweepTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
      onDiagnostic,
    });
    expect(outcome).toBe("unconfirmed");
    expect(taskkillPids).toContain("4321");
    expect(taskkillPids.length).toBeGreaterThanOrEqual(2);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "bash.terminate.sweep", code: "timeout" }),
    );
  });

  it("辅助 bash spawn ENOENT → 快照 spawn_error，unconfirmed 不猜杀", async () => {
    const child = fakeChild();
    const onDiagnostic = vi.fn();
    routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: () => {
        throw Object.assign(new Error("missing bash"), { code: "ENOENT" });
      },
      taskkill: () => autoChild("", 0),
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
      onDiagnostic,
    });
    expect(outcome).toBe("unconfirmed");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "bash.terminate.snapshot", code: "spawn_error" }),
    );
  });

  it("清扫部分 K 失败但最终 close 观察到 → terminated", async () => {
    const child = fakeChild();
    let bashCalls = 0;
    routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: () => {
        bashCalls += 1;
        if (bashCalls === 1) return autoChild(SNAPSHOT_OUTPUT);
        const helper = autoChild("K 888 1\nS 0 1 0\n");
        helper.once("close", () => setTimeout(() => child.emit("close", null), 0));
        return helper;
      },
      taskkill: () => autoChild("", 0),
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
    });
    expect(outcome).toBe("terminated");
  });

  it("快照输出畸形或超量 → 防御解析不抛错，有效行仍可用", async () => {
    const child = fakeChild();
    routeSpawn({
      powershell: () => autoChild(CIM_BASH_CHILD),
      bash: () => autoChild("X junk\n".repeat(500) + "R 100\nD 101 888 bash\n"),
      taskkill: () => {
        queueMicrotask(() => child.emit("close", null));
        return autoChild("", 0);
      },
    });
    const outcome = await terminateProcessTree(child, {
      platform: "win32",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
    });
    expect(outcome).toBe("terminated");
  });

  it("POSIX 分支不 spawn 任何辅助进程", async () => {
    const child = fakeChild();
    const spawn = vi.spyOn(childProcess, "spawn");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no group"), { code: "ESRCH" });
    });
    const outcome = await terminateProcessTree(child, {
      platform: "linux",
      confirmTimeoutMs: 10,
      shellExecutable: "C:/Git/bin/bash.exe",
    });
    expect(outcome).toBe("unconfirmed");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("T22 退出清理重试（根已死/仍活）", () => {
  afterEach(() => vi.restoreAllMocks());

  function setupRun(options: { snapshotFails?: boolean; sweepOutput?: string } = {}) {
    const child = fakeChild();
    const cleanups: Array<() => Promise<string>> = [];
    const bashArgs: Array<readonly string[]> = [];
    const taskkillPids: string[] = [];
    const onDiagnostic = vi.fn();
    routeSpawn({
      powershell: () => autoChild(options.snapshotFails ? "" : CIM_BASH_CHILD, options.snapshotFails ? 1 : 0),
      bash: (args) => {
        bashArgs.push(args);
        if (args[1] === "777") {
          return options.snapshotFails ? autoChild("", 1) : autoChild(SNAPSHOT_OUTPUT);
        }
        return autoChild(options.sweepOutput ?? "K 888 0\nK 999 128\nS 2 0 0\n");
      },
      taskkill: (args) => {
        taskkillPids.push(args[1]);
        if (taskkillPids.filter((pid) => pid === "4321").length >= 2)
          queueMicrotask(() => child.emit("close", null));
        return autoChild("", 0);
      },
    });
    const pending = runShellCommand("secret-command", {
      cwd: makeWorkspace(),
      shell: { ...shellDescriptor, executable: "C:/Git/bin/bash.exe" },
      platform: "win32",
      timeoutMs: 30,
      killConfirmTimeoutMs: 10,
      sweepTimeoutMs: 200,
      spawnProcess: (() => child) as unknown as SpawnProcess,
      onDiagnostic,
      onPendingShell: (cleanup) => cleanups.push(cleanup),
    });
    return { child, cleanups, bashArgs, taskkillPids, onDiagnostic, pending };
  }

  it("根已死且有快照 → cleanup 走 orphan 清扫，复核通过 terminated", async () => {
    const { child, cleanups, bashArgs, pending } = setupRun();
    const result = await pending;
    expect(result.status).toBe("timeout");
    expect(result.kill).toBe("unconfirmed");
    expect(cleanups).toHaveLength(1);
    child.exitCode = 0;
    expect(await cleanups[0]()).toBe("terminated");
    expect(bashArgs.some((args) => args.includes("101:888:bash"))).toBe(true);
  });

  it("根已死且无快照 → cleanup unconfirmed，零额外 taskkill，诊断 no_snapshot", async () => {
    const { child, cleanups, taskkillPids, onDiagnostic, pending } = setupRun({ snapshotFails: true });
    await pending;
    expect(cleanups).toHaveLength(1);
    const before = taskkillPids.length;
    child.exitCode = 0;
    expect(await cleanups[0]()).toBe("unconfirmed");
    expect(taskkillPids.length).toBe(before);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "bash.terminate.cleanup.orphan", code: "no_snapshot" }),
    );
  });

  it("orphan 复核不匹配 → 不杀任何快照外 PID，unconfirmed", async () => {
    const { child, cleanups, taskkillPids, pending } = setupRun({
      sweepOutput: "V 101 mismatch\nV 102 mismatch\nE verify_none\n",
    });
    await pending;
    child.exitCode = 0;
    expect(await cleanups[0]()).toBe("unconfirmed");
    expect(taskkillPids).toEqual(["4321"]);
  });

  it("cleanup 时根仍活 → 复用完整 terminate 路径", async () => {
    const { cleanups, taskkillPids, pending } = setupRun();
    await pending;
    expect(cleanups).toHaveLength(1);
    expect(await cleanups[0]()).toBe("terminated");
    expect(taskkillPids.filter((pid) => pid === "4321")).toHaveLength(2);
  });

  it("cleanup 记忆化：重复调用只执行一次", async () => {
    const { child, cleanups, bashArgs, pending } = setupRun();
    await pending;
    const baseline = bashArgs.filter((args) => args.includes("101:888:bash")).length;
    child.exitCode = 0;
    const first = cleanups[0]();
    const second = cleanups[0]();
    expect(await first).toBe("terminated");
    expect(await second).toBe("terminated");
    expect(bashArgs.filter((args) => args.includes("101:888:bash")).length).toBe(baseline + 1);
  });
});

describe.runIf(process.platform === "win32" && process.env.SHANA_REAL_KILL === "1")(
  "T22 真实进程树终止（SHANA_REAL_KILL=1）",
  () => {
    it("npm 多层进程树超时 → orphan 清扫全杀，诊断完整且不含命令原文", async () => {
      const root = makeWorkspace();
      writeFileAt(
        root,
        "package.json",
        JSON.stringify({ name: "t22-real", private: true, scripts: { test: "node spin.js" } }),
      );
      writeFileAt(
        root,
        "spin.js",
        'require("fs").writeFileSync(require("path").join(__dirname,"spin.pid"),String(process.pid));setInterval(()=>{},1000);\n',
      );
      const fixtureSh = root
        .replace(/\\/g, "/")
        .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
      const events: Array<{ stage: string; code?: string }> = [];
      try {
        const result = await runShellCommand(`cd ${fixtureSh} && npm test --silent 2>&1 | grep x | head -1`, {
          cwd: root,
          shell: detectShell("win32"),
          timeoutMs: 8_000,
          onDiagnostic: (event) => events.push({ stage: event.stage, code: event.code }),
        });
        expect(result.status).toBe("timeout");
        expect(result.kill).toBe("terminated");
        const spinPid = fs.readFileSync(path.join(root, "spin.pid"), "utf8").trim();
        const check = await new Promise<string>((resolve) => {
          const checker = childProcess.spawn("tasklist", ["/FI", `PID eq ${spinPid}`, "/FO", "CSV", "/NH"], {
            windowsHide: true,
          });
          let output = "";
          checker.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
          checker.once("close", () => resolve(output));
        });
        expect(check).not.toContain(spinPid);
        const stages = events.map((event) => `${event.stage}:${event.code}`);
        expect(stages).toEqual(
          expect.arrayContaining([
            "bash.terminate.snapshot:ok",
            "bash.terminate.sweep:ok",
            "bash.terminate.sweep.close:observed",
          ]),
        );
        expect(JSON.stringify(events)).not.toContain("npm test");
      } finally {
        const spinPidFile = path.join(root, "spin.pid");
        if (fs.existsSync(spinPidFile)) {
          const spinPid = fs.readFileSync(spinPidFile, "utf8").trim();
          await new Promise<void>((resolve) => {
            const killer = childProcess.spawn("taskkill", ["/PID", spinPid, "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
            killer.once("close", () => resolve());
            killer.once("error", () => resolve());
          });
        }
      }
    }, 60_000);
  },
);

describe("bash 运行中实时输出快照", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function startLiveRun(
    options: {
      onOutput?: (snapshot: string) => void;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    const fake = fakeShellRun({ kill: "terminated" });
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: options.timeoutMs ?? 60_000,
      signal: options.signal,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
      onOutput: options.onOutput,
    });
    return { fake, pending };
  }

  it("每秒发一次全量尾快照，替换语义而非追加", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const snapshots: string[] = [];
    const { fake, pending } = startLiveRun({ onOutput: (snapshot) => snapshots.push(snapshot) });
    fake.child.stdout.write("first\n");
    await tick();
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS - 1);
    expect(snapshots).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(snapshots).toEqual(["first\n"]);
    fake.child.stdout.write("second\n");
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(snapshots).toEqual(["first\n", "first\nsecond\n"]);
    fake.child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("stdout/stderr 按写入顺序交织，溢出只留最新尾部", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const snapshots: string[] = [];
    const { fake, pending } = startLiveRun({ onOutput: (snapshot) => snapshots.push(snapshot) });
    fake.child.stdout.write("out1\n");
    fake.child.stderr.write("err1\n");
    fake.child.stdout.write("out2\n");
    await tick();
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(snapshots).toEqual(["out1\nerr1\nout2\n"]);
    fake.child.stdout.write("x".repeat(SHELL_LIVE_OUTPUT_MAX_CHARS + 1000));
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(snapshots[1]).toBe("x".repeat(SHELL_LIVE_OUTPUT_MAX_CHARS));
    fake.child.emit("close", 0);
    await pending;
  });

  it("输出为空或无变化时不重复发快照", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const snapshots: string[] = [];
    const { fake, pending } = startLiveRun({ onOutput: (snapshot) => snapshots.push(snapshot) });
    vi.advanceTimersByTime(2000);
    expect(snapshots).toEqual([]);
    fake.child.stdout.write("a");
    await tick();
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(snapshots).toEqual(["a"]);
    vi.advanceTimersByTime(3000);
    expect(snapshots).toEqual(["a"]);
    fake.child.emit("close", 0);
    await pending;
  });

  it.each(["close", "abort", "spawn_failed"] as const)(
    "%s 之后不再发快照且 interval 已清理",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const snapshots: string[] = [];
      const onOutput = (snapshot: string): void => {
        snapshots.push(snapshot);
      };
      if (kind === "spawn_failed") {
        const result = await runShellCommand("x", {
          cwd: makeWorkspace(),
          shell: shellDescriptor,
          timeoutMs: 1000,
          spawnProcess: (() => {
            throw Object.assign(new Error("private detail"), { code: "EACCES" });
          }) as unknown as SpawnProcess,
          onOutput,
        });
        expect(result.status).toBe("spawn_failed");
      } else {
        const abort = new AbortController();
        const { fake, pending } = startLiveRun({
          signal: kind === "abort" ? abort.signal : undefined,
          onOutput,
        });
        fake.child.stdout.write("partial");
        await tick();
        vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
        expect(snapshots).toEqual(["partial"]);
        if (kind === "abort") abort.abort();
        else fake.child.emit("close", 0);
        await pending;
      }
      vi.advanceTimersByTime(5000);
      expect(snapshots).toEqual(kind === "spawn_failed" ? [] : ["partial"]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("超时收尾后不再发快照且 interval 已清理", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const snapshots: string[] = [];
    const fake = fakeShellRun({ kill: "terminated" });
    const pending = runShellCommand("x", {
      cwd: makeWorkspace(),
      shell: shellDescriptor,
      timeoutMs: 5000,
      spawnProcess: fake.spawnProcess,
      terminateTree: fake.terminateTree,
      onOutput: (snapshot) => snapshots.push(snapshot),
    });
    fake.child.stdout.write("partial");
    await new Promise(process.nextTick);
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    expect(snapshots).toEqual(["partial"]);
    vi.advanceTimersByTime(4000);
    const result = await pending;
    expect(result.status).toBe("timeout");
    vi.advanceTimersByTime(5000);
    expect(snapshots).toEqual(["partial"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("onOutput 抛异常不改变最终结果", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { fake, pending } = startLiveRun({
      onOutput: () => {
        throw new Error("display boom");
      },
    });
    fake.child.stdout.write("hello\n");
    await tick();
    vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
    fake.child.emit("close", 0);
    const result = await pending;
    expect(result).toMatchObject({ status: "exited", exitCode: 0, stdout: "hello\n", stderr: "" });
  });

  it("带与不带 onOutput 的最终结果字节相等", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const run = async (onOutput?: (snapshot: string) => void) => {
      const fake = fakeShellRun({ stdout: "head\n", stderr: "warn\n" });
      const pending = runShellCommand("x", {
        cwd: makeWorkspace(),
        shell: shellDescriptor,
        timeoutMs: 60_000,
        spawnProcess: fake.spawnProcess,
        terminateTree: fake.terminateTree,
        onOutput,
      });
      await tick();
      vi.advanceTimersByTime(SHELL_LIVE_OUTPUT_INTERVAL_MS);
      fake.child.emit("close", 0);
      return pending;
    };
    expect(await run(() => {})).toEqual(await run(undefined));
  });
});
