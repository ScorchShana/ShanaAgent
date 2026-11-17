import { describe, expect, it } from "vitest";
import type { BusEvent, RunFinishedEvent } from "../../src/core/events.js";
import type { CompactionOutcome } from "../../src/sessions/compaction-store.js";
import {
  SessionController,
  type AgentLoopDriver,
  type LoopEnd,
  type RunHandle,
} from "../../src/core/session-controller.js";
import { BusyError, InvalidStateError, NotImplementedCommandError } from "../../src/core/state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeController(
  driver: AgentLoopDriver,
  extras: {
    hooks?: ConstructorParameters<typeof SessionController>[0]["hooks"];
    compactor?: ConstructorParameters<typeof SessionController>[0]["compactor"];
  } = {},
) {
  const events: BusEvent[] = [];
  const controller = new SessionController({ driver, hooks: extras.hooks, compactor: extras.compactor });
  controller.eventBus.subscribe((event) => events.push(event));
  const snapshots = controller.getSnapshot.bind(controller);
  return { controller, events, snapshots };
}

function finishedEvents(events: BusEvent[]): RunFinishedEvent[] {
  return events.filter((e): e is RunFinishedEvent => e.type === "run.finished");
}

const idleDriver: AgentLoopDriver = {
  execute: () => Promise.resolve({ outcome: "completed" }),
};

const completedCompaction: CompactionOutcome = { status: "completed", coveredUpTo: 3, path: "primary" };
const cancelledCompaction: CompactionOutcome = { status: "cancelled", coveredUpTo: null, path: "primary" };

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("V1 同步占有", () => {
  it("同一 tick 两次 submitPrompt 只有一个成功，另一个同步得到 Busy；无队列", async () => {
    const gate = deferred<LoopEnd>();
    const driver: AgentLoopDriver = { execute: () => gate.promise };
    const { controller, events } = makeController(driver);

    const first = controller.submitPrompt("hello");
    expect(() => controller.submitPrompt("again")).toThrow(BusyError);
    gate.resolve({ outcome: "completed" });
    await expect(first).resolves.toBe("completed");
    expect(finishedEvents(events)).toHaveLength(1);
  });

  it("submit 与 compact 并发：运行中 compact 同步被拒", async () => {
    const gate = deferred<LoopEnd>();
    const driver: AgentLoopDriver = { execute: () => gate.promise };
    const { controller } = makeController(driver, {
      compactor: { execute: () => Promise.resolve(completedCompaction) },
    });
    const run = controller.submitPrompt("hi");
    expect(() => controller.compact()).toThrow(BusyError);
    gate.resolve({ outcome: "completed" });
    await run;
  });
});

describe("V2 运行中命令限制", () => {
  it("运行中 /model /new /resume /sessions 与普通命令被拒，cancel 与 approval.resolve 可用", async () => {
    const approvalGate = deferred<string>();
    let handleRef: RunHandle | null = null;
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handleRef = handle;
        handle.reportPhase("executing_tool");
        const decision = await handle.requestApproval({ toolCallId: "c1", toolName: "write" });
        await approvalGate.promise;
        return decision === "cancelled"
          ? { outcome: "failed", error: new Error("aborted") }
          : { outcome: "completed" };
      },
    };
    const { controller, events, snapshots } = makeController(driver);
    const run = controller.submitPrompt("run");

    expect(() => controller.switchModel()).toThrow(BusyError);
    expect(() => controller.newSession()).toThrow(BusyError);
    expect(() => controller.resumeSession()).toThrow(BusyError);
    expect(() => controller.listSessions()).toThrow(BusyError);
    expect(() => controller.submitPrompt("more")).toThrow(BusyError);
    await nextTick();
    expect(snapshots().status).toEqual({ kind: "running", runId: "run-1", phase: "awaiting_approval" });
    expect(snapshots().pendingApproval?.toolName).toBe("write");

    controller.resolveApproval("approval-1", "once");
    controller.cancel();
    approvalGate.resolve("go");
    await expect(run).resolves.toBe("cancelled");
    expect(handleRef).not.toBeNull();
    expect(finishedEvents(events)[0]?.outcome).toBe("cancelled");
  });

  it("空闲时会话命令以未实现错误返回（真实实现属 T4/T5/T9）", async () => {
    const { controller } = makeController(idleDriver);
    expect(() => controller.switchModel()).toThrow(NotImplementedCommandError);
    expect(() => controller.newSession()).toThrow(NotImplementedCommandError);
    expect(() => controller.resumeSession()).toThrow(NotImplementedCommandError);
    expect(() => controller.listSessions()).toThrow(NotImplementedCommandError);
  });

  it("approval.resolve 只针对当前待决审批", async () => {
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        const p = handle.requestApproval({ toolCallId: "c1", toolName: "write" });
        return p.then(() => ({ outcome: "completed" }));
      },
    };
    const { controller } = makeController(driver);
    const run = controller.submitPrompt("x");
    await nextTick();
    expect(() => controller.resolveApproval("approval-999", "once")).toThrow(InvalidStateError);
    controller.resolveApproval("approval-1", "deny");
    await expect(run).resolves.toBe("completed");
  });
});

describe("V3 独占压缩", () => {
  it("compacting 与 Run 互斥；压缩期间提交被拒；压缩可取消并回到 idle", async () => {
    const compactionGate = deferred<CompactionOutcome>();
    const signals: AbortSignal[] = [];
    const compactor = {
      execute: (signal: AbortSignal) => {
        signals.push(signal);
        return compactionGate.promise;
      },
    };
    const { controller, snapshots } = makeController(idleDriver, { compactor });
    const compacting = controller.compact();
    expect(snapshots().status).toEqual({ kind: "compacting" });
    expect(() => controller.submitPrompt("nope")).toThrow(InvalidStateError);
    expect(() => controller.compact()).toThrow(BusyError);

    controller.cancel();
    expect(signals[0]?.aborted).toBe(true);
    compactionGate.resolve(cancelledCompaction);
    await expect(compacting).resolves.toEqual(cancelledCompaction);
    expect(snapshots().status).toEqual({ kind: "idle" });
  });

  it("压缩正常结束后回到 idle", async () => {
    const { controller, snapshots } = makeController(idleDriver, {
      compactor: { execute: () => Promise.resolve(completedCompaction) },
    });
    await controller.compact();
    expect(snapshots().status).toEqual({ kind: "idle" });
  });
});

describe("T10 手动压缩（§14.8 Controller 侧）", () => {
  it("无 compactor 时同步抛 NotImplementedCommandError，状态保持 idle 且无事件", () => {
    const { controller, events, snapshots } = makeController(idleDriver);
    expect(() => controller.compact()).toThrow(NotImplementedCommandError);
    expect(snapshots().status).toEqual({ kind: "idle" });
    expect(events).toHaveLength(0);
  });

  it("completed：发布 started/finished 并透传 outcome", async () => {
    const { controller, events } = makeController(idleDriver, {
      compactor: { execute: () => Promise.resolve(completedCompaction) },
    });
    await expect(controller.compact()).resolves.toEqual(completedCompaction);
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.finished", status: "completed", path: "primary", coveredUpTo: 3 },
    ]);
  });

  it.each(["noop", "cancelled"] as const)("%s：finished 不携带 path/coveredUpTo", async (status) => {
    const outcome: CompactionOutcome = { status, coveredUpTo: null, path: "fallback" };
    const { controller, events } = makeController(idleDriver, {
      compactor: { execute: () => Promise.resolve(outcome) },
    });
    await expect(controller.compact()).resolves.toEqual(outcome);
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.finished", status },
    ]);
  });

  it("失败：finished 携带错误、Promise 拒绝、回到 idle", async () => {
    const failure = new Error("摘要为空");
    const { controller, events, snapshots } = makeController(idleDriver, {
      compactor: { execute: () => Promise.reject(failure) },
    });
    await expect(controller.compact()).rejects.toBe(failure);
    expect(events).toEqual([
      { type: "compaction.started" },
      { type: "compaction.finished", status: "failed", error: "摘要为空" },
    ]);
    expect(snapshots().status).toEqual({ kind: "idle" });
  });

  it("压缩期间会话命令被拒，结束后恢复可用", async () => {
    const gate = deferred<CompactionOutcome>();
    const { controller } = makeController(idleDriver, { compactor: { execute: () => gate.promise } });
    const compacting = controller.compact();
    expect(() => controller.switchModel("p", "m")).toThrow(InvalidStateError);
    expect(() => controller.newSession()).toThrow(InvalidStateError);
    expect(() => controller.resumeSession()).toThrow(InvalidStateError);
    expect(() => controller.listSessions()).toThrow(InvalidStateError);
    gate.resolve(completedCompaction);
    await compacting;
    expect(() => controller.newSession()).toThrow(NotImplementedCommandError);
  });

  it("压缩失败时 exit 只等待收尾，不因此拒绝", async () => {
    const gate = deferred<CompactionOutcome>();
    let signal: AbortSignal | undefined;
    const { controller, snapshots } = makeController(idleDriver, {
      compactor: {
        execute: (abortSignal) => {
          signal = abortSignal;
          return gate.promise;
        },
      },
    });
    const compacting = controller.compact();
    const exiting = controller.exit();
    await nextTick();
    expect(signal?.aborted).toBe(true);
    const rejected = expect(compacting).rejects.toThrow("compaction exploded");
    gate.reject(new Error("compaction exploded"));
    await rejected;
    await expect(exiting).resolves.toBeUndefined();
    expect(snapshots().status).toEqual({ kind: "idle" });
  });
});

describe("V4 快照/订阅无竞态", () => {
  it("快照与订阅同一操作取得；之后的事件无遗漏、无重复；快照为轻量快照", async () => {
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handle.reportPhase("streaming");
        handle.streamText("answer");
        handle.notifyToolStarted("t1", "read");
        await handle.notifyToolCompleted("t1");
        return { outcome: "completed" };
      },
    };
    const { controller } = makeController(driver);
    const seen: BusEvent[] = [];
    const { snapshot, unsubscribe } = controller.subscribe((event) => seen.push(event));
    expect(snapshot.status).toEqual({ kind: "idle" });
    expect(Object.keys(snapshot).sort()).toEqual([
      "accumulatedText",
      "accumulatedThinking",
      "lastRun",
      "pendingApproval",
      "runTiming",
      "session",
      "sessionOperation",
      "status",
      "streamingAttempts",
    ]);

    await controller.submitPrompt("hi");
    const formalTypes = seen.filter((e) => !e.type.startsWith("llm."));
    expect(formalTypes.map((e) => e.type)).toEqual([
      "run.started",
      "run.state_changed",
      "tool.started",
      "tool.completed",
      "run.state_changed",
      "run.finished",
    ]);
    const deltas = seen.filter((e) => e.type === "llm.text.delta");
    expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["answer"]);
    expect(seen.filter((e) => e.type === "tool.completed")).toHaveLength(1);
    unsubscribe();
    expect(seen.every((e, i) => seen.indexOf(e) === i)).toBe(true);
  });
});

describe("V5 单次终止", () => {
  it("完成路径：run.finished 恰好一次", async () => {
    for (let i = 0; i < 5; i++) {
      const { controller, events } = makeController(idleDriver);
      await controller.submitPrompt(`run ${i}`);
      expect(finishedEvents(events)).toHaveLength(1);
    }
  });

  it("晚到取消不改变已收尾结果", async () => {
    const { controller, events } = makeController(idleDriver);
    await controller.submitPrompt("done");
    expect(() => controller.cancel()).toThrow(InvalidStateError);
    expect(finishedEvents(events)).toHaveLength(1);
    expect(finishedEvents(events)[0]?.outcome).toBe("completed");
  });

  it("取消路径：收尾后 run.finished 仍只有一次", async () => {
    const gate = deferred<LoopEnd>();
    const driver: AgentLoopDriver = { execute: () => gate.promise };
    const { controller, events } = makeController(driver);
    const run = controller.submitPrompt("x");
    controller.cancel();
    controller.cancel();
    gate.resolve({ outcome: "completed" });
    await expect(run).resolves.toBe("cancelled");
    expect(finishedEvents(events)).toHaveLength(1);
  });

  it("turn_limit 是合法结束原因", async () => {
    const driver: AgentLoopDriver = { execute: () => Promise.resolve({ outcome: "turn_limit" }) };
    const { controller, events } = makeController(driver);
    await expect(controller.submitPrompt("x")).resolves.toBe("turn_limit");
    expect(finishedEvents(events)[0]?.outcome).toBe("turn_limit");
  });
});

describe("V6 取消优先", () => {
  it("终止提交开始前取消，持久化记录与唯一终止事件均为 cancelled", async () => {
    const loop = deferred<LoopEnd>();
    const persisted: string[] = [];
    const { controller, events } = makeController(
      { execute: () => loop.promise },
      {
        hooks: {
          persistRunFinished: async ({ outcome }) => {
            persisted.push(outcome);
          },
        },
      },
    );
    const run = controller.submitPrompt("cancel before commit");
    await nextTick();

    controller.cancel();
    loop.resolve({ outcome: "completed" });

    await expect(run).resolves.toBe("cancelled");
    expect(persisted).toEqual(["cancelled"]);
    expect(finishedEvents(events)).toEqual([
      { type: "run.finished", runId: "run-1", outcome: "cancelled", persisted: true },
    ]);
  });

  it.each(["completed", "turn_limit", "failed"] as const)(
    "终止提交开始后取消返回已进入收尾，保留冻结结果 %s 并等待提交",
    async (outcome) => {
      const entered = deferred<void>();
      const commit = deferred<void>();
      const persisted: string[] = [];
      let signal: AbortSignal | undefined;
      let settled = false;
      const end: LoopEnd = outcome === "failed" ? { outcome, error: new Error("loop failed") } : { outcome };
      const { controller, events } = makeController(
        {
          execute: async (_handle, abortSignal) => {
            signal = abortSignal;
            return end;
          },
        },
        {
          hooks: {
            persistRunFinished: async ({ outcome: finalOutcome }) => {
              persisted.push(finalOutcome);
              entered.resolve();
              await commit.promise;
            },
          },
        },
      );
      const run = controller.submitPrompt("cancel after commit starts").then((result) => {
        settled = true;
        return result;
      });
      await entered.promise;
      const status = controller.getSnapshot().status;

      try {
        expect.soft(controller.cancel()).toBe("已进入收尾");
        expect.soft(controller.cancel()).toBe("已进入收尾");
        expect.soft(controller.getSnapshot().status).toEqual(status);
        expect.soft(signal?.aborted).toBe(false);
        expect(() => controller.submitPrompt("still busy")).toThrow(BusyError);
        await nextTick();
        expect.soft(settled).toBe(false);
        expect.soft(finishedEvents(events)).toHaveLength(0);
      } finally {
        commit.resolve();
      }

      await expect(run).resolves.toBe(outcome);
      expect(persisted).toEqual([outcome]);
      expect(finishedEvents(events)).toHaveLength(1);
      expect(finishedEvents(events)[0]).toMatchObject({ outcome, persisted: true });
      expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
    },
  );

  it("进入终止提交的同步钩子中取消也不能改变结果或中断提交", async () => {
    let notice: unknown;
    let signal: AbortSignal | undefined;
    const { controller, events } = makeController(
      {
        execute: async (_handle, abortSignal) => {
          signal = abortSignal;
          return { outcome: "completed" };
        },
      },
      {
        hooks: {
          persistRunFinished: async () => {
            notice = controller.cancel();
          },
        },
      },
    );

    await expect(controller.submitPrompt("synchronous commit boundary")).resolves.toBe("completed");
    expect.soft(notice).toBe("已进入收尾");
    expect.soft(signal?.aborted).toBe(false);
    expect(finishedEvents(events)).toHaveLength(1);
    expect(finishedEvents(events)[0]).toMatchObject({ outcome: "completed", persisted: true });
  });

  it("提交前已接受取消，开始终止提交后再次取消也返回已进入收尾", async () => {
    const loop = deferred<LoopEnd>();
    const entered = deferred<void>();
    const commit = deferred<void>();
    const persisted: string[] = [];
    const { controller, events } = makeController(
      { execute: () => loop.promise },
      {
        hooks: {
          persistRunFinished: async ({ outcome }) => {
            persisted.push(outcome);
            entered.resolve();
            await commit.promise;
          },
        },
      },
    );
    const run = controller.submitPrompt("cancel before and after commit starts");
    controller.cancel();
    loop.resolve({ outcome: "completed" });
    await entered.promise;
    try {
      expect.soft(controller.cancel()).toBe("已进入收尾");
    } finally {
      commit.resolve();
    }

    await expect(run).resolves.toBe("cancelled");
    expect(persisted).toEqual(["cancelled"]);
    expect(finishedEvents(events)).toHaveLength(1);
    expect(finishedEvents(events)[0]).toMatchObject({ outcome: "cancelled", persisted: true });
  });

  it("冻结结果后收到取消，终止记录写入失败仍仅发布未持久化的 failed", async () => {
    const entered = deferred<void>();
    const commit = deferred<void>();
    const { controller, events } = makeController(idleDriver, {
      hooks: {
        persistRunFinished: async () => {
          entered.resolve();
          await commit.promise;
          throw new Error("terminal fsync failed");
        },
      },
    });
    const run = controller.submitPrompt("commit failure");
    await entered.promise;
    try {
      expect.soft(controller.cancel()).toBe("已进入收尾");
    } finally {
      commit.resolve();
    }

    await expect(run).resolves.toBe("failed");
    expect(finishedEvents(events)).toEqual([
      {
        type: "run.finished",
        runId: "run-1",
        outcome: "failed",
        persisted: false,
        error: "terminal fsync failed",
      },
    ]);
    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
  });

  it("接受取消后即使随后发生错误，最终 outcome 仍为 cancelled", async () => {
    const driver: AgentLoopDriver = {
      execute: (handle, signal) =>
        new Promise<LoopEnd>((resolve) => {
          const fail = () =>
            resolve({ outcome: "failed", error: new Error("network exploded after cancel") });
          if (signal.aborted) {
            fail();
            return;
          }
          signal.addEventListener("abort", fail, { once: true });
        }),
    };
    const { controller, events } = makeController(driver);
    const run = controller.submitPrompt("x");
    controller.cancel();
    await expect(run).resolves.toBe("cancelled");
    expect(finishedEvents(events)[0]?.outcome).toBe("cancelled");
  });

  it("取消时立即解除未决审批，等待中的 loop 收到 cancelled 决定", async () => {
    const decisions: string[] = [];
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        const decision = await handle.requestApproval({ toolCallId: "c1", toolName: "edit" });
        decisions.push(decision);
        return { outcome: "completed" };
      },
    };
    const { controller } = makeController(driver);
    const run = controller.submitPrompt("x");
    await nextTick();
    controller.cancel();
    await expect(run).resolves.toBe("cancelled");
    expect(decisions).toEqual(["cancelled"]);
  });
});

describe("V7 持久化失败收尾", () => {
  it("终止记录写入失败：内存终结、发布标注未持久化的 failed、UI 可观察到非 Running", async () => {
    const hooks = {
      persistRunFinished: () => Promise.reject(new Error("disk full")),
    };
    const { controller, events, snapshots } = makeController(idleDriver, { hooks });
    await controller.submitPrompt("x");
    const finished = finishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.outcome).toBe("failed");
    expect(finished[0]?.persisted).toBe(false);
    expect(finished[0]?.error).toContain("disk full");
    expect(snapshots().status).toEqual({ kind: "idle" });
    expect(snapshots().lastRun).toEqual({
      runId: "run-1",
      outcome: "failed",
      persisted: false,
      elapsedMs: expect.any(Number),
    });
  });

  it("Run 启动持久化失败同样以未持久化的 failed 收尾", async () => {
    const hooks = { persistRunStart: () => Promise.reject(new Error("read only fs")) };
    const { controller, events } = makeController(idleDriver, { hooks });
    await expect(controller.submitPrompt("x")).resolves.toBe("failed");
    const finished = finishedEvents(events);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.persisted).toBe(false);
  });

  it("成功路径标记 persisted=true，不伪装失败", async () => {
    const { controller, events } = makeController(idleDriver);
    await controller.submitPrompt("x");
    expect(finishedEvents(events)[0]).toMatchObject({ outcome: "completed", persisted: true });
  });
});

describe("V8 事件边界", () => {
  it("tool.completed 在持久化钩子成功后才发布", async () => {
    const calls: string[] = [];
    const hooks = {
      persistToolCompleted: async (toolCallId: string) => {
        calls.push(`persist:${toolCallId}`);
      },
    };
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handle.notifyToolStarted("t1", "read");
        await handle.notifyToolCompleted("t1");
        return { outcome: "completed" };
      },
    };
    const { controller, events } = makeController(driver, { hooks });
    await controller.submitPrompt("x");
    expect(calls).toEqual(["persist:t1"]);
    const toolCompletedIndex = events.findIndex((e) => e.type === "tool.completed");
    expect(toolCompletedIndex).toBeGreaterThan(-1);
    expect(events.slice(0, toolCompletedIndex).some((e) => e.type === "tool.completed")).toBe(false);
  });

  it("工具持久化失败进入失败路径且不发布 tool.completed", async () => {
    const hooks = { persistToolCompleted: () => Promise.reject(new Error("fsync failed")) };
    const caught: string[] = [];
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        try {
          await handle.notifyToolCompleted("t1");
        } catch (error) {
          caught.push((error as Error).message);
        }
        return { outcome: "completed" };
      },
    };
    const { controller, events } = makeController(driver, { hooks });
    await controller.submitPrompt("x");
    expect(caught).toEqual(["fsync failed"]);
    expect(events.some((e) => e.type === "tool.completed")).toBe(false);
  });

  it("流式 delta 合并且不影响权威快照文本", async () => {
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handle.streamText("a");
        handle.streamText("b");
        handle.streamText("c");
        return { outcome: "completed" };
      },
    };
    const { controller, events, snapshots } = makeController(driver);
    await controller.submitPrompt("x");
    const deltas = events.filter((e) => e.type === "llm.text.delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { delta: string }).delta).toBe("abc");
    expect(snapshots().accumulatedText).toBe("abc");
  });

  it("监听器抛异常不影响主流程收尾", async () => {
    const { controller, events } = makeController(idleDriver);
    controller.eventBus.subscribe(() => {
      throw new Error("ui crash");
    });
    await expect(controller.submitPrompt("x")).resolves.toBe("completed");
    expect(finishedEvents(events)).toHaveLength(1);
  });
});

describe("exit 受管理收尾", () => {
  it("压缩期间 exit 请求取消，并等待压缩清理结束后才返回", async () => {
    const cleanup = deferred<CompactionOutcome>();
    let signal: AbortSignal | undefined;
    let exitSettled = false;
    const { controller, events } = makeController(idleDriver, {
      compactor: {
        execute: (abortSignal) => {
          signal = abortSignal;
          return cleanup.promise;
        },
      },
    });
    const compacting = controller.compact();
    const exiting = controller.exit().then(() => {
      exitSettled = true;
    });

    try {
      await nextTick();
      expect.soft(signal?.aborted).toBe(true);
      expect.soft(exitSettled).toBe(false);
      expect.soft(controller.getSnapshot().status).toEqual({ kind: "compacting" });
      expect(() => controller.submitPrompt("cleanup pending")).toThrow(InvalidStateError);
    } finally {
      cleanup.resolve(cancelledCompaction);
      await Promise.all([compacting, exiting]);
    }

    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
    expect(finishedEvents(events)).toHaveLength(0);
  });

  it("终止记录提交期间 exit 等待持久化，不将冻结结果改成取消", async () => {
    const entered = deferred<void>();
    const commit = deferred<void>();
    let signal: AbortSignal | undefined;
    let exitSettled = false;
    const { controller, events } = makeController(
      {
        execute: async (_handle, abortSignal) => {
          signal = abortSignal;
          return { outcome: "completed" };
        },
      },
      {
        hooks: {
          persistRunFinished: async () => {
            entered.resolve();
            await commit.promise;
          },
        },
      },
    );
    const run = controller.submitPrompt("exit during commit");
    await entered.promise;
    const exiting = controller.exit().then(() => {
      exitSettled = true;
    });

    try {
      await nextTick();
      expect.soft(exitSettled).toBe(false);
      expect.soft(signal?.aborted).toBe(false);
      expect.soft(finishedEvents(events)).toHaveLength(0);
    } finally {
      commit.resolve();
      await exiting;
    }

    await expect(run).resolves.toBe("completed");
    expect(finishedEvents(events)).toHaveLength(1);
    expect(finishedEvents(events)[0]).toMatchObject({ outcome: "completed", persisted: true });
  });

  it("运行中 exit 触发取消并等待 Run 收尾", async () => {
    const driver: AgentLoopDriver = {
      execute: (handle, signal) =>
        new Promise<LoopEnd>((resolve) => {
          const finish = () => setTimeout(() => resolve({ outcome: "completed" }), 5);
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener("abort", finish, { once: true });
        }),
    };
    const { controller, events } = makeController(driver);
    void controller.submitPrompt("x");
    await nextTick();
    await controller.exit();
    expect(finishedEvents(events)[0]?.outcome).toBe("cancelled");
    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
  });

  it("空闲时 exit 直接返回，状态保持 idle", async () => {
    const { controller } = makeController(idleDriver);
    await controller.exit();
    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
  });
});

describe("V2/V3 补充：阶段流转与 delta 流", () => {
  it("AgentLoop 只报告阶段，状态所有权在 Controller", async () => {
    const phases: string[] = [];
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handle.reportPhase("preparing");
        handle.reportPhase("streaming");
        handle.reportPhase("executing_tool");
        return { outcome: "completed" };
      },
    };
    const { controller, events } = makeController(driver);
    await controller.submitPrompt("x");
    for (const event of events) {
      if (event.type === "run.state_changed") phases.push(event.phase);
    }
    expect(phases).toEqual(["preparing", "streaming", "executing_tool", "finalizing"]);
    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
  });
});

describe("T8 Run input and approval cancellation", () => {
  it("passes the exact submitted prompt to the driver", async () => {
    let received: string | undefined;
    const { controller } = makeController({
      execute: async (handle) => {
        received = handle.prompt;
        return { outcome: "completed" };
      },
    });
    await controller.submitPrompt("  original prompt\n");
    expect(received).toBe("  original prompt\n");
  });

  it("publishes exactly one cancelled resolution and preserves full approval summary", async () => {
    const parameters = { path: "file.txt", content: "x".repeat(12000) };
    const { controller, events } = makeController({
      execute: async (handle) => {
        await handle.requestApproval({
          toolCallId: "c1",
          toolName: "write",
          summary: {
            paths: ["/workspace/file.txt"],
            operation: "write",
            touchesOutsideWorkspace: false,
            parameters,
          },
        });
        return { outcome: "completed" };
      },
    });
    const run = controller.submitPrompt("edit");
    await nextTick();
    expect(controller.getSnapshot().pendingApproval?.summary?.parameters).toEqual(parameters);
    controller.cancel();
    controller.cancel();
    await expect(run).resolves.toBe("cancelled");
    expect(events.filter((event) => event.type === "permission.resolved")).toEqual([
      { type: "permission.resolved", approvalId: "approval-1", decision: "cancelled" },
    ]);
  });
});

describe("approval synchronous notification ordering", () => {
  it.each(["once", "cancelled", "phase_cancel"] as const)(
    "handles immediate %s without losing the decision",
    async (mode) => {
      let decision: string | undefined;
      const { controller, events } = makeController({
        execute: async (handle) => {
          decision = await handle.requestApproval({ toolCallId: "c", toolName: "write" });
          return { outcome: "completed" };
        },
      });
      controller.eventBus.subscribe((event) => {
        if (
          mode === "phase_cancel" &&
          event.type === "run.state_changed" &&
          event.phase === "awaiting_approval"
        )
          controller.cancel();
        if (event.type === "permission.requested") {
          if (mode === "once") controller.resolveApproval(event.approvalId, "once");
          else controller.cancel();
        }
      });
      const result = await Promise.race([
        controller.submitPrompt("test"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
      ]);
      expect(result).toBe(mode === "once" ? "completed" : "cancelled");
      expect(decision).toBe(mode === "once" ? "once" : "cancelled");
      expect(controller.getSnapshot().pendingApproval).toBeNull();
      expect(events.filter((e) => e.type === "permission.resolved")).toHaveLength(1);
      expect(finishedEvents(events)).toHaveLength(1);
      if (mode === "phase_cancel") expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    },
  );

  it("consumes approval before notifying listeners and rejects repeated resolution", async () => {
    let decision: string | undefined;
    let duplicateRejected = false;
    const { controller, events } = makeController({
      execute: async (handle) => {
        decision = await handle.requestApproval({ toolCallId: "c", toolName: "write" });
        return { outcome: "completed" };
      },
    });
    controller.eventBus.subscribe((event) => {
      if (event.type === "permission.requested") controller.resolveApproval(event.approvalId, "once");
      if (event.type === "permission.resolved") {
        expect(controller.getSnapshot().pendingApproval).toBeNull();
        try {
          controller.resolveApproval(event.approvalId, "deny");
        } catch {
          duplicateRejected = true;
        }
      }
    });
    const outcome = await Promise.race([
      controller.submitPrompt("test"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);
    expect(outcome).toBe("completed");
    expect(duplicateRejected).toBe(true);
    expect(decision).toBe("once");
    expect(events.filter((e) => e.type === "permission.resolved")).toHaveLength(1);
  });
});

describe("T9 commands", () => {
  it("serializes Session commands and rejects prompt submission until they settle", async () => {
    const pending = deferred<void>();
    const controller = new SessionController({
      driver: idleDriver,
      commands: {
        newSession: () => pending.promise,
      },
    });
    const command = controller.newSession();
    expect(controller.getSnapshot().sessionOperation).toBe(true);
    expect(() => controller.submitPrompt("blocked")).toThrow(BusyError);
    expect(() => controller.newSession()).toThrow(BusyError);
    pending.resolve();
    await command;
    expect(controller.getSnapshot().sessionOperation).toBe(false);
    await expect(controller.submitPrompt("allowed")).resolves.toBe("completed");
  });
  it("permits effort changes during a Run but rejects switching models", async () => {
    const gate = deferred<LoopEnd>();
    const calls: string[] = [];
    const controller = new SessionController({
      driver: { execute: () => gate.promise },
      commands: {
        setReasoningEffort: async (effort) => {
          calls.push(effort);
        },
        switchModel: async () => {},
      },
    });
    const run = controller.submitPrompt("run");
    expect(() => controller.switchModel("p", "m")).toThrow(BusyError);
    await controller.setReasoningEffort("low");
    expect(calls).toEqual(["low"]);
    gate.resolve({ outcome: "completed" });
    await run;
  });
});

describe("Run monotonic duration", () => {
  it.each(["completed", "failed", "turn_limit", "cancelled"] as const)(
    "freezes %s before terminal commit",
    async (outcome) => {
      let now = 100;
      const commit = deferred<void>();
      const execution = deferred<LoopEnd>();
      let stored: unknown;
      const controller = new SessionController({
        now: () => now,
        driver: { execute: () => execution.promise },
        hooks: {
          persistRunFinished: async (info) => {
            stored = info;
            await commit.promise;
          },
        },
      });
      const run = controller.submitPrompt("timed");
      await nextTick();
      now = 62234.9;
      expect(controller.getRunTiming()).toEqual({ runId: "run-1", elapsedMs: 62134 });
      if (outcome === "cancelled") controller.cancel();
      execution.resolve(
        outcome === "failed"
          ? { outcome, error: new Error("failure") }
          : { outcome: outcome === "cancelled" ? "completed" : outcome },
      );
      await nextTick();
      expect(controller.getSnapshot().status).toMatchObject({ phase: "finalizing" });
      now = 90000;
      expect(controller.getRunTiming()?.elapsedMs).toBe(62134);
      expect(stored).toEqual({ runId: "run-1", outcome, elapsedMs: 62134 });
      commit.resolve();
      expect(await run).toBe(outcome);
      expect(controller.getSnapshot().lastRun?.elapsedMs).toBe(62134);
      expect(controller.getRunTiming()).toBeNull();
    },
  );
});

it("counts preparation, attempts, tools, approval and cancellation cleanup before a failed commit", async () => {
  let now = 50;
  const controller = new SessionController({
    now: () => now,
    hooks: {
      persistRunStart: async () => {
        now += 100;
      },
      persistRunFinished: async (info) => {
        expect(info.elapsedMs).toBe(1000);
        now += 10000;
        throw new Error("disk full");
      },
    },
    driver: {
      execute: async (handle) => {
        now += 100;
        handle.beginAttempt(1, 1);
        handle.finishAttempt("failed");
        now += 100;
        handle.beginAttempt(1, 2);
        handle.finishAttempt("completed");
        now += 100;
        handle.reportPhase("executing_tool");
        const approval = handle.requestApproval({ toolCallId: "c", toolName: "write" });
        now += 100;
        controller.resolveApproval(controller.getSnapshot().pendingApproval!.id, "once");
        await approval;
        now += 100;
        handle.beginAttempt(2, 1);
        handle.finishAttempt("completed");
        controller.cancel();
        now += 400;
        return { outcome: "completed" };
      },
    },
  });
  expect(await controller.submitPrompt("hi")).toBe("failed");
  expect(controller.getSnapshot().lastRun).toMatchObject({ persisted: false, elapsedMs: 1000 });
});

describe("bash 实时输出流", () => {
  it("streamToolOutput 按序发 tool.output.delta 且不改变快照", async () => {
    const gate = deferred<LoopEnd>();
    let handleRef: RunHandle | null = null;
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handleRef = handle;
        handle.notifyToolStarted("t1", "bash");
        return gate.promise;
      },
    };
    const { controller, events, snapshots } = makeController(driver);
    const run = controller.submitPrompt("task");
    await nextTick();
    const handle = handleRef!;
    const before = snapshots();
    handle.streamToolOutput("t1", "a");
    handle.streamToolOutput("t1", "ab");
    expect(events.filter((e) => e.type === "tool.output.delta")).toEqual([
      { type: "tool.output.delta", runId: "run-1", toolCallId: "t1", delta: "a" },
      { type: "tool.output.delta", runId: "run-1", toolCallId: "t1", delta: "ab" },
    ]);
    expect(snapshots()).toEqual(before);
    gate.resolve({ outcome: "completed" });
    await run;
    handle.streamToolOutput("t1", "late");
    expect(events.filter((e) => e.type === "tool.output.delta")).toHaveLength(2);
  });

  it("取消后不再发 tool.output.delta", async () => {
    const gate = deferred<LoopEnd>();
    let handleRef: RunHandle | null = null;
    const driver: AgentLoopDriver = {
      execute: async (handle) => {
        handleRef = handle;
        handle.notifyToolStarted("t1", "bash");
        await gate.promise;
        return { outcome: "cancelled" };
      },
    };
    const { controller, events } = makeController(driver);
    const run = controller.submitPrompt("task");
    await nextTick();
    const handle = handleRef!;
    handle.streamToolOutput("t1", "before");
    controller.cancel();
    handle.streamToolOutput("t1", "after");
    gate.resolve({ outcome: "cancelled" });
    await run;
    expect(events.filter((e) => e.type === "tool.output.delta")).toEqual([
      { type: "tool.output.delta", runId: "run-1", toolCallId: "t1", delta: "before" },
    ]);
  });
});
