import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bootstrap, type BootstrapResult } from "../src/bootstrap.js";
import { createAgentRuntime, type AgentRuntime, type RuntimeWarning } from "../src/application.js";
import type { StreamTurnOptions, TurnResult } from "../src/llm/model-service.js";
import { makeAssistantMessage } from "./sessions/helpers.js";

// 捕获 ModelService 构造参数并返回受控 fake stream：不触网。
// vi.mock 被提升，共享状态必须经 vi.hoisted 初始化。
const modelServiceMock = vi.hoisted(() => ({
  ctorCalls: [] as Array<{ models: unknown; secrets: readonly string[] }>,
  streamTurn: undefined as undefined | ((options: StreamTurnOptions) => Promise<TurnResult>),
}));
vi.mock("../src/llm/model-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/model-service.js")>();
  class FakeModelService {
    constructor(models: unknown, secrets: readonly string[]) {
      modelServiceMock.ctorCalls.push({ models, secrets });
    }
    streamTurn(options: StreamTurnOptions): Promise<TurnResult> {
      if (!modelServiceMock.streamTurn) throw new Error("streamTurn impl not set");
      return modelServiceMock.streamTurn(options);
    }
  }
  return { ...actual, ModelService: FakeModelService };
});

const roots: string[] = [];
const runtimes: AgentRuntime[] = [];

function makeHome(settingsRaw?: Record<string, unknown>): BootstrapResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shana-application-"));
  roots.push(root);
  if (settingsRaw) {
    fs.mkdirSync(path.join(root, ".shana"), { recursive: true });
    fs.writeFileSync(path.join(root, ".shana", "settings.json"), JSON.stringify(settingsRaw));
  }
  return bootstrap({ homeDir: root, cwd: root });
}

async function makeRuntime(result: BootstrapResult): Promise<AgentRuntime> {
  const runtime = await createAgentRuntime(result);
  runtimes.push(runtime);
  return runtime;
}

function doneTurn(): TurnResult {
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

// Task 0 旧路径基线（逐字捕获自重构前的 createApplication）：
// 该 settings 组合触发 collectSettingsWarnings 的唯一告警。
const SETTINGS_WARNING =
  'settings.json: "compactionRetainedContextRatio" (0.9) >= "compactionThresholdRatio" (0.8)，尾部保留 cap 松于压缩阈值、几乎不生效';
const ratioSettings = { compactionRetainedContextRatio: 0.9, compactionThresholdRatio: 0.8 };

function writeModelConfig(result: BootstrapResult, raw: unknown): void {
  fs.writeFileSync(path.join(result.shanaDir, "model.json"), JSON.stringify(raw));
}

function providerEntry(apiKey: string, modelId: string): Record<string, unknown> {
  return {
    api: "openai-completions",
    baseUrl: "https://fake.test",
    apiKey,
    models: [{ id: modelId, contextWindow: 10000, maxTokens: 1000 }],
  };
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.controller.exit();
  modelServiceMock.ctorCalls.length = 0;
  modelServiceMock.streamTurn = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("starts without model.json: no Session, no ModelService construction", async () => {
  const result = makeHome();
  const runtime = await makeRuntime(result);
  expect(runtime.controller.getSnapshot().session.ref).toBeNull();
  expect(fs.readdirSync(result.sessionsDir)).toEqual([]);
  expect(modelServiceMock.ctorCalls).toEqual([]);
});

it("does not create a Session until the first prompt even with a configured model", async () => {
  const result = makeHome();
  writeModelConfig(result, {
    current: { provider: "p", model: "A" },
    providers: { p: providerEntry("sk-app-test-key-one-000000", "A") },
  });
  const runtime = await makeRuntime(result);
  expect(fs.readdirSync(result.sessionsDir)).toEqual([]);
  modelServiceMock.streamTurn = async () => doneTurn();
  await expect(runtime.controller.submitPrompt("first")).resolves.toBe("completed");
  expect(runtime.controller.getSnapshot().session.ref).not.toBeNull();
  expect(fs.readdirSync(result.sessionsDir)).toHaveLength(1);
});

it("buffers settings warnings as structured objects; startupWarnings is a frozen shallow copy", async () => {
  const runtime = await makeRuntime(makeHome(ratioSettings));
  const expected: RuntimeWarning[] = [{ kind: "settings_warning", message: SETTINGS_WARNING }];
  expect(runtime.startupWarnings).toEqual(expected);
  // 快照是浅拷贝：外部修改不影响内部缓冲区。
  const snapshot = runtime.startupWarnings as RuntimeWarning[];
  snapshot.push({ kind: "settings_warning", message: "injected" });
  expect(runtime.startupWarnings).toEqual(expected);
  expect(runtime.startupWarnings).not.toBe(snapshot);
});

it("setWarningHandler only switches (no auto replay) and takes over exactly once", async () => {
  const runtime = await makeRuntime(makeHome(ratioSettings));
  const handler = vi.fn();
  runtime.setWarningHandler(handler);
  expect(handler).not.toHaveBeenCalled();
  expect(() => runtime.setWarningHandler(vi.fn())).toThrow("Warning handler already set");
  // 回放是调用方责任：恰好一次。
  for (const warning of runtime.startupWarnings) handler(warning);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith({ kind: "settings_warning", message: SETTINGS_WARNING });
});

it("routes post-takeover warnings to the handler and never grows the buffer", async () => {
  const result = makeHome();
  writeModelConfig(result, {
    current: { provider: "p", model: "A" },
    providers: { p: providerEntry("sk-app-test-key-one-000000", "A") },
  });
  const runtime = await makeRuntime(result);
  const received: RuntimeWarning[] = [];
  runtime.setWarningHandler((warning) => received.push(warning));
  expect(runtime.startupWarnings).toEqual([]);

  // 制造尾部半行截断的 Session，经 listSessions 触发 tail_truncated。
  modelServiceMock.streamTurn = async () => doneTurn();
  await runtime.controller.submitPrompt("first");
  const ref = runtime.controller.getSnapshot().session.ref;
  if (!ref) throw new Error("session ref missing");
  const messagesPath = path.join(result.sessionsDir, ref.workspaceId, ref.sessionId, "messages.jsonl");
  fs.appendFileSync(messagesPath, '{"type":');
  await runtime.controller.listSessions();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ kind: "tail_truncated" });
  // 接管后缓冲区冻结：快照不随运行增长。
  expect(runtime.startupWarnings).toEqual([]);
});

it("accumulates secrets across streamTurn calls and redacts newly added keys", async () => {
  const key1 = "sk-app-test-key-one-000000";
  const key2 = "sk-app-test-key-two-111111";
  const result = makeHome();
  writeModelConfig(result, {
    current: { provider: "p", model: "A" },
    providers: { p: providerEntry(key1, "A") },
  });
  const runtime = await makeRuntime(result);
  modelServiceMock.streamTurn = async () => doneTurn();

  await expect(runtime.controller.submitPrompt("first")).resolves.toBe("completed");
  expect(modelServiceMock.ctorCalls).toHaveLength(1);
  expect(modelServiceMock.ctorCalls[0]?.secrets).toEqual([key1]);
  // 启动快照里的 Key 已被掩码。
  expect(runtime.redact(`leak ${key1} here`)).toBe("leak [REDACTED] here");

  // 会话中途改写 model.json 增加新 Provider/Key，再 switchModel 触发 Core 重载：
  // 新 Key 不在 bootstrap 静态快照里，只能经 streamTurn 包装进入活集合。
  writeModelConfig(result, {
    current: { provider: "p", model: "A" },
    providers: { p: providerEntry(key1, "A"), q: providerEntry(key2, "B") },
  });
  await runtime.controller.switchModel("q", "B");
  await expect(runtime.controller.submitPrompt("second")).resolves.toBe("completed");

  expect(modelServiceMock.ctorCalls).toHaveLength(2);
  // 每次调用新建 ModelService；第二次的 secrets 含第一次的 Key 与新 Key。
  expect(modelServiceMock.ctorCalls[1]?.secrets).toEqual([key1, key2]);
  expect(runtime.redact(`a ${key1} b ${key2} c`)).toBe("a [REDACTED] b [REDACTED] c");
});