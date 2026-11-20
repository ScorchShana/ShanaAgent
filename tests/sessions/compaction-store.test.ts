import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  IMAGE_COMPACTION_OMITTED_TEXT,
  IMAGE_OMITTED_TEXT,
  buildContext,
  estimateContextTokens,
  estimateTokens,
  planCompaction,
  toolResultMessage,
  wrapConversationSummary,
} from "../../src/core/context-builder.js";
import type { StoredContext } from "../../src/llm/history-replay.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { TurnError, type StreamTurnOptions, type TurnResult } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import {
  CompactionError,
  compactHistory,
  type CompactHistoryOptions,
} from "../../src/sessions/compaction-store.js";
import type {
  NewSessionRecord,
  SessionRecord,
  StoredToolCall,
  ToolResultRecord,
} from "../../src/sessions/records.js";
import { findLatestCheckpoint } from "../../src/sessions/recovery.js";
import {
  WORKSPACE_ID,
  cleanupTempDirs,
  makeAssistantMessage,
  makeAssistantRecord,
  makeCheckpointRecord,
  makePngImage,
  makeStore,
  makeToolResultRecord,
  makeUserPromptRecord,
  sessionRef,
  tempDir,
} from "./helpers.js";

afterEach(cleanupTempDirs);

const RECORD_TS = "2026-10-27T10:00:00.000Z";
const PROMPT = "Summarize the conversation in {{TARGET_TOKENS}} tokens.";

function makeModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "p",
    providerName: "Test",
    id: "m",
    name: "Test",
    api: "openai-completions",
    baseUrl: "https://fake.test",
    reasoning: false,
    thinking: false,
    reasoningEffort: "high",
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUnknown: true,
    ...overrides,
  };
}

function makeRecords(): SessionRecord[] {
  return [
    makeUserPromptRecord(1, "run-1", "first goal"),
    makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
    makeToolResultRecord(3, "run-1", "c1", "success"),
    makeAssistantRecord(4, "run-1", [{ id: "c2", name: "read" }]),
    makeToolResultRecord(5, "run-1", "c2", "success"),
  ];
}

function makeContext(records: readonly SessionRecord[]): StoredContext {
  const messages: StoredContext["messages"] = [];
  for (const record of records) {
    if (record.type === "user_prompt") {
      messages.push({ role: "user", content: record.text, timestamp: 1 });
    } else if (record.type === "assistant_message") {
      messages.push(record.message);
    } else if (record.type === "tool_result") {
      messages.push({
        role: "toolResult",
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        content: [{ type: "text", text: record.content }],
        isError: record.status !== "success",
        timestamp: 1,
      });
    } else if (record.type === "checkpoint") {
      messages.unshift({
        role: "user",
        content: wrapConversationSummary(record.summary),
        timestamp: 1,
      });
    }
  }
  return {
    systemPrompt: "system prompt",
    messages,
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  };
}

function summaryTurn(
  text: string,
  options: {
    stopReason?: StopReason;
    toolCalls?: Array<{ id: string; name: string }>;
    durationMs?: number;
    usage?: Partial<Usage>;
  } = {},
): TurnResult {
  const message = makeAssistantMessage(options.toolCalls ?? [], text, { stopReason: options.stopReason });
  if (options.durationMs !== undefined) message.durationMs = options.durationMs;
  if (options.usage !== undefined) message.usage = { ...message.usage, ...options.usage };
  return {
    attempts: 1,
    message,
    stopReason: message.stopReason,
    usage: message.usage,
    text,
    thinking: "",
    toolCalls: message.content.filter((block): block is StoredToolCall => block.type === "toolCall"),
    truncated: message.stopReason === "length",
  };
}

function harness(
  overrides: Partial<CompactHistoryOptions> = {},
  respond?: (options: StreamTurnOptions) => Promise<TurnResult>,
) {
  const records = makeRecords();
  const requests: StreamTurnOptions[] = [];
  const appended: NewSessionRecord[] = [];
  const options: CompactHistoryOptions = {
    records,
    context: makeContext(records),
    model: makeModel(),
    settings: parseSettings({}),
    signal: new AbortController().signal,
    retainedContextBudget: 1000,
    trigger: "start",
    modelService: {
      streamTurn: async (request) => {
        requests.push(request);
        return respond ? respond(request) : summaryTurn("summary text");
      },
    },
    appendRecord: async (input) => {
      appended.push(input);
      return { ...input, recordSeq: 100, ts: RECORD_TS } as SessionRecord;
    },
    loadPrompt: async () => PROMPT,
    now: () => new Date(RECORD_TS),
    ...overrides,
  };
  return { options, requests, appended, records };
}

describe("主路径请求形态", () => {
  it("System Prompt 与工具 Schema 逐字节保留，指令为末尾新增 user 消息", async () => {
    const h = harness();
    const outcome = await compactHistory(h.options);
    expect(outcome).toEqual({ status: "completed", coveredUpTo: 5, path: "primary" });
    expect(h.requests).toHaveLength(1);
    const request = h.requests[0]!;
    expect(request.context.systemPrompt).toBe(h.options.context.systemPrompt);
    expect(request.context.tools).toBe(h.options.context.tools);
    expect(request.context.messages.slice(0, -1)).toEqual(h.options.context.messages);
    const last = request.context.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toBe("Summarize the conversation in 4096 tokens.");
  });

  it("指令不落盘：只追加 Checkpoint，字段齐全且 promptVersion 对应提示词", async () => {
    const h = harness();
    await compactHistory(h.options);
    expect(h.records).toHaveLength(5);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toEqual({
      type: "checkpoint",
      summary: "summary text",
      coveredUpTo: 5,
      model: { providerId: "p", modelId: "m" },
      promptVersion: createHash("sha256").update(PROMPT).digest("hex").slice(0, 16),
      // 摘要请求的实测用量；Provider 未报告耗时则不写 durationMs。
      usage: { input: 1, cacheRead: 0, output: 1 },
    });
  });

  it("摘要请求的实测用量（含耗时）随 checkpoint 落盘", async () => {
    const h = harness(
      {},
      async () =>
        summaryTurn("summary text", {
          durationMs: 1500.5,
          usage: { input: 1200, cacheRead: 800, output: 300 },
        }),
    );
    await compactHistory(h.options);
    expect(h.appended[0]).toMatchObject({
      type: "checkpoint",
      usage: { input: 1200, cacheRead: 800, output: 300, durationMs: 1500.5 },
    });
  });

  it("focus 追加在指令末尾，promptVersion 仍只对应模板且不入库", async () => {
    const h = harness({ focus: "关注认证流程" });
    await compactHistory(h.options);
    const last = h.requests[0]!.context.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toBe("Summarize the conversation in 4096 tokens.\n\nAdditional focus:\n关注认证流程");
    expect(h.appended[0]).toEqual({
      type: "checkpoint",
      summary: "summary text",
      coveredUpTo: 5,
      model: { providerId: "p", modelId: "m" },
      promptVersion: createHash("sha256").update(PROMPT).digest("hex").slice(0, 16),
      // 摘要请求的实测用量；Provider 未报告耗时则不写 durationMs。
      usage: { input: 1, cacheRead: 0, output: 1 },
    });
  });

  it("空白 focus 等同无 focus", async () => {
    const h = harness({ focus: "  \n " });
    await compactHistory(h.options);
    expect(h.requests[0]!.context.messages.at(-1)!.content).toBe(
      "Summarize the conversation in 4096 tokens.",
    );
  });

  it("已有 Checkpoint 时旧摘要作为头部 user 消息原样保留，不重复注入", async () => {
    const records = [...makeRecords(), makeCheckpointRecord(6, "old summary", 3)];
    const fresh = await buildContext({ records, workspacePath: tempDir() });
    const h = harness({ records, context: { ...makeContext(records), messages: fresh.context.messages } });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", coveredUpTo: 5 });
    const request = h.requests[0]!;
    expect(request.context.systemPrompt).toBe(h.options.context.systemPrompt);
    expect(request.context.messages[0]).toEqual(h.options.context.messages[0]);
    expect(request.context.messages[0]).toMatchObject({
      role: "user",
      content: wrapConversationSummary("old summary"),
    });
    const summaryMessages = request.context.messages.filter(
      (message) => typeof message.content === "string" && message.content.includes("<conversation_summary>"),
    );
    expect(summaryMessages).toHaveLength(1);
  });

  it("重试次数用 compactionMaxRetries，no-force 不传 maxTokens，指令填充正文目标", async () => {
    const h = harness({
      settings: parseSettings({ compactionMaxRetries: 5, compactionSummaryTargetTokens: 1234 }),
    });
    await compactHistory(h.options);
    const request = h.requests[0]!;
    expect(request.maxRetries).toBe(5);
    expect(request.maxTokens).toBeUndefined();
    expect(request.model).toBe(h.options.model);
    const last = request.context.messages.at(-1)!;
    expect(last.content).toBe("Summarize the conversation in 1234 tokens.");
  });
});

describe("摘要校验", () => {
  it.each(["", "  \n "])("空摘要 %j 判失败且不写 Checkpoint", async (text) => {
    const h = harness({}, async () => summaryTurn(text));
    await expect(compactHistory(h.options)).rejects.toThrow(CompactionError);
    expect(h.appended).toHaveLength(0);
  });

  it("stopReason=length 判失败", async () => {
    const h = harness({}, async () => summaryTurn("partial", { stopReason: "length" }));
    await expect(compactHistory(h.options)).rejects.toThrow("未正常结束");
    expect(h.appended).toHaveLength(0);
  });

  it("响应含工具调用判失败", async () => {
    const h = harness({}, async () => summaryTurn("text", { toolCalls: [{ id: "x", name: "read" }] }));
    await expect(compactHistory(h.options)).rejects.toThrow(CompactionError);
    expect(h.appended).toHaveLength(0);
  });

  it("Provider 不可重试错误原样上抛，不写 Checkpoint", async () => {
    const error = new TurnError("non_retryable", 1, "provider said no");
    const h = harness({}, async () => {
      throw error;
    });
    await expect(compactHistory(h.options)).rejects.toBe(error);
    expect(h.appended).toHaveLength(0);
  });

  it("摘要正文目标超出模型最大输出能力时直接失败，不发请求", async () => {
    const h = harness({ model: makeModel({ maxTokens: 1000 }) });
    await expect(compactHistory(h.options)).rejects.toThrow("摘要正文目标");
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    ["空文件", async () => ""],
    ["无占位符", async () => "no placeholder here"],
    ["含 NUL", async () => "bad \0 {{TARGET_TOKENS}}"],
    [
      "读取失败",
      async () => {
        throw new Error("ENOENT");
      },
    ],
  ])("提示词%s按压缩失败处理", async (_name, loadPrompt) => {
    const h = harness({ loadPrompt });
    await expect(compactHistory(h.options)).rejects.toThrow(CompactionError);
    expect(h.requests).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
  });

  it("默认加载器读取 prompts/compaction.md 并填充目标大小", async () => {
    const h = harness({ loadPrompt: undefined, focus: "关注认证流程" });
    const outcome = await compactHistory(h.options);
    expect(outcome.status).toBe("completed");
    const last = h.requests[0]!.context.messages.at(-1)!;
    expect(typeof last.content).toBe("string");
    expect(last.content).toContain("4096");
    expect(last.content).toContain("## Goal");
    expect(last.content).not.toContain("{{TARGET_TOKENS}}");
    // 模板自身结尾换行被 trimEnd，focus 段前恰一个空行。
    expect(last.content).toContain("\n\nAdditional focus:\n关注认证流程");
    expect(last.content).not.toContain("\n\n\nAdditional focus:\n");
  });
});

describe("Checkpoint 与恢复", () => {
  it("真实 Store 提交：fsync 后报告成功，原 History 不变，恢复后上下文一致", async () => {
    const { store } = makeStore();
    const ref = sessionRef("compact-real");
    const initialRecords: NewSessionRecord[] = [
      { type: "user_prompt", runId: "run-1", text: "first goal" },
      { type: "assistant_message", runId: "run-1", message: makeAssistantMessage([{ id: "c1", name: "read" }]) },
      { type: "tool_result", runId: "run-1", assistantRecordSeq: 2, toolCallId: "c1", toolName: "read", status: "success", content: "ok" },
      { type: "assistant_message", runId: "run-1", message: makeAssistantMessage([{ id: "c2", name: "read" }]) },
      { type: "tool_result", runId: "run-1", assistantRecordSeq: 4, toolCallId: "c2", toolName: "read", status: "success", content: "ok" },
    ];
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId, initialRecords });
    const loaded = await store.loadSession(ref);
    const h = harness({
      records: loaded.records,
      context: makeContext(loaded.records),
      appendRecord: (input) => store.appendRecord(ref, input),
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", coveredUpTo: 5 });
    const after = await store.loadSession(ref);
    expect(after.records).toHaveLength(loaded.records.length + 1);
    expect(after.records.slice(0, -1)).toEqual(loaded.records);
    const checkpoint = findLatestCheckpoint(after.records)!;
    expect(checkpoint.summary).toBe("summary text");
    expect(checkpoint.coveredUpTo).toBe(5);
    expect(checkpoint.model).toEqual({ providerId: "p", modelId: "m" });
    const rebuilt = await buildContext({
      records: after.records,
      workspacePath: tempDir(),
      systemPrompt: "system prompt",
    });
    expect(rebuilt.context.messages).toHaveLength(1);
    expect(rebuilt.context.messages[0]).toMatchObject({
      role: "user",
      content: wrapConversationSummary("summary text"),
    });
    await store.releaseSession(ref);
  });

  it("保留尾部时 Checkpoint recordSeq 大于尾部 Turn，重建按 coveredUpTo 取尾部", async () => {
    const h = harness({ trigger: "continuation", retainedContextBudget: 1 });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", coveredUpTo: 3 });
    expect(h.requests[0]!.context.messages.slice(0, -1)).toEqual(h.options.context.messages.slice(0, 3));
    const checkpoint: SessionRecord = {
      ...(h.appended[0] as Extract<NewSessionRecord, { type: "checkpoint" }>),
      recordSeq: 100,
      ts: RECORD_TS,
    };
    const records = [...h.records, checkpoint];
    expect(findLatestCheckpoint(records)!.coveredUpTo).toBe(3);
    const rebuilt = await buildContext({
      records,
      workspacePath: tempDir(),
      systemPrompt: "system prompt",
    });
    expect(rebuilt.context.messages).toHaveLength(4);
    expect(rebuilt.context.messages[1]).toMatchObject({ role: "user", content: "first goal" });
    const tailAssistant = h.records[3] as Extract<SessionRecord, { type: "assistant_message" }>;
    expect(rebuilt.context.messages[2]).toBe(tailAssistant.message);
    expect(rebuilt.context.messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
  });

  it("未持有 Session 锁时写入被拒绝", async () => {
    const { store } = makeStore();
    const ref = sessionRef("compact-unowned");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
    await store.releaseSession(ref);
    const h = harness({ appendRecord: (input) => store.appendRecord(ref, input) });
    await expect(compactHistory(h.options)).rejects.toMatchObject({ code: "not_owned" });
  });

  it("写入失败原样上抛，不假定 Checkpoint 已成功", async () => {
    const error = new Error("disk full");
    const h = harness({
      appendRecord: async () => {
        throw error;
      },
    });
    await expect(compactHistory(h.options)).rejects.toBe(error);
  });
});

describe("取消", () => {
  it("压缩前已取消：返回 cancelled，不发请求不写 Checkpoint", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await compactHistory(h.options)).toEqual({ status: "cancelled", coveredUpTo: null, path: "primary" });
    expect(h.requests).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
  });

  it("流式期间取消：TurnError cancelled 映射为 cancelled 结果", async () => {
    const h = harness({}, async () => {
      throw new TurnError("cancelled", 1, "Turn aborted");
    });
    expect(await compactHistory(h.options)).toMatchObject({ status: "cancelled" });
    expect(h.appended).toHaveLength(0);
  });

  it("响应返回后、写入前取消：不写 Checkpoint", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal }, async () => {
      controller.abort();
      return summaryTurn("summary text");
    });
    expect(await compactHistory(h.options)).toMatchObject({ status: "cancelled" });
    expect(h.appended).toHaveLength(0);
  });

  it("写入期间取消且持久化成功：返回 completed", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      appendRecord: async (input) => {
        controller.abort();
        h.appended.push(input);
        return { ...input, recordSeq: 100, ts: RECORD_TS } as SessionRecord;
      },
    });
    expect(await compactHistory(h.options)).toMatchObject({ status: "completed" });
    expect(h.appended).toHaveLength(1);
  });
});

describe("预算与回退路径", () => {
  it("完整上下文放不下摘要指令时，只要覆盖前缀放得下就走主路径", async () => {
    const records = makeRecords();
    (records[2] as ToolResultRecord).content = "a".repeat(16000);
    (records[4] as ToolResultRecord).content = "b".repeat(16000);
    const context = makeContext(records);
    const h = harness({
      records, context, trigger: "continuation", currentRunId: "run-1",
      retainedContextBudget: 1, model: makeModel({ contextWindow: 15000 }),
    });
    expect(await compactHistory(h.options)).toMatchObject({ path: "primary", coveredUpTo: 3 });
    expect(h.requests[0]!.context.messages.slice(0, -1)).toEqual(context.messages.slice(0, 3));
  });

  it("下界已 >= C 时不调用模型直接失败", async () => {
    const h = harness({ model: makeModel({ contextWindow: 100 }) });
    await expect(compactHistory(h.options)).rejects.toThrow("超出上下文窗口");
    expect(h.requests).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
  });

  it("摘要提交后仍不满足可行性判据：失败且不写 Checkpoint", async () => {
    const h = harness();
    const estimated = estimateContextTokens(h.options.context, h.options.settings.tokenEstimate);
    const instructionTokens = estimateTokens(
      "Summarize the conversation in 4096 tokens.",
      h.options.settings.tokenEstimate,
    );
    const window = estimated + instructionTokens + 4096 + CONTEXT_SAFETY_MARGIN_TOKENS;
    h.options.model = makeModel({ contextWindow: window });
    h.options.modelService = {
      streamTurn: async (request) => {
        h.requests.push(request);
        return summaryTurn("x".repeat(40000));
      },
    };
    await expect(compactHistory(h.options)).rejects.toThrow("仍超出请求预算");
    expect(h.requests).toHaveLength(1);
    expect(h.appended).toHaveLength(0);
  });

  // 回退预算按覆盖消息体量校准：窗口刚好让主路径失败，且覆盖消息超出裁剪预算。
  function fallbackWindow(records: SessionRecord[]): number {
    const settings = parseSettings({});
    const selection = planCompaction(records, {
      trigger: "start",
      retainedContextBudget: 0,
      tokenEstimate: settings.tokenEstimate,
    });
    if ("status" in selection) throw new Error("expected selection");
    const coveredTokens = estimateContextTokens({ messages: selection.messages }, settings.tokenEstimate);
    const instructionTokens = estimateTokens(
      "Summarize the conversation in 4096 tokens.",
      settings.tokenEstimate,
    );
    return coveredTokens + instructionTokens + CONTEXT_SAFETY_MARGIN_TOKENS - 1;
  }

  it("主路径装不下时降级回退：tools 为空、SP 一致、保留消息形式且工具结果按阶梯裁剪", async () => {
    const records = makeRecords();
    (records[2] as ToolResultRecord).content = "x".repeat(100000);
    const context = makeContext(records);
    const h = harness({
      records,
      context,
      model: makeModel({ contextWindow: fallbackWindow(records) }),
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", path: "fallback" });
    const request = h.requests[0]!;
    expect(request.context.tools).toEqual([]);
    expect(request.context.systemPrompt).toBe(context.systemPrompt);
    const messages = request.context.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(messages[0]!.content).toBe("first goal");
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        { type: "toolCall", id: "c1", name: "read" },
      ],
    });
    const trimmedResult = messages[2]!;
    expect(trimmedResult.role).toBe("toolResult");
    if (trimmedResult.role !== "toolResult") throw new Error("expected toolResult");
    expect(trimmedResult.content).toMatchObject([
      { type: "text", text: expect.stringContaining("chars truncated]") },
    ]);
    expect(messages[5]!.content).toBe("Summarize the conversation in 4096 tokens.");
    expect((records[2] as ToolResultRecord).content).toHaveLength(100000);
  });

  it("回退路径同样携带 focus，tools 仍为空", async () => {
    const records = makeRecords();
    (records[2] as ToolResultRecord).content = "x".repeat(100000);
    const h = harness({
      records,
      context: makeContext(records),
      model: makeModel({ contextWindow: fallbackWindow(records) }),
      focus: "关注认证流程",
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", path: "fallback" });
    const request = h.requests[0]!;
    expect(request.context.tools).toEqual([]);
    expect(request.context.messages.at(-1)!.content).toBe(
      "Summarize the conversation in 4096 tokens.\n\nAdditional focus:\n关注认证流程",
    );
  });

  it("回退请求中 previousSummary 作为头部 user 消息只出现一次，且不进入 System Prompt", async () => {
    const records = [...makeRecords(), makeCheckpointRecord(6, "old summary", 3)];
    (records[4] as ToolResultRecord).content = "x".repeat(100000);
    const fresh = await buildContext({ records, workspacePath: tempDir() });
    const context = { ...makeContext(records), messages: fresh.context.messages };
    const h = harness({
      records,
      context,
      model: makeModel({ contextWindow: fallbackWindow(records) }),
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", path: "fallback" });
    const request = h.requests[0]!;
    expect(request.context.systemPrompt).toBe(context.systemPrompt);
    expect(request.context.systemPrompt).not.toContain("old summary");
    const messages = request.context.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant", "toolResult", "user"]);
    expect(messages[0]!.content).toBe(wrapConversationSummary("old summary"));
    expect(JSON.stringify(messages).split("old summary")).toHaveLength(2);
  });

  it("最低阶梯仍超预算：失败且不发送请求", async () => {
    const records = makeRecords();
    records[0] = makeUserPromptRecord(1, "run-1", "y".repeat(200000));
    const h = harness({
      records,
      context: makeContext(records),
      model: makeModel({ contextWindow: 10000 }),
    });
    await expect(compactHistory(h.options)).rejects.toThrow("仍超出预算");
    expect(h.requests).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
  });

  it("最新 Turn 之前无可压缩 Turn 时返回 noop，不算失败", async () => {
    const h = harness({ trigger: "continuation", retainedContextBudget: 1000 });
    h.options.records = h.records.slice(0, 3);
    h.options.context = makeContext(h.options.records);
    expect(await compactHistory(h.options)).toEqual({ status: "noop", coveredUpTo: null, path: "primary" });
    expect(h.requests).toHaveLength(0);
    expect(h.appended).toHaveLength(0);
  });
});

describe("思考头部空间与 no-force", () => {
  it.each([false, true])("no-force：thinking=%s 时压缩请求都不传 maxTokens", async (thinking) => {
    const h = harness({
      model: makeModel({ reasoning: true, thinking, reasoningEffort: "high", contextWindow: 128000 }),
    });
    expect(await compactHistory(h.options)).toMatchObject({ status: "completed" });
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.maxTokens).toBeUndefined();
  });

  it("主路径守卫按思考头部空间字面值移动：同一窗口 false/medium 走主路径、high 降级回退", async () => {
    const records = makeRecords();
    (records[2] as ToolResultRecord).content = "x".repeat(100000);
    const context = makeContext(records);
    const settings = parseSettings({});
    const estimated = estimateContextTokens(context, settings.tokenEstimate);
    const instructionTokens = estimateTokens(
      "Summarize the conversation in 4096 tokens.",
      settings.tokenEstimate,
    );
    const window = estimated + instructionTokens + 4096 + CONTEXT_SAFETY_MARGIN_TOKENS + 8192;

    const calm = harness({
      records,
      context,
      model: makeModel({ contextWindow: window, reasoning: true, thinking: false }),
    });
    expect(await compactHistory(calm.options)).toMatchObject({ status: "completed", path: "primary" });

    const medium = harness({
      records,
      context,
      model: makeModel({ contextWindow: window, reasoning: true, thinking: true, reasoningEffort: "medium" }),
    });
    expect(await compactHistory(medium.options)).toMatchObject({ status: "completed", path: "primary" });

    const high = harness({
      records,
      context,
      model: makeModel({ contextWindow: window, reasoning: true, thinking: true, reasoningEffort: "high" }),
    });
    expect(await compactHistory(high.options)).toMatchObject({ status: "completed", path: "fallback" });
  });

  it("思考头部空间仅在 reasoning 与 thinking 同时开启时生效", async () => {
    const window = 10000;
    const calm = harness({
      model: makeModel({ contextWindow: window, reasoning: true, thinking: false }),
    });
    expect(await compactHistory(calm.options)).toMatchObject({ status: "completed", path: "primary" });
    expect(calm.requests).toHaveLength(1);

    const nonReasoning = harness({
      model: makeModel({ contextWindow: window, reasoning: false, thinking: true, reasoningEffort: "high" }),
    });
    expect(await compactHistory(nonReasoning.options)).toMatchObject({
      status: "completed",
      path: "primary",
    });
    expect(nonReasoning.requests).toHaveLength(1);

    const thinking = harness({
      model: makeModel({ contextWindow: window, reasoning: true, thinking: true, reasoningEffort: "high" }),
    });
    await expect(compactHistory(thinking.options)).rejects.toThrow("仍超出预算");
    expect(thinking.requests).toHaveLength(0);
    expect(thinking.appended).toHaveLength(0);
  });
});

describe("含图历史双模态压缩", () => {
  function makeImageRecords(): SessionRecord[] {
    return [
      makeUserPromptRecord(1, "run-1", "look"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "view_image" }]),
      makeToolResultRecord(3, "run-1", "c1", "success", {
        toolName: "view_image",
        content: "(Image attached: image/png.)",
        images: [makePngImage(1920, 1080)], // 2765 image tokens
      }),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(5, "run-1", "c2", "success"),
    ];
  }

  // makeContext 只产纯文本；按能力用 toolResultMessage 重建 toolResult 消息。
  function makeImageContext(records: readonly SessionRecord[], imageInput: boolean): StoredContext {
    const context = makeContext(records);
    context.messages = context.messages.map((message) => {
      if (message.role !== "toolResult") return message;
      const record = records.find(
        (candidate) => candidate.type === "tool_result" && candidate.toolCallId === message.toolCallId,
      );
      return record?.type === "tool_result" ? toolResultMessage(record, imageInput) : message;
    });
    return context;
  }

  it("主路径视觉模型：摘要请求原样携带 image 块", async () => {
    const records = makeImageRecords();
    const h = harness({
      records,
      context: makeImageContext(records, true),
      model: makeModel({ input: ["text", "image"] }),
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toEqual({ status: "completed", coveredUpTo: 5, path: "primary" });
    expect(JSON.stringify(h.requests[0]!.context.messages)).toContain('"type":"image"');
  });

  it("主路径非视觉模型：摘要请求为占位文本，无 image 块", async () => {
    const records = makeImageRecords();
    const h = harness({ records, context: makeImageContext(records, false) });
    const outcome = await compactHistory(h.options);
    expect(outcome).toMatchObject({ status: "completed", path: "primary" });
    const serialized = JSON.stringify(h.requests[0]!.context.messages);
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).toContain(IMAGE_OMITTED_TEXT);
  });

  it("imageInput 随 model.input 透传：同一预算下视觉少保留 Turn、非视觉 noop", async () => {
    const records = makeImageRecords();
    const vision = harness({
      records,
      context: makeImageContext(records, true),
      model: makeModel({ input: ["text", "image"] }),
      trigger: "continuation",
      retainedContextBudget: 100,
    });
    // 最新 Turn 是小文本；含图 Turn 2765 tokens 超预算 → 被覆盖。
    expect(await compactHistory(vision.options)).toMatchObject({ status: "completed", coveredUpTo: 3 });
    const text = harness({
      records,
      context: makeImageContext(records, false),
      trigger: "continuation",
      retainedContextBudget: 100,
    });
    expect(await compactHistory(text.options)).toEqual({ status: "noop", coveredUpTo: null, path: "primary" });
    expect(text.requests).toHaveLength(0);
  });

  it("fallback 视觉模型：阶梯丢图换占位后请求无 image 块且 tools 为空", async () => {
    const records = makeImageRecords();
    const h = harness({
      records,
      context: makeImageContext(records, true),
      // 窗口 10000：摘要目标 4096 + 安全边距 4096 后余量 ≈1800 < 2765 image tokens，
      // 主路径判定超窗 → fallback，base 超预算 → 第一档即丢图收敛。
      model: makeModel({ input: ["text", "image"], contextWindow: 10000 }),
    });
    const outcome = await compactHistory(h.options);
    expect(outcome).toEqual({ status: "completed", coveredUpTo: 5, path: "fallback" });
    const request = h.requests[0]!;
    expect(request.context.tools).toEqual([]);
    const serialized = JSON.stringify(request.context.messages);
    expect(serialized).not.toContain('"type":"image"');
    expect(serialized).toContain(IMAGE_COMPACTION_OMITTED_TEXT);
  });
});
