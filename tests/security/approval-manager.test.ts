import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../../src/core/event-bus.js";
import type { BusEvent, PermissionResolvedEvent, RunStateChangedEvent } from "../../src/core/events.js";
import {
  SessionController,
  type AgentLoopDriver,
  type RunHandle,
} from "../../src/core/session-controller.js";
import { InvalidStateError, type ApprovalDecision, type RunOutcome } from "../../src/core/state.js";
import { ApprovalManager, type Approver } from "../../src/security/approval-manager.js";
import { createPathPolicy } from "../../src/security/path-policy.js";
import type { ApprovalRequest, ToolCallSubject } from "../../src/security/permissions.js";
import {
  createToolExecutor,
  type ToolCallRequest,
  type ToolExecutionResult,
} from "../../src/tools/executor.js";
import { detectShell } from "../../src/tools/shell.js";
import { cleanupTempDirs, makeWorkspace, readFileAt, tempDir, writeFileAt } from "../tools/helpers.js";

afterEach(cleanupTempDirs);

describe("session grants", () => {
  it("never applies a bash grant to an unknown shell tool", async () => {
    const approver = vi.fn(async () => "session" as const);
    const manager = new ApprovalManager({ approver });
    await manager.requestPermission(shellSubject("echo shared"));
    await manager.requestPermission({ ...shellSubject("echo shared"), toolName: "unknown" });
    expect(approver).toHaveBeenCalledTimes(2);
  });
});

const shellName = detectShell(process.platform).kind;

function call(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return {
    type: "toolCall",
    id,
    name,
    rawArguments: JSON.stringify(args),
    parse: { status: "parsed", arguments: args as JsonObject },
  };
}

function writeSubject(root: string, relative: string, toolName = "write"): ToolCallSubject {
  const target = createPathPolicy(root).resolve(relative);
  return {
    toolCallId: "subject-1",
    toolName,
    action: { type: "write", path: target, operation: target.exists ? "overwrite" : "create" },
  };
}

function readSubject(root: string, relative: string, toolName = "read"): ToolCallSubject {
  const target = createPathPolicy(root).resolve(relative);
  return { toolCallId: "subject-1", toolName, action: { type: "read", paths: [target] } };
}

function shellSubject(command: string): ToolCallSubject {
  return { toolCallId: "subject-1", toolName: shellName, action: { type: "shell", command } };
}

interface MockApprover {
  approver: Approver;
  prompts: ApprovalRequest[];
  resolveNext: (decision: ApprovalDecision) => void;
}

function mockApprover(script: ApprovalDecision[] = []): MockApprover {
  const prompts: ApprovalRequest[] = [];
  const queue = [...script];
  const waiters: Array<(decision: ApprovalDecision) => void> = [];
  const approver: Approver = async (request) => {
    prompts.push(request);
    const next = queue.shift();
    if (next !== undefined) return next;
    return new Promise<ApprovalDecision>((resolve) => waiters.push(resolve));
  };
  return {
    approver,
    prompts,
    resolveNext: (decision) => {
      const waiter = waiters.shift();
      if (!waiter) throw new Error("no pending approval request");
      waiter(decision);
    },
  };
}

function wireExecutor(root: string, manager: ApprovalManager) {
  return createToolExecutor({
    workspaceRoot: root,
    permissionGate: (request) => manager.requestPermission(request),
  });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function isPending(harness: Harness): () => boolean {
  return () => harness.controller.getSnapshot().pendingApproval !== null;
}

interface Harness {
  manager: ApprovalManager;
  controller: SessionController;
  bus: EventBus;
  events: BusEvent[];
  listenerErrors: unknown[];
  prompts: ApprovalRequest[];
  results: ToolExecutionResult[];
  startRun: (calls: ToolCallRequest[]) => Promise<RunOutcome>;
  pendingId: () => string;
  finishedCount: () => number;
  resolvedDecisions: () => ApprovalDecision[];
  phases: () => string[];
}

/** 用真实 Controller 的待批槽位驱动审批：AgentLoop 位置由假 driver 占据。 */
function makeHarness(workspaceRoot: string): Harness {
  const events: BusEvent[] = [];
  const listenerErrors: unknown[] = [];
  const prompts: ApprovalRequest[] = [];
  const results: ToolExecutionResult[] = [];
  const bus = new EventBus({ onListenerError: (error) => listenerErrors.push(error) });
  bus.subscribe((event) => events.push(event));

  let handle: RunHandle | null = null;
  const approver: Approver = async (request) => {
    prompts.push(request);
    if (!handle) throw new Error("approver invoked without an active Run");
    return handle.requestApproval({ toolCallId: request.toolCallId, toolName: request.toolName });
  };
  const manager = new ApprovalManager({ approver });
  const executor = wireExecutor(workspaceRoot, manager);

  let queue: ToolCallRequest[] = [];
  const driver: AgentLoopDriver = {
    execute: async (activeHandle, signal) => {
      handle = activeHandle;
      for (const toolCall of queue) {
        results.push(await executor.execute(toolCall, { signal }));
      }
      handle = null;
      return { outcome: "completed" };
    },
  };
  const controller = new SessionController({ driver, bus });

  return {
    manager,
    controller,
    bus,
    events,
    listenerErrors,
    prompts,
    results,
    startRun: (calls) => {
      queue = calls;
      return controller.submitPrompt("go");
    },
    pendingId: () => {
      const pending = controller.getSnapshot().pendingApproval;
      if (!pending) throw new Error("no pending approval in snapshot");
      return pending.id;
    },
    finishedCount: () => events.filter((event) => event.type === "run.finished").length,
    phases: () =>
      events
        .filter((event): event is RunStateChangedEvent => event.type === "run.state_changed")
        .map((event) => event.phase),
    resolvedDecisions: () =>
      events
        .filter((event): event is PermissionResolvedEvent => event.type === "permission.resolved")
        .map((event) => event.decision),
  };
}

describe("V2 会话授权：文件工具按工具名", () => {
  it("选“本会话允许”后同名工具免问，不同工具名仍询问", async () => {
    const root = makeWorkspace();
    const mock = mockApprover(["session", "session"]);
    const executor = wireExecutor(root, new ApprovalManager({ approver: mock.approver }));

    expect((await executor.execute(call("c1", "write", { path: "a.txt", content: "one" }))).status).toBe(
      "success",
    );
    expect((await executor.execute(call("c2", "write", { path: "b.txt", content: "two" }))).status).toBe(
      "success",
    );
    expect(mock.prompts).toHaveLength(1);

    const edited = await executor.execute(
      call("c3", "edit", { path: "a.txt", old_string: "one", new_string: "three" }),
    );
    expect(edited.status).toBe("success");
    expect(mock.prompts).toHaveLength(2);
    expect(mock.prompts[1]?.toolName).toBe("edit");
    expect(readFileAt(root, "a.txt")).toBe("three");
  });

  it("选“允许一次”不写入会话授权，下一次仍询问", async () => {
    const root = makeWorkspace();
    const mock = mockApprover(["once", "once"]);
    const manager = new ApprovalManager({ approver: mock.approver });

    expect(await manager.requestPermission(writeSubject(root, "a.txt"))).toEqual({
      decision: "allow",
      basis: "approved_once",
    });
    expect(manager.grants.fileTools.size).toBe(0);
    expect(await manager.requestPermission(writeSubject(root, "a.txt"))).toEqual({
      decision: "allow",
      basis: "approved_once",
    });
    expect(mock.prompts).toHaveLength(2);
  });

  it("新 Session 实例不继承授权（含 /resume 派生的新 Session）", async () => {
    const root = makeWorkspace();
    const first = new ApprovalManager({ approver: mockApprover(["session"]).approver });
    await first.requestPermission(writeSubject(root, "a.txt"));
    expect(first.grants.fileTools.has("write")).toBe(true);

    const resumeMock = mockApprover(["deny"]);
    const resumed = new ApprovalManager({ approver: resumeMock.approver });
    expect(await resumed.requestPermission(writeSubject(root, "a.txt"))).toEqual({
      decision: "deny",
      reason: "denied_by_user",
    });
    expect(resumeMock.prompts).toHaveLength(1);
  });

  it("同一 Session 跨 Run 授权持续有效，第二次 Run 不再产生审批事件", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);

    const firstRun = harness.startRun([call("c1", "write", { path: "a.txt", content: "one" })]);
    await waitFor(isPending(harness), "first write approval");
    harness.controller.resolveApproval(harness.pendingId(), "session");
    expect(await firstRun).toBe("completed");
    expect(harness.prompts).toHaveLength(1);

    const secondRun = harness.startRun([call("c2", "write", { path: "b.txt", content: "two" })]);
    expect(await secondRun).toBe("completed");
    expect(harness.prompts).toHaveLength(1);
    expect(harness.events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
    expect(readFileAt(root, "b.txt")).toBe("two");
  });
});

describe("V3 会话授权：Shell 仅完全相同的命令字符串", () => {
  it("授权只记录完整命令串，任何差异都重新询问", async () => {
    const command = "git status";
    const mock = mockApprover(["session", "deny", "deny", "deny", "deny"]);
    const manager = new ApprovalManager({ approver: mock.approver });

    expect(await manager.requestPermission(shellSubject(command))).toEqual({
      decision: "allow",
      basis: "approved_for_session",
    });
    expect(manager.grants.shellCommands).toEqual(new Set([command]));

    for (const variant of ["git  status", "git status ", "Git status", "git status --short"]) {
      expect(await manager.requestPermission(shellSubject(variant))).toEqual({
        decision: "deny",
        reason: "denied_by_user",
      });
    }
    expect(mock.prompts).toHaveLength(5);
    expect(manager.grants.shellCommands).toEqual(new Set([command]));
  });

  it("同一命令跨 Run 免问，另一命令仍需审批", async () => {
    const root = makeWorkspace();
    const command = "echo shana-granted";
    const harness = makeHarness(root);

    const firstRun = harness.startRun([call("c1", shellName, { command })]);
    await waitFor(isPending(harness), "first shell approval");
    harness.controller.resolveApproval(harness.pendingId(), "session");
    expect(await firstRun).toBe("completed");

    const other = "echo shana-other";
    const secondRun = harness.startRun([
      call("c2", shellName, { command }),
      call("c3", shellName, { command: other }),
    ]);
    await waitFor(() => harness.prompts.length === 2, "second shell approval");
    expect(harness.prompts.map((prompt) => prompt.command)).toEqual([command, other]);
    harness.controller.resolveApproval(harness.pendingId(), "deny");
    expect(await secondRun).toBe("completed");
    // results 跨 Run 累积：第一次 Run 的 echo、免问复用的 echo、被拒的 echo
    expect(harness.results.map((result) => result.status)).toEqual(["success", "success", "denied"]);
  });
});

describe("V4 工作区外访问", () => {
  function outsideWorkspace(): { root: string; parent: string } {
    const parent = tempDir("shana-parent-");
    const root = path.join(parent, "ws");
    fs.mkdirSync(root);
    return { root, parent };
  }

  it("区外写入合并为一次综合审批，内容含工具名、规范化路径与本次操作", async () => {
    const { root, parent } = outsideWorkspace();
    const mock = mockApprover(["once"]);
    const manager = new ApprovalManager({ approver: mock.approver });

    expect(await manager.requestPermission(writeSubject(root, "../out.txt"))).toEqual({
      decision: "allow",
      basis: "approved_once",
    });
    expect(mock.prompts).toHaveLength(1);
    expect(mock.prompts[0]).toMatchObject({
      toolName: "write",
      access: "write",
      operation: "create",
      touchesOutsideWorkspace: true,
      paths: [path.join(fs.realpathSync.native(parent), "out.txt")],
    });
  });

  it("已有工具名会话授权时区外写入仍每次单独询问", async () => {
    const { root } = outsideWorkspace();
    const mock = mockApprover(["session", "session"]);
    const manager = new ApprovalManager({ approver: mock.approver });

    for (const relative of ["a.txt", "b.txt", "../outside.txt"]) {
      expect((await manager.requestPermission(writeSubject(root, relative))).decision).toBe("allow");
    }
    expect(mock.prompts.map((prompt) => prompt.touchesOutsideWorkspace)).toEqual([false, true]);
  });

  it("区外读取与区外搜索每次都询问", async () => {
    const { root, parent } = outsideWorkspace();
    fs.writeFileSync(path.join(parent, "secret.txt"), "secret");
    const mock = mockApprover(["session", "session"]);
    const manager = new ApprovalManager({ approver: mock.approver });

    expect(await manager.requestPermission(readSubject(root, "../secret.txt"))).toEqual({
      decision: "allow",
      basis: "approved_once",
    });
    expect(await manager.requestPermission(readSubject(root, "../secret.txt", "grep"))).toEqual({
      decision: "allow",
      basis: "approved_once",
    });
    expect(manager.grants.fileTools.size).toBe(0);
    expect(mock.prompts).toHaveLength(2);
  });
});

describe("V5 没有审批处理器", () => {
  it("待审批工具默认拒绝且不产生副作用，区内只读不受影响", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "keep.txt", "original");
    const manager = new ApprovalManager();

    expect(await manager.requestPermission(writeSubject(root, "new.txt"))).toEqual({
      decision: "deny",
      reason: "no_approver",
    });
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
    expect(await manager.requestPermission(readSubject(root, "keep.txt"))).toEqual({
      decision: "allow",
      basis: "workspace_read",
    });
  });

  it("审批器抛异常按拒绝处理，不静默放行", async () => {
    const root = makeWorkspace();
    const manager = new ApprovalManager({
      approver: async () => {
        throw new Error("approval UI crashed");
      },
    });

    expect(await manager.requestPermission(writeSubject(root, "new.txt"))).toEqual({
      decision: "deny",
      reason: "approver_error",
    });
    expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  it("审批器待决期间不擅自允许：未 resolve 前工具未执行", async () => {
    const root = makeWorkspace();
    const mock = mockApprover();
    const executor = wireExecutor(root, new ApprovalManager({ approver: mock.approver }));

    const pending = executor.execute(call("c1", "write", { path: "a.txt", content: "x" }));
    await tick();
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);

    mock.resolveNext("once");
    expect((await pending).status).toBe("success");
  });
});

describe("V6 取消与清理", () => {
  it("待批中 cancel 立即唤醒审批并清理待决，工具返回 not_executed", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);

    const run = harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
    await waitFor(isPending(harness), "write approval");
    expect(harness.controller.getSnapshot().pendingApproval).not.toBeNull();
    harness.controller.cancel();

    expect(await run).toBe("cancelled");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(harness.controller.getSnapshot().pendingApproval).toBeNull();
    expect(harness.results[0]).toMatchObject({ status: "not_executed", errorCategory: "cancelled" });
    expect(harness.resolvedDecisions()).toEqual(["cancelled"]);
    expect(harness.phases()).toContain("cancelling");
    expect(harness.finishedCount()).toBe(1);
  });

  it("TUI 退出同样唤醒并清理待决请求，无悬挂", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);

    harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
    await waitFor(isPending(harness), "write approval before exit");
    await expect(harness.controller.exit()).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: { kind: "idle" },
      pendingApproval: null,
    });
    expect(harness.finishedCount()).toBe(1);
  });

  it("resolve 只作用于当前待批：错误 id 被安全拒绝且不影响判定", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);

    const run = harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
    await waitFor(isPending(harness), "write approval");
    const currentId = harness.pendingId();
    expect(() => harness.controller.resolveApproval("approval-999", "once")).toThrow(InvalidStateError);
    expect(harness.controller.getSnapshot().pendingApproval?.id).toBe(currentId);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);

    harness.controller.resolveApproval(currentId, "once");
    expect(await run).toBe("completed");
    expect(readFileAt(root, "a.txt")).toBe("x");
  });

  it("取消后晚到的 resolve 无效，不产生第二次收尾或副作用", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);

    const run = harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
    await waitFor(isPending(harness), "write approval");
    const staleId = harness.pendingId();
    harness.controller.cancel();
    expect(await run).toBe("cancelled");

    expect(() => harness.controller.resolveApproval(staleId, "once")).toThrow(InvalidStateError);
    expect(harness.finishedCount()).toBe(1);
    expect(harness.resolvedDecisions()).toEqual(["cancelled"]);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("权限待决无默认超时：长时间等待后仍保持待批", async () => {
    vi.useFakeTimers();
    try {
      const root = makeWorkspace();
      const harness = makeHarness(root);

      const run = harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
      await vi.advanceTimersByTimeAsync(0);
      const pending = harness.controller.getSnapshot().pendingApproval;
      expect(pending).not.toBeNull();

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(harness.controller.getSnapshot().pendingApproval).toEqual(pending);
      expect(harness.results).toHaveLength(0);

      harness.controller.resolveApproval(pending!.id, "once");
      await vi.advanceTimersByTimeAsync(0);
      expect(await run).toBe("completed");
      expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("V7 拒绝结果为确定值", () => {
  it("拒绝返回确定 denied 并区分拒绝来源，同批后续工具继续执行", async () => {
    const root = makeWorkspace();
    writeFileAt(root, "keep.txt", "original");
    const mock = mockApprover(["deny"]);
    const executor = wireExecutor(root, new ApprovalManager({ approver: mock.approver }));

    const denied = await executor.execute(call("c1", "write", { path: "a.txt", content: "x" }));
    expect(denied).toMatchObject({
      status: "denied",
      errorCategory: "permission",
      content: "Error: User denied.",
    });
    const next = await executor.execute(call("c2", "read", { path: "keep.txt" }));
    expect(next.status).toBe("success");
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });
});

describe("V9 事件通知", () => {
  it("顺序为 requested→resolved，监听器异常不影响判定与执行", async () => {
    const root = makeWorkspace();
    const harness = makeHarness(root);
    harness.bus.subscribe(() => {
      throw new Error("listener crashed");
    });

    const run = harness.startRun([call("c1", "write", { path: "a.txt", content: "x" })]);
    await waitFor(isPending(harness), "write approval");
    harness.controller.resolveApproval(harness.pendingId(), "session");

    expect(await run).toBe("completed");
    expect(harness.listenerErrors.length).toBeGreaterThan(0);
    expect(
      harness.events.filter((event) => event.type.startsWith("permission.")).map((event) => event.type),
    ).toEqual(["permission.requested", "permission.resolved"]);
    expect(readFileAt(root, "a.txt")).toBe("x");
  });
});
