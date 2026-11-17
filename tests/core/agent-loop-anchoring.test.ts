import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession } from "../../src/core/agent-loop.js";
import { estimateContextTokens, wrapConversationSummary } from "../../src/core/context-builder.js";
import type { BusEvent } from "../../src/core/events.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { createModelSnapshot, type StreamTurnOptions, type TurnResult } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import type { SessionRef, SessionStore } from "../../src/sessions/session-store.js";
import type { StoredAssistantMessage } from "../../src/sessions/records.js";
import {
  makeAssistantMessage,
  makeStore,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
  cleanupTempDirs,
} from "../sessions/helpers.js";

// 阈值 10000（20000 × 0.5）；种子上下文的字符估算远低于阈值，实测 usage 高于阈值，
// 只有锚定生效才会触发压缩——以此区分锚定与纯估算两条路径。
const SETTINGS = {
  compactionThresholdRatio: 0.5,
  compactionRetainedContextRatio: 1,
  compactionRetainedContextMaxTokens: 10_000_000,
  maxTurns: 40,
};
const MEASURED_PROMPT = 12000;

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
  contextWindow: 20000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};

function turn(message: StoredAssistantMessage): TurnResult {
  return {
    attempts: 1,
    message,
    stopReason: message.stopReason,
    usage: message.usage,
    text: "",
    thinking: "",
    truncated: message.stopReason === "length",
    toolCalls: message.content.filter((block) => block.type === "toolCall"),
  };
}

function summaryTurn(text: string): TurnResult {
  return { ...turn(makeAssistantMessage([], text)), text };
}

// 身份与 runModel 一致、usage 可控的响应；默认实测 prompt 高于阈值。
function measuredMessage(
  options: {
    calls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
    text?: string;
    input?: number;
    provider?: string;
    model?: string;
  } = {},
): StoredAssistantMessage {
  const message = makeAssistantMessage(options.calls ?? [], options.text ?? "ok");
  message.provider = options.provider ?? model.providerId;
  message.model = options.model ?? model.id;
  const input = options.input ?? MEASURED_PROMPT;
  message.usage = { ...message.usage, input, output: 5, totalTokens: input + 5 };
  return message;
}

interface AnchoringOverrides {
  getModel?: () => ResolvedModel;
  settings?: Record<string, unknown>;
  seed?: (store: SessionStore, ref: SessionRef, workspaceRoot: string) => Promise<void>;
}

async function anchoringFixture(
  script: (call: number, options: StreamTurnOptions) => TurnResult | Promise<TurnResult>,
  overrides: AnchoringOverrides = {},
) {
  const { store } = makeStore();
  const ref = sessionRef("anchor-loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  const workspaceRoot = tempDir();
  fs.writeFileSync(path.join(workspaceRoot, "a.txt"), "seed");
  if (overrides.seed) await overrides.seed(store, ref, workspaceRoot);
  const requests: StreamTurnOptions[] = [];
  const events: BusEvent[] = [];
  let call = 0;
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    getModel: overrides.getModel ?? (() => model),
    getSettings: () => parseSettings({ ...SETTINGS, ...overrides.settings }),
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        call += 1;
        return script(call, options);
      },
    },
  });
  session.controller.eventBus.subscribe((event) => events.push(event));
  return { ...session, store, ref, requests, events, workspaceRoot };
}

// 种一个带 run_started（settings 快照）与实测 usage 的旧 Run；字符估算很小。
async function seedMeasuredRun(
  store: SessionStore,
  ref: SessionRef,
  workspaceRoot: string,
  options: { input?: number; provider?: string; model?: string; settings?: Record<string, unknown> } = {},
) {
  await store.appendRecord(ref, { type: "user_prompt", runId: "old", text: "old task" });
  const snapshot = createModelSnapshot(model);
  await store.appendRecord(ref, {
    type: "run_started",
    runId: "old",
    model: { ...snapshot, input: [...snapshot.input] },
    settings: parseSettings({ ...SETTINGS, ...options.settings }) as unknown as JsonObject,
    agentsMd: { path: path.join(workspaceRoot, "AGENTS.md"), present: false },
  });
  const assistant = await store.appendRecord(ref, {
    type: "assistant_message",
    runId: "old",
    message: measuredMessage({
      calls: [{ id: "s1", name: "read", arguments: { path: "a.txt" } }],
      text: "x".repeat(400),
      input: options.input,
      provider: options.provider,
      model: options.model,
    }),
  });
  const result = await store.appendRecord(ref, {
    type: "tool_result",
    runId: "old",
    assistantRecordSeq: assistant.recordSeq,
    toolCallId: "s1",
    toolName: "read",
    status: "success",
    content: "x".repeat(400),
  });
  return { assistant, result };
}

// 种一个无 run_started 的 Turn（字符估算路径），供 (B) 压缩有可覆盖内容。
// 体量 ~2500 估算 token：低于 Run 起点阈值，但超出收紧后的尾部保留 cap，walk-back 必覆盖它。
async function seedSmallTurn(store: SessionStore, ref: SessionRef) {
  await store.appendRecord(ref, { type: "user_prompt", runId: "old", text: "old task" });
  const assistant = await store.appendRecord(ref, {
    type: "assistant_message",
    runId: "old",
    message: makeAssistantMessage([{ id: "s1", name: "read", arguments: { path: "a.txt" } }], "x".repeat(5000)),
  });
  await store.appendRecord(ref, {
    type: "tool_result",
    runId: "old",
    assistantRecordSeq: assistant.recordSeq,
    toolCallId: "s1",
    toolName: "read",
    status: "success",
    content: "x".repeat(5000),
  });
}

// (B) 用例收紧尾部保留 cap，避免 walk-back 把全部 Turn 留尾导致 noop。
const RETAINED_CAP = { compactionRetainedContextMaxTokens: 1000 };

function startedCompactions(events: BusEvent[]) {
  return events.filter(
    (e): e is Extract<BusEvent, { type: "compaction.started" }> => e.type === "compaction.started",
  );
}

function phasesOf(events: BusEvent[]) {
  return events
    .filter((e): e is Extract<BusEvent, { type: "run.state_changed" }> => e.type === "run.state_changed")
    .map((e) => e.phase);
}

afterEach(cleanupTempDirs);

it("anchors at Run start (A): measured usage triggers compaction while the estimate stays below threshold", async () => {
  const f = await anchoringFixture(
    (call) => (call === 1 ? summaryTurn("SUMMARY") : turn(makeAssistantMessage([], "done"))),
    { seed: (store, ref, root) => seedMeasuredRun(store, ref, root) },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(2);
  expect(phasesOf(f.events)[0]).toBe("compacting");
  expect(startedCompactions(f.events)).toHaveLength(1);
  // 反证：同一上下文的纯估算低于阈值，触发只能来自锚定。
  const settings = parseSettings(SETTINGS);
  const original = f.requests[0]!.context;
  const estimate = estimateContextTokens(
    { ...original, messages: original.messages.slice(0, -1) },
    settings.tokenEstimate,
  );
  expect(estimate).toBeLessThan(20000 * SETTINGS.compactionThresholdRatio);
  expect(f.requests[1]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("anchors after each Turn (B): measured usage triggers compaction before the next request", async () => {
  const f = await anchoringFixture(
    (call) => {
      if (call === 1)
        return turn(
          measuredMessage({ calls: [{ id: "t1", name: "read", arguments: { path: "a.txt" } }], text: "small" }),
        );
      if (call === 2) return summaryTurn("SUMMARY");
      return turn(makeAssistantMessage([], "done"));
    },
    { seed: (store, ref) => seedSmallTurn(store, ref), settings: RETAINED_CAP },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  // (B) 而非 (A)：首个相位是 streaming，compacting 恰出现一次且在首个请求之后。
  expect(phasesOf(f.events)[0]).toBe("streaming");
  expect(phasesOf(f.events).filter((phase) => phase === "compacting")).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(1);
  const settings = parseSettings(SETTINGS);
  const compactionRequest = f.requests[1]!.context;
  const estimate = estimateContextTokens(
    { ...compactionRequest, messages: compactionRequest.messages.slice(0, -1) },
    settings.tokenEstimate,
  );
  expect(estimate).toBeLessThan(20000 * SETTINGS.compactionThresholdRatio);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "checkpoint")).toHaveLength(1);
});

it("falls back to estimation when the response identity does not match the run model", async () => {
  const f = await anchoringFixture(() => turn(makeAssistantMessage([], "done")), {
    seed: (store, ref, root) => seedMeasuredRun(store, ref, root, { provider: "other-provider" }),
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
});

it("falls back to estimation after a model switch (tokenizer changed)", async () => {
  const f = await anchoringFixture(() => turn(makeAssistantMessage([], "done")), {
    seed: (store, ref, root) => seedMeasuredRun(store, ref, root),
    getModel: () => ({ ...model, id: "switched" }),
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
});

it("treats all-zero usage as uncounted and falls back to estimation", async () => {
  const f = await anchoringFixture(() => turn(makeAssistantMessage([], "done")), {
    seed: (store, ref, root) => seedMeasuredRun(store, ref, root, { input: 0 }),
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
});

it("falls back when a checkpoint rewrote history after the measured request", async () => {
  const f = await anchoringFixture(() => turn(makeAssistantMessage([], "done")), {
    seed: async (store, ref, root) => {
      const { result } = await seedMeasuredRun(store, ref, root);
      await store.appendRecord(ref, {
        type: "checkpoint",
        summary: "OLD",
        coveredUpTo: result.recordSeq,
        model: { providerId: "p", modelId: "m" },
        promptVersion: "test",
      });
    },
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
  expect(f.requests[0]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("OLD"),
  });
});

it("falls back when the tool schema changed since the measured request", async () => {
  const f = await anchoringFixture(() => turn(makeAssistantMessage([], "done")), {
    // editMaxFileBytes 嵌入工具 description：快照与当前 Schema 必然不同。
    seed: (store, ref, root) => seedMeasuredRun(store, ref, root, { settings: { editMaxFileBytes: 12345 } }),
  });
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(1);
  expect(startedCompactions(f.events)).toHaveLength(0);
});

it("re-anchors across Runs from persisted usage and settings snapshots", async () => {
  const f = await anchoringFixture((call) => {
    if (call === 1) return turn(measuredMessage({ text: "first answer" }));
    if (call === 2) return summaryTurn("SUMMARY");
    return turn(makeAssistantMessage([], "done"));
  });
  expect(await f.controller.submitPrompt("first")).toBe("completed");
  expect(startedCompactions(f.events)).toHaveLength(0);
  expect(await f.controller.submitPrompt("second")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(startedCompactions(f.events)).toHaveLength(1);
  expect(f.requests[2]!.context.messages[0]).toMatchObject({
    role: "user",
    content: wrapConversationSummary("SUMMARY"),
  });
  expect(f.requests[2]!.context.messages[1]).toMatchObject({ role: "user", content: "second" });
});

it("keeps the post-compaction rebuild on estimation until the next response re-anchors", async () => {
  const rebuilt: number[] = [];
  const f = await anchoringFixture(
    (call, options) => {
      if (call === 1)
        return turn(
          measuredMessage({ calls: [{ id: "t1", name: "read", arguments: { path: "a.txt" } }], text: "small" }),
        );
      if (call === 2) return summaryTurn("SUMMARY");
      // 压缩后的正式请求：上下文 = 摘要 + 保留尾部，其实测 usage 很小；
      // 若错误地沿用旧锚定或把摘要请求的 usage 当测量，这里会再次触发压缩。
      rebuilt.push(
        estimateContextTokens(options.context, parseSettings(SETTINGS).tokenEstimate),
      );
      return turn(measuredMessage({ text: "done", input: 50 }));
    },
    { seed: (store, ref) => seedSmallTurn(store, ref), settings: RETAINED_CAP },
  );
  expect(await f.controller.submitPrompt("test")).toBe("completed");
  expect(f.requests).toHaveLength(3);
  expect(startedCompactions(f.events)).toHaveLength(1);
  expect(rebuilt).toHaveLength(1);
  expect(rebuilt[0]).toBeLessThan(20000 * SETTINGS.compactionThresholdRatio);
  expect((await f.store.loadSession(f.ref)).records.filter((r) => r.type === "run_finished")).toHaveLength(1);
});
