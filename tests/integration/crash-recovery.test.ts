import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/agent-loop.js";
import { planEffectiveContext } from "../../src/core/context-builder.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import type { TurnResult } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { resumeSession } from "../../src/sessions/recovery.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { WORKSPACE_ID, cleanupTempDirs, makeAssistantMessage, tempDir } from "../sessions/helpers.js";

const workerPath = fileURLToPath(new URL("./fixtures/crash-worker.ts", import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  cleanupTempDirs();
});

const model: ResolvedModel = {
  providerId: "p",
  providerName: "Test",
  id: "m",
  name: "Test",
  api: "openai-completions",
  baseUrl: "https://fake.test",
  apiKey: "synthetic-key",
  reasoning: false,
  thinking: false,
  reasoningEffort: "high",
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};

function finalTurn(): TurnResult {
  const message = makeAssistantMessage([], "done");
  return {
    attempts: 1,
    message,
    stopReason: message.stopReason,
    usage: message.usage,
    text: "",
    thinking: "",
    truncated: false,
    toolCalls: [],
  };
}

function crashAt(point: string, sessionsDir: string, workspaceRoot: string, sessionId: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = fork(workerPath, [sessionsDir, WORKSPACE_ID, sessionId, workspaceRoot, point], {
      execArgv: ["--import", "tsx"],
      silent: true,
      windowsHide: true,
    });
    children.push(child);
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

interface Scenario {
  types: string[];
  effectExists: boolean;
  unknown: number;
  eligibleTurns: number;
  excludedTurns: number;
  contextIncludesCrashedTurn: boolean;
}

// 三个崩溃点对应 §6.3 持久化顺序的不同截断位置，重载后的审计/门控/上下文过滤各不相同。
const scenarios: Record<string, Scenario> = {
  "after-intent": {
    types: ["user_prompt", "run_started", "assistant_message"],
    effectExists: false,
    unknown: 1,
    eligibleTurns: 0,
    excludedTurns: 1,
    contextIncludesCrashedTurn: false,
  },
  "after-execute": {
    types: ["user_prompt", "run_started", "assistant_message"],
    effectExists: true,
    unknown: 1,
    eligibleTurns: 0,
    excludedTurns: 1,
    contextIncludesCrashedTurn: false,
  },
  "after-result": {
    types: ["user_prompt", "run_started", "assistant_message", "tool_result"],
    effectExists: true,
    unknown: 0,
    eligibleTurns: 1,
    excludedTurns: 0,
    contextIncludesCrashedTurn: true,
  },
};

for (const [point, expected] of Object.entries(scenarios)) {
  it(`V2 崩溃点 ${point}：残锁人工处理后重载，审计完整、不自动重放、上下文过滤正确`, { timeout: 20000 }, async () => {
    const sessionsDir = tempDir();
    const workspaceRoot = tempDir();
    const sessionId = `crash-${point}`;
    const ref = { workspaceId: WORKSPACE_ID, sessionId };
    const effectPath = path.join(workspaceRoot, "effect.txt");
    const messagesPath = path.join(sessionsDir, WORKSPACE_ID, sessionId, "messages.jsonl");
    const lockPath = path.join(sessionsDir, WORKSPACE_ID, sessionId, `${sessionId}.session.lock`);

    // 真实子进程在崩溃点 abrupt 退出（process.exit(0)），内存态丢失，只剩已 fsync 的磁盘态。
    expect(await crashAt(point, sessionsDir, workspaceRoot, sessionId)).toBe(0);
    expect(fs.existsSync(messagesPath)).toBe(true);
    expect(fs.existsSync(effectPath)).toBe(expected.effectExists);

    // 崩溃进程留下残锁：父进程不得自动接管（§6.1）。
    expect(fs.existsSync(lockPath)).toBe(true);
    const store = new SessionStore({ sessionsDir });
    await expect(resumeSession(store, ref)).rejects.toMatchObject({ code: "occupied" });

    // 人工核对处理残锁后重载。
    fs.unlinkSync(lockPath);
    const resumed = await resumeSession(store, ref);

    // 审计完整：记录前缀类型与序号连续，无损坏。
    expect(resumed.records.map((r) => r.type)).toEqual(expected.types);
    expect(resumed.records.map((r) => r.recordSeq)).toEqual(expected.types.map((_, i) => i + 1));

    // 缺结果崩溃点报未知副作用，结果已提交的崩溃点不报。
    expect(resumed.unknownSideEffects).toHaveLength(expected.unknown);

    // 上下文过滤：不完整 Turn 被排除，完整 Turn 保留。
    const plan = planEffectiveContext(resumed.records);
    expect(plan.runs.flatMap((r) => r.turns)).toHaveLength(expected.eligibleTurns);
    expect(plan.runs.flatMap((r) => r.excludedTurns)).toHaveLength(expected.excludedTurns);

    // 不自动重放：重载续跑不重新执行崩溃 Turn 的工具，效果文件不被改写。
    let calls = 0;
    const reloaded = await createAgentSession({
      store,
      ref,
      workspaceId: WORKSPACE_ID,
      workspaceRoot,
      getModel: () => model,
      getSettings: () => parseSettings({}),
      systemPrompt: "You are a test agent.",
      modelService: {
        streamTurn: async (options) => {
          calls++;
          const context = JSON.stringify(options.context.messages);
          if (expected.contextIncludesCrashedTurn) expect(context).toContain("call-1");
          else expect(context).not.toContain("call-1");
          return finalTurn();
        },
      },
    });
    if (expected.unknown > 0) {
      expect(() => reloaded.controller.submitPrompt("continue")).toThrow();
      reloaded.acknowledgeUnknownSideEffects();
    }
    expect(await reloaded.controller.submitPrompt("continue")).toBe("completed");
    expect(calls).toBe(1);
    if (expected.effectExists) expect(fs.readFileSync(effectPath, "utf8")).toBe("written-once");
    else expect(fs.existsSync(effectPath)).toBe(false);
  });
}
