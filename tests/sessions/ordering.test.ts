import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { BusEvent, RunFinishedEvent } from "../../src/core/events.js";
import { SessionController, type AgentLoopDriver } from "../../src/core/session-controller.js";
import { SessionWriteError } from "../../src/sessions/session-store.js";
import {
  cleanupTempDirs,
  makeAssistantMessage,
  makeStore,
  messagesPathOf,
  sessionRef,
  WORKSPACE_ID,
} from "./helpers.js";

afterEach(cleanupTempDirs);

describe("V3 意图先于执行", () => {
  it("assistant_message fsync 成功前不启动工具；意图写入失败则工具不执行", async () => {
    const trace: string[] = [];
    let failIntent = false;
    const { store } = makeStore({
      hooks: {
        beforeAppend: ({ type }) => {
          if (failIntent && type === "assistant_message") {
            throw new Error("injected intent failure");
          }
        },
        afterSync: ({ type }) => {
          trace.push(`sync:${type}`);
        },
      },
    });
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });

    async function fakeTurn(): Promise<void> {
      await store.appendRecord(ref, {
        type: "assistant_message",
        runId: "run-1",
        message: makeAssistantMessage([{ id: "c1", name: "read" }]),
      });
      trace.push("tools-start");
      trace.push("exec:c1");
      const output = "file body";
      await store.appendRecord(ref, {
        type: "tool_result",
        assistantRecordSeq: 1,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "read",
        status: "success",
        content: output,
      });
      trace.push("turn-complete");
    }

    await fakeTurn();
    expect(trace).toEqual([
      "sync:assistant_message",
      "tools-start",
      "exec:c1",
      "sync:tool_result",
      "turn-complete",
    ]);

    trace.length = 0;
    failIntent = true;
    await expect(fakeTurn()).rejects.toBeInstanceOf(SessionWriteError);
    expect(trace).toEqual([]);
    expect((await store.loadSession(ref)).records).toHaveLength(2);
  });
});

describe("V4 结果先于完成事件", () => {
  it("tool_result 提交成功后才发布完成事件；提交失败走失败路径且不重跑工具", async () => {
    const trace: string[] = [];
    let failResult = false;
    const { store } = makeStore({
      hooks: {
        beforeAppend: ({ type }) => {
          if (failResult && type === "tool_result") {
            throw new Error("injected result failure");
          }
        },
        afterSync: ({ type }) => {
          trace.push(`sync:${type}`);
        },
      },
    });
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });
    let executions = 0;

    async function fakeTurn(onCompleted: () => void): Promise<void> {
      await store.appendRecord(ref, {
        type: "assistant_message",
        runId: "run-1",
        message: makeAssistantMessage([{ id: "c1", name: "read" }]),
      });
      executions += 1;
      await store.appendRecord(ref, {
        type: "tool_result",
        assistantRecordSeq: 1,
        runId: "run-1",
        toolCallId: "c1",
        toolName: "read",
        status: "error",
        content: "Error: boom",
      });
      onCompleted();
    }

    await fakeTurn(() => trace.push("completed-event"));
    expect(trace).toEqual(["sync:assistant_message", "sync:tool_result", "completed-event"]);

    trace.length = 0;
    failResult = true;
    await expect(fakeTurn(() => trace.push("completed-event"))).rejects.toBeInstanceOf(SessionWriteError);
    // 意图已提交，但结果提交失败时不得发布完成事件
    expect(trace).toEqual(["sync:assistant_message"]);
    // 失败的那一轮工具只执行一次，没有自动重跑
    expect(executions).toBe(2);
    expect((await store.loadSession(ref)).records).toHaveLength(3);
  });
});

describe("V5 写入 + fsync 临界区", () => {
  it("临界区期间取消不打断写入，提交完成后取消才生效", async () => {
    let cancelRequestedDuringWrite = false;
    let cancelRun: (() => void) | null = null;
    const { store } = makeStore({
      hooks: {
        afterWrite: ({ type }) => {
          if (type !== "assistant_message") return;
          cancelRequestedDuringWrite = true;
          cancelRun?.();
        },
      },
    });
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });

    const driver: AgentLoopDriver = {
      execute: async () => {
        await store.appendRecord(ref, {
          type: "assistant_message",
          runId: "run-1",
          message: makeAssistantMessage(),
        });
        return { outcome: "completed" };
      },
    };
    const controller = new SessionController({ driver });
    const events: BusEvent[] = [];
    controller.eventBus.subscribe((event) => events.push(event));
    cancelRun = () => controller.cancel();

    await expect(controller.submitPrompt("hi")).resolves.toBe("cancelled");
    expect(cancelRequestedDuringWrite).toBe(true);

    const raw = fs.readFileSync(messagesPathOf(store.sessionsDir, ref), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const loaded = await store.loadSession(ref);
    expect(loaded.records.map((record) => record.type)).toEqual(["assistant_message"]);
    expect(loaded.warnings).toEqual([]);

    const finished = events.filter((event): event is RunFinishedEvent => event.type === "run.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.outcome).toBe("cancelled");
    expect(controller.getSnapshot().status).toEqual({ kind: "idle" });
  });
});

describe("V6 终止记录落盘失败", () => {
  it("run_finished 写入失败时内存仍终结并发布 persisted=false，不卡死", async () => {
    const { store } = makeStore({
      hooks: {
        beforeAppend: ({ type }) => {
          if (type === "run_finished") throw new Error("disk full");
        },
      },
    });
    const ref = sessionRef("s1");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: "s1" });

    const driver: AgentLoopDriver = {
      execute: async () => ({ outcome: "completed" }),
    };
    const controller = new SessionController({
      driver,
      hooks: {
        persistRunFinished: async ({ runId, outcome }) => {
          await store.appendRecord(ref, {
            type: "run_finished",
            runId,
            outcome,
            persisted: true,
          });
        },
      },
    });
    const events: BusEvent[] = [];
    controller.eventBus.subscribe((event) => events.push(event));

    await expect(controller.submitPrompt("hi")).resolves.toBe("failed");
    const finished = events.filter((event): event is RunFinishedEvent => event.type === "run.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.outcome).toBe("failed");
    expect(finished[0]?.persisted).toBe(false);
    expect(finished[0]?.error).toContain("disk full");
    expect(controller.getSnapshot()).toMatchObject({
      status: { kind: "idle" },
      lastRun: { outcome: "failed", persisted: false },
    });
    expect((await store.loadSession(ref)).records).toEqual([]);
  });
});
