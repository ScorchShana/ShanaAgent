import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  assertCandidateCheckpointValid,
  buildContext,
  estimateContextTokens,
  estimateTokens,
  isRequestFeasible,
  loadRootAgentsMd,
  planCompaction,
  planEffectiveContext,
  reachesCompactionThreshold,
  toAgentsMdReference,
  trimCompactionMessages,
} from "../../src/core/context-builder.js";
import type { StoredContext } from "../../src/llm/history-replay.js";
import { prepareReplay } from "../../src/llm/history-replay.js";
import { CheckpointInvalidError } from "../../src/sessions/recovery.js";
import type { SessionRecord } from "../../src/sessions/records.js";
import {
  makeAssistantRecord,
  makeCheckpointRecord,
  makeRunFinishedRecord,
  makeToolResultRecord,
  makeUserPromptRecord,
} from "../sessions/helpers.js";

const RECORD_TS = "2026-10-27T10:00:00.000Z";
const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-context-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function interruption(recordSeq: number, runId: string, toolCallId?: string): SessionRecord {
  return {
    recordSeq,
    ts: RECORD_TS,
    type: "interruption",
    runId,
    reason: "result unknown",
    ...(toolCallId !== undefined ? { toolCallId } : {}),
  };
}

describe("V4 Turn 级过滤", () => {
  it("失败 Run 保留原 Prompt 与前序完整 Turn，排除不完整尾部；首 Turn 前失败则整 Run 排除", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "write" }]),
      makeToolResultRecord(5, "run-1", "c2", "error", { toolName: "write" }),
      makeAssistantRecord(6, "run-1", [{ id: "c3", name: "read" }]),
      makeRunFinishedRecord(7, "run-1", "failed"),
      makeUserPromptRecord(8, "run-2", "second"),
      makeAssistantRecord(9, "run-2", [{ id: "c4", name: "read" }]),
      makeRunFinishedRecord(10, "run-2", "failed"),
    ];

    const plan = planEffectiveContext(records);

    expect(plan.checkpoint).toBeNull();
    expect(plan.runs).toHaveLength(2);
    expect(plan.runs[0]?.promptIncluded).toBe(true);
    expect(plan.runs[0]?.turns.map((turn) => turn.assistant.recordSeq)).toEqual([2, 4]);
    expect(
      plan.runs[0]?.excludedTurns.map((turn) => ({
        seq: turn.assistant.recordSeq,
        reason: turn.reason,
      })),
    ).toEqual([{ seq: 6, reason: "incomplete_results" }]);

    expect(plan.runs[1]?.promptIncluded).toBe(false);
    expect(plan.runs[1]?.turns).toEqual([]);
    expect(plan.runs[1]?.excludedTurns.map((turn) => turn.reason)).toEqual(["incomplete_results"]);
  });

  it("构建的消息只含原 Prompt 与连续完整 Turn，再拼当前 Prompt", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "write" }]),
      makeToolResultRecord(5, "run-1", "c2", "error", { toolName: "write" }),
      makeAssistantRecord(6, "run-1", [{ id: "c3", name: "read" }]),
      makeUserPromptRecord(7, "run-2", "second"),
      makeAssistantRecord(8, "run-2", [{ id: "c4", name: "read" }]),
    ];

    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });

    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(built.context.messages[0]).toMatchObject({ role: "user", content: "first" });
    expect(built.context.messages[1]).toBe(records[1]?.message);
    expect(built.context.messages[3]).toBe(records[3]?.message);
    expect(built.context.messages[5]).toMatchObject({ role: "user", content: "now" });
  });
});

describe("V5 unknown 拦截", () => {
  it("含 unknown 的 Turn 不进上下文，interruption 不改变判定", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "do it"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
      makeToolResultRecord(3, "run-1", "c1", "unknown"),
      interruption(4, "run-1", "c1"),
      makeUserPromptRecord(5, "run-2", "retry"),
      makeAssistantRecord(6, "run-2", [{ id: "c2", name: "write" }]),
      interruption(7, "run-2", "c2"),
    ];

    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.turns).toEqual([]);
    expect(plan.runs[0]?.promptIncluded).toBe(false);
    expect(plan.runs[0]?.excludedTurns).toEqual([
      { assistant: records[1], reason: "unknown_side_effect", toolCallIds: ["c1"] },
    ]);
    expect(plan.runs[1]?.turns).toEqual([]);
    expect(plan.runs[1]?.excludedTurns[0]?.reason).toBe("incomplete_results");

    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(built.context.messages).toHaveLength(1);
    expect(built.context.messages[0]).toMatchObject({ role: "user", content: "now" });
  });
});

describe("V7 检查点使用", () => {
  it.each(["length", "error", "aborted", "pending", "deferred"] as const)(
    "检查点不得覆盖被上下文排除的 %s 响应",
    async (stopReason) => {
      const records: SessionRecord[] = [
        makeUserPromptRecord(1, "run-1", "first"),
        makeAssistantRecord(2, "run-1", [], { stopReason }),
      ];
      const plan = planEffectiveContext(records);
      expect(plan.runs[0]?.turns).toEqual([]);
      expect(plan.runs[0]?.excludedTurns[0]?.reason).toBe(
        stopReason === "length" ? "truncated" : "incomplete_response",
      );
      records.push(makeCheckpointRecord(3, "must not inject excluded response", 2));

      expect.soft(() => planEffectiveContext(records)).toThrow(CheckpointInvalidError);
      await expect(
        buildContext({ records, currentPrompt: "now", workspacePath: makeWorkspace() }),
      ).rejects.toBeInstanceOf(CheckpointInvalidError);
    },
  );

  it("检查点覆盖审计区间时可以跳过前一失败 Run，只总结有效上下文", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "failed request"),
      makeAssistantRecord(2, "run-1", [], { stopReason: "aborted" }),
      makeUserPromptRecord(3, "run-2", "next request"),
      makeAssistantRecord(4, "run-2", [], { stopReason: "stop" }),
      makeCheckpointRecord(5, "invalid coverage", 4),
    ];

    expect(planEffectiveContext(records).checkpoint?.coveredUpTo).toBe(4);
  });

  it("有效检查点替代其覆盖的历史，其后完整 Turn 进入上下文，被排除 Turn 不再出现", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeCheckpointRecord(4, "S1", 3),
      makeAssistantRecord(5, "run-1", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(6, "run-1", "c2", "success"),
      makeAssistantRecord(7, "run-1", [{ id: "c3", name: "read" }]),
      makeRunFinishedRecord(8, "run-1", "failed"),
    ];

    const plan = planEffectiveContext(records);
    expect(plan.checkpoint?.summary).toBe("S1");
    expect(plan.coveredUpTo).toBe(3);
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0]?.prompt).toBeNull();
    expect(plan.runs[0]?.turns.map((turn) => turn.assistant.recordSeq)).toEqual([5]);
    expect(plan.runs[0]?.excludedTurns.map((turn) => turn.assistant.recordSeq)).toEqual([7]);

    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(built.context.systemPrompt).not.toContain("S1");
    expect(built.context.systemPrompt).not.toContain("conversation_summary");
    expect(built.context.messages[0]).toMatchObject({
      role: "user",
      content: "<conversation_summary>\nS1\n</conversation_summary>",
    });
    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(built.context.messages[1]).toBe(records[4]?.message);
    expect(built.context.messages.some((message) => message === records[0]?.message)).toBe(false);
    expect(built.context.messages.some((message) => message === records[2]?.message)).toBe(false);
  });

  it("检查点边界含工具调用或落在 Turn 中途时明确报错", () => {
    const boundaryOnAssistant: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeCheckpointRecord(4, "S", 2),
    ];
    expect(() => planEffectiveContext(boundaryOnAssistant)).toThrow(CheckpointInvalidError);

    const boundaryMidTurn: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [
        { id: "c1", name: "read" },
        { id: "c2", name: "read" },
      ]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeToolResultRecord(4, "run-1", "c2", "success", { assistantRecordSeq: 2 }),
      makeCheckpointRecord(5, "S", 3),
    ];
    expect(() => planEffectiveContext(boundaryMidTurn)).toThrow(/Turn 中途结束/);
  });

  it("无 checkpoint 时不注入摘要消息", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(
      built.context.messages.some(
        (message) => message.role === "user" && message.content.includes("<conversation_summary>"),
      ),
    ).toBe(false);
  });

  it("摘要消息 timestamp 取 checkpoint.ts，内容格式精确匹配", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeCheckpointRecord(4, "line1\nline2", 3),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages).toHaveLength(1);
    expect(built.context.messages[0]).toEqual({
      role: "user",
      content: "<conversation_summary>\nline1\nline2\n</conversation_summary>",
      timestamp: Date.parse(RECORD_TS),
    });
  });

  it("摘要消息位于保留尾部 Turn 与当前 Prompt 之前，末条恒为当前 Prompt", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeCheckpointRecord(4, "S", 3),
      makeAssistantRecord(5, "run-1", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(6, "run-1", "c2", "success"),
    ];
    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(built.context.messages[0]).toMatchObject({
      role: "user",
      content: "<conversation_summary>\nS\n</conversation_summary>",
    });
    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(built.context.messages.at(-1)).toMatchObject({ role: "user", content: "now" });
  });

  it("有/无 checkpoint 的 System Prompt 逐字节一致", async () => {
    const workspace = makeWorkspace();
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    const without = await buildContext({ records, workspacePath: workspace });
    const withCheckpoint = await buildContext({
      records: [...records, makeCheckpointRecord(4, "S", 3)],
      workspacePath: workspace,
    });
    expect(withCheckpoint.context.systemPrompt).toBe(without.context.systemPrompt);
    expect(withCheckpoint.context.systemPrompt).not.toContain("conversation_summary");
  });

  it("含头部摘要消息的上下文经 prepareReplay 原样透传", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeCheckpointRecord(4, "S", 3),
      makeAssistantRecord(5, "run-1", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(6, "run-1", "c2", "success"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    const replay = prepareReplay(built.context);
    expect(replay.context.messages[0]).toEqual(built.context.messages[0]);
  });
});

describe("V8 AGENTS.md", () => {
  it("未传快照时每次读盘、传入快照时冻结", async () => {
    const workspace = makeWorkspace();
    const agentsPath = path.join(workspace, "AGENTS.md");
    fs.writeFileSync(agentsPath, "rule one\n");

    const first = await loadRootAgentsMd(workspace);
    expect(first).toMatchObject({ path: agentsPath, present: true, content: "rule one\n" });
    expect(toAgentsMdReference(first)).toEqual({
      path: agentsPath,
      present: true,
    });

    const builtFirst = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: workspace,
      systemPrompt: "SYS",
    });
    const prompt = builtFirst.context.systemPrompt ?? "";
    expect(prompt).toContain("SYS");
    expect(prompt).toContain("<project_instructions>");
    expect(prompt).not.toContain("The following project instructions come from");
    expect(prompt).not.toContain("project-instruction priority defined above.");
    expect(prompt).toContain("rule one\n");
    expect(prompt.endsWith("<project_instructions>\nrule one\n</project_instructions>")).toBe(true);
    expect(prompt).toContain("SYS\n\n<project_instructions>");
    expect(prompt).not.toContain("<project_instructions>\n\n");
    expect(builtFirst.warnings).toEqual([]);

    fs.writeFileSync(agentsPath, "rule two\n");
    const builtSecond = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: workspace,
    });
    expect(builtSecond.context.systemPrompt).toContain("rule two");
    expect(builtFirst.context.systemPrompt).toContain("rule one");
    expect(builtFirst.context.systemPrompt).not.toContain("rule two");

    // 传入已冻结快照时不重新读盘
    fs.writeFileSync(agentsPath, "rule three\n");
    const builtFrozen = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: workspace,
      agentsMd: builtFirst.agentsMd,
    });
    expect(builtFrozen.context.systemPrompt).toContain("rule one");
    expect(builtFrozen.context.systemPrompt).not.toContain("rule three");
  });

  it("存在但读取失败时省略项目规则、Run 继续并产生 TUI 提示", async () => {
    const workspace = makeWorkspace();
    const failed = await loadRootAgentsMd(workspace, {
      readFile: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(failed.present).toBe(true);
    expect(failed.readError).toContain("EACCES");

    const built = await buildContext({
      records: [],
      currentPrompt: "still run",
      workspacePath: workspace,
      agentsMd: failed,
    });
    expect(built.context.systemPrompt).not.toContain("AGENTS.md exists but could not be read");
    expect(built.context.systemPrompt).not.toContain("<project_instructions>");
    expect(built.context.systemPrompt).not.toContain("EACCES");
    expect(built.warnings).toEqual([
      { kind: "agents_md_read_failed", path: built.agentsMd.path, message: failed.readError },
    ]);
    expect(built.context.messages).toHaveLength(1);
    expect(built.context.messages[0]).toMatchObject({ role: "user", content: "still run" });
  });

  it("根 AGENTS.md 不存在时不注入也不报警", async () => {
    const built = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: makeWorkspace(),
    });
    expect(built.agentsMd.present).toBe(false);
    const prompt = (built.context.systemPrompt ?? "").replaceAll("\r\n", "\n");
    expect(prompt).toContain("<agent>");
    expect(prompt).toContain("<core_rules>");
    expect(prompt).toContain("<agent>\nYou are");
    expect(prompt).toContain("</agent>\n\n<core_rules>");
    expect(prompt).toContain("<core_rules>\n- Follow");
    expect(prompt).toContain("unverified items.\n</core_rules>");
    expect(prompt).not.toContain("<agent>\n\n");
    expect(prompt).not.toContain("<core_rules>\n\n");
    expect(prompt).not.toContain("<project_instructions>");
    expect(built.warnings).toEqual([]);
  });

  it("environment 正文由 buildContext 包裹为 <environment> 区块", async () => {
    const built = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: makeWorkspace(),
      systemPrompt: "SYS",
      environment: "Workspace: W\nPlatform: P",
    });
    const prompt = (built.context.systemPrompt ?? "").replaceAll("\r\n", "\n");
    expect(prompt).toContain("SYS\n\n<environment>\nWorkspace: W\nPlatform: P\n</environment>");
    expect(prompt).not.toContain("<environment>\n\n");
    expect(prompt).not.toContain("\n\n</environment>");
    expect(prompt.indexOf("SYS")).toBeLessThan(prompt.indexOf("<environment>"));
  });
});

it("默认系统提示词拒绝非法 UTF-8 编码", async () => {
  const read = vi.spyOn(fs.promises, "readFile").mockResolvedValueOnce(Buffer.from([0xc3, 0x28]));
  try {
    await expect(
      buildContext({
        records: [],
        currentPrompt: "hi",
        workspacePath: "unused",
        agentsMd: { path: "unused/AGENTS.md", present: false },
      }),
    ).rejects.toThrow(/encoded data.*valid/i);
  } finally {
    read.mockRestore();
  }
});

const ESTIMATE = { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5 };

describe("V9 Token 近似估算", () => {
  it("空文本、纯 ASCII、纯非 ASCII 与中英混合按 code point 分类求和后向上取整", () => {
    expect(estimateTokens("", ESTIMATE)).toBe(0);
    expect(estimateTokens("abcd", ESTIMATE)).toBe(1);
    expect(estimateTokens("a", ESTIMATE)).toBe(1);
    expect(estimateTokens("中文", ESTIMATE)).toBe(2);
    expect(estimateTokens("中文字", ESTIMATE)).toBe(2);
    expect(estimateTokens("a中b文", ESTIMATE)).toBe(2);
  });

  it("Emoji 与代理对按单个 code point 计入非 ASCII", () => {
    expect(estimateTokens("😀", ESTIMATE)).toBe(1);
    expect(estimateTokens("😀😀", ESTIMATE)).toBe(2);
  });

  it("JSON 参数与转义字符按同一规则估算", () => {
    const raw = JSON.stringify({ path: "a\\b", content: "line\nbreak" });
    expect(estimateTokens(raw, ESTIMATE)).toBe(Math.ceil(raw.length / 4));
  });

  it("支持 settings 覆盖的估算参数", () => {
    expect(estimateTokens("abcd", { asciiCharsPerToken: 1, nonAsciiCharsPerToken: 1 })).toBe(4);
    expect(estimateTokens("中文", { asciiCharsPerToken: 1, nonAsciiCharsPerToken: 1 })).toBe(2);
  });
});

describe("V9 Context 估算范围", () => {
  function makeContext(): StoredContext {
    const tools = [{ name: "read", description: "d", parameters: { type: "object" } }];
    const context: StoredContext = {
      systemPrompt: "abcd",
      messages: [
        { role: "user", content: "abcd", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "abcd" },
            { type: "thinking", thinking: "abcd" },
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              rawArguments: "abcd",
              parse: { status: "parsed", arguments: {} },
            },
          ],
          api: "openai-completions",
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 999_999,
            output: 999_999,
            cacheRead: 999_999,
            cacheWrite: 999_999,
            totalTokens: 3_999_996,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 999_999,
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "abcd" }],
          isError: false,
          timestamp: 999_999,
        },
      ],
      tools,
    } as unknown as StoredContext;
    return context;
  }

  it("统计系统提示词、消息、Thinking、rawArguments、工具结果与工具 Schema", () => {
    const context = makeContext();
    const expected =
      1 + // systemPrompt
      1 + // user
      3 + // assistant text + thinking + rawArguments
      1 + // toolResult
      estimateTokens(JSON.stringify(context.tools), ESTIMATE);
    expect(estimateContextTokens(context, ESTIMATE)).toBe(expected);
  });

  it("未发送的时间戳与 usage 不计入估算", () => {
    const context = makeContext();
    const withoutMetadata = estimateContextTokens(context, ESTIMATE);
    const assistant = context.messages[1] as { timestamp: number; usage: { totalTokens: number } };
    assistant.timestamp = 0;
    assistant.usage.totalTokens = 0;
    expect(estimateContextTokens(context, ESTIMATE)).toBe(withoutMetadata);
  });

  it("没有工具 Schema 时不计入空数组", () => {
    const context = makeContext();
    delete context.tools;
    const expected = estimateContextTokens(context, ESTIMATE);
    context.tools = [];
    expect(estimateContextTokens(context, ESTIMATE)).toBe(expected);
  });
});

describe("V9 可行性判据与压缩阈值", () => {
  it("可行性判据为 E + 4096 <= C 的边界", () => {
    expect(CONTEXT_SAFETY_MARGIN_TOKENS).toBe(4096);
    expect(isRequestFeasible(10_000 - CONTEXT_SAFETY_MARGIN_TOKENS, 10_000)).toBe(true);
    expect(isRequestFeasible(10_000 - CONTEXT_SAFETY_MARGIN_TOKENS + 1, 10_000)).toBe(false);
  });

  it("达到 contextWindow × 阈值时触发，低于 1 token 不触发", () => {
    expect(reachesCompactionThreshold(80_000, 100_000, 0.8)).toBe(true);
    expect(reachesCompactionThreshold(79_999, 100_000, 0.8)).toBe(false);
    expect(reachesCompactionThreshold(100_000, 100_000, 1)).toBe(true);
  });
});

// 每个完整 Turn 的估算成本：assistant 文本 1 + rawArguments "{}" 1 + 工具结果 1。
// 每个 Run Prompt（"first"/"second"）为 2。
const MANUAL_COMPACTION = {
  keepLatestTurn: false,
  retainedContextBudget: 0,
  tokenEstimate: ESTIMATE,
};
const TAIL_COMPACTION = {
  keepLatestTurn: true,
  retainedContextBudget: 0,
  tokenEstimate: ESTIMATE,
};

function twoRunRecords(): SessionRecord[] {
  return [
    makeUserPromptRecord(1, "run-1", "first"),
    makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
    makeToolResultRecord(3, "run-1", "c1", "success"),
    makeAssistantRecord(4, "run-1", [{ id: "c2", name: "read" }]),
    makeToolResultRecord(5, "run-1", "c2", "success"),
    makeUserPromptRecord(6, "run-2", "second"),
    makeAssistantRecord(7, "run-2", [{ id: "c3", name: "read" }]),
    makeToolResultRecord(8, "run-2", "c3", "success"),
    makeAssistantRecord(9, "run-2", [{ id: "c4", name: "read" }]),
    makeToolResultRecord(10, "run-2", "c4", "success"),
  ];
}

function expectSelection(selection: ReturnType<typeof planCompaction>) {
  if ("status" in selection) throw new Error(`expected selection, got ${selection.status}`);
  return selection;
}

describe("V10 压缩范围选择", () => {
  it("没有完整 Turn 时返回 noop", () => {
    expect(
      planCompaction([makeUserPromptRecord(1, "run-1", "first")], MANUAL_COMPACTION),
    ).toEqual({ status: "noop" });
  });

  it("手动压缩与触发点 (A) 不保留尾部，压缩全部 eligible Turn", () => {
    const records = twoRunRecords();
    const selection = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(selection.coveredUpTo).toBe(10);
    expect(selection.previousSummary).toBeNull();
    expect(selection.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(
      selection.messages
        .filter((message) => message.role === "user")
        .map((message) => (message as { content: string }).content),
    ).toEqual(["first", "second"]);
  });

  it("只有最新 Turn 时触发点 (B) 返回 noop，手动压缩仍可选择它", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "only"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    expect(planCompaction(records, TAIL_COMPACTION)).toEqual({ status: "noop" });
    const manual = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(manual.coveredUpTo).toBe(3);
  });

  it("触发点 (B) 的最新 Turn 单独超预算仍逐字保留，只压缩更早 Turn", () => {
    const records = twoRunRecords();
    const latestMessage = records[8]!.message as unknown as {
      content: Array<{ type: string; text?: string }>;
    };
    latestMessage.content.find((block) => block.type === "text")!.text = "x".repeat(50_000);

    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 1 }),
    );
    expect(selection.coveredUpTo).toBe(8);
    expect(selection.messages).not.toContain(records[8]!.message);
    expect(selection.messages).toContain(records[6]!.message);
    expect(selection.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("保留预算按 Token 动态决定尾部保留的连续 Turn 数量", () => {
    const records = twoRunRecords();
    // 保留 2 个 Turn：最新 3 + 前一个 3 = 6，加入 run-1 的 Turn 与 Prompt = 11 超预算。
    const twoTurns = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 10 }),
    );
    expect(twoTurns.coveredUpTo).toBe(5);
    expect(twoTurns.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);

    // 保留 3 个 Turn：跨 Run 边界时把 run-1 的 Prompt 计入预算。
    const threeTurns = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 11 }),
    );
    expect(threeTurns.coveredUpTo).toBe(3);
    expect(threeTurns.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);

    // 预算为 0 时只保留最新 Turn。
    const latestOnly = expectSelection(planCompaction(records, TAIL_COMPACTION));
    expect(latestOnly.coveredUpTo).toBe(8);
    expect(latestOnly.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("被排除的 Turn 不进入压缩输入，失败 Run 的 Prompt 也不会单独出现", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [], { stopReason: "length" }),
      makeUserPromptRecord(3, "run-2", "second"),
      makeAssistantRecord(4, "run-2", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(5, "run-2", "c1", "unknown"),
      makeUserPromptRecord(6, "run-3", "third"),
      makeAssistantRecord(7, "run-3", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(8, "run-3", "c2", "success"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.excludedTurns[0]?.reason).toBe("truncated");
    expect(plan.runs[1]?.excludedTurns[0]?.reason).toBe("unknown_side_effect");

    const selection = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(selection.coveredUpTo).toBe(8);
    expect(selection.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(selection.messages[0]).toMatchObject({ content: "third" });
  });

  it("stopReason=length 但工具结果齐全的 Turn 仍可压缩，调用与结果不被拆开", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }], { stopReason: "length" }),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    const selection = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(selection.coveredUpTo).toBe(3);
    expect(selection.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(selection.messages[1]).toBe(records[1]?.message);
  });

  it("最后覆盖 Turn 无工具结果时 coveredUpTo 指向 assistant_message", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", []),
    ];
    const selection = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(selection.coveredUpTo).toBe(2);
    expect(() => assertCandidateCheckpointValid(records, selection.coveredUpTo)).not.toThrow();
    expect(() => planEffectiveContext([...records, makeCheckpointRecord(3, "S", 2)])).not.toThrow();
  });

  it("跨多个 Run 时被覆盖 Run 的 Prompt 进入压缩输入且只出现一次", () => {
    const records = twoRunRecords();
    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 11 }),
    );
    expect(selection.coveredUpTo).toBe(3);
    const prompts = selection.messages.filter((message) => message.role === "user");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ content: "first" });
  });
});

describe("V10 候选 Checkpoint 预校验", () => {
  it("合法边界通过，Turn 中途、含工具调用的 assistant 与 user_prompt 边界被拒绝", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [
        { id: "c1", name: "read" },
        { id: "c2", name: "read" },
      ]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeToolResultRecord(4, "run-1", "c2", "success", { assistantRecordSeq: 2 }),
    ];
    expect(() => assertCandidateCheckpointValid(records, 4)).not.toThrow();
    expect(() => assertCandidateCheckpointValid(records, 3)).toThrow(/Turn 中途结束/);
    expect(() => assertCandidateCheckpointValid(records, 2)).toThrow(/Turn 未结束/);
    expect(() => assertCandidateCheckpointValid(records, 1)).toThrow(/不是 Turn 边界/);
    expect(() => assertCandidateCheckpointValid(records, 0)).toThrow(/至少须覆盖一条记录/);
  });

  it("planCompaction 返回的边界可直接追加为有效 Checkpoint", () => {
    const records = twoRunRecords();
    const selection = expectSelection(planCompaction(records, TAIL_COMPACTION));
    const checkpoint = makeCheckpointRecord(11, "S", selection.coveredUpTo);
    const plan = planEffectiveContext([...records, checkpoint]);
    expect(plan.checkpoint?.summary).toBe("S");
    expect(plan.runs.flatMap((run) => run.turns.map((turn) => turn.assistant.recordSeq))).toEqual([9]);
  });

  it("触发点 (B) 压缩后当前 Run 的 Prompt 与保留 Turn 仍在有效历史中", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeUserPromptRecord(4, "run-2", "second"),
      makeAssistantRecord(5, "run-2", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(6, "run-2", "c2", "success"),
    ];
    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 0 }),
    );
    expect(selection.coveredUpTo).toBe(3);
    records.push(makeCheckpointRecord(7, "S", 3));

    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.plan.runs[0]?.promptIncluded).toBe(true);
    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(built.context.messages[1]).toMatchObject({ content: "second" });
    expect(built.context.messages[2]).toBe(records[4]?.message);

    const withCurrent = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(withCurrent.context.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(
      withCurrent.context.messages.filter(
        (message) => message.role === "user" && message.content === "now",
      ),
    ).toHaveLength(1);
  });

  it("触发点 (A) 提供 currentPrompt 时只追加一次，不重复持久化的 Prompt", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeUserPromptRecord(4, "run-2", "now"),
    ];
    const selection = expectSelection(planCompaction(records, MANUAL_COMPACTION));
    expect(selection.coveredUpTo).toBe(3);
    records.push(makeCheckpointRecord(5, "S", 3));

    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(
      built.context.messages.filter(
        (message) => message.role === "user" && message.content === "now",
      ),
    ).toHaveLength(1);

    const rebuilt = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(rebuilt.context.messages).toHaveLength(1);
    expect(rebuilt.context.messages[0]).toMatchObject({
      role: "user",
      content: "<conversation_summary>\nS\n</conversation_summary>",
    });
  });
});

describe("V15 回退消息裁剪与阶梯裁剪", () => {
  const TRIM_OPTIONS = { tokenEstimate: ESTIMATE, toolResultMaxChars: 4000, maxTokens: 1_000_000 };

  function twoTurnRecords(): SessionRecord[] {
    return [
      makeUserPromptRecord(1, "run-1", "TASK"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read", arguments: { path: "src/a.ts" } }]),
      makeToolResultRecord(3, "run-1", "c1", "success", { content: "file body" }),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "bash", arguments: { command: "ls" } }]),
      makeToolResultRecord(5, "run-1", "c2", "error", { toolName: "bash", content: "boom" }),
    ];
  }

  function selectionMessages(records: SessionRecord[]): StoredContext["messages"] {
    return expectSelection(planCompaction(records, MANUAL_COMPACTION)).messages;
  }

  function trimOf(records: SessionRecord[], options: { maxTokens?: number } = {}) {
    const result = trimCompactionMessages(selectionMessages(records), {
      ...TRIM_OPTIONS,
      maxTokens: options.maxTokens ?? TRIM_OPTIONS.maxTokens,
    });
    if (result.status !== "ok") throw new Error("expected trimmed messages");
    return result;
  }

  it("保留消息形式：角色顺序、工具调用原始参数与错误状态原文不变", () => {
    const result = trimOf(twoTurnRecords());
    expect(result.toolResultLimit).toBeNull();
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(result.messages[0]).toMatchObject({ role: "user", content: "TASK" });
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        {
          type: "toolCall",
          id: "c1",
          name: "read",
          rawArguments: JSON.stringify({ path: "src/a.ts" }),
        },
      ],
    });
    expect(result.messages[2]).toMatchObject({
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "file body" }],
      isError: false,
    });
    expect(result.messages[4]).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    });
  });

  it("剥离 Thinking 且克隆消息，Session 原文与其他诊断字段不受影响", () => {
    const records = twoTurnRecords();
    const assistant = records[1]!.message as unknown as {
      content: Array<Record<string, unknown>>;
    };
    assistant.content.push({ type: "thinking", thinking: "THINKING_SENTINEL" });
    (records[2] as { priorContent?: string }).priorContent = "PRIOR_SENTINEL";
    const snapshot = JSON.stringify(records);

    const result = trimOf(records);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain("THINKING_SENTINEL");
    expect(serialized).not.toContain(RECORD_TS);
    expect(serialized).not.toContain("PRIOR_SENTINEL");
    expect(result.messages[1]).not.toBe(records[1]!.message);
    expect(result.messages[2]).toMatchObject({ isError: false });
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it("短工具结果不裁剪，超过阶梯时才按 4000 → 1000 → 400 保头保尾", () => {
    const shortResult = trimOf(twoTurnRecords());
    expect(shortResult.toolResultLimit).toBeNull();
    expect(shortResult.messages[2]).toMatchObject({
      content: [{ type: "text", text: "file body" }],
    });

    const content = Array.from({ length: 100_000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");
    const records = twoTurnRecords();
    records[2] = makeToolResultRecord(3, "run-1", "c1", "success", { content });

    const full = trimOf(records);
    const fullTokens = estimateContextTokens({ messages: full.messages }, ESTIMATE);
    const rung4000 = trimOf(records, { maxTokens: fullTokens - 1 });
    expect(rung4000.toolResultLimit).toBe(4000);
    expect(rung4000.messages[2]).toMatchObject({
      content: [
        {
          type: "text",
          text: `${content.slice(0, 2400)}…[96000 chars truncated]…${content.slice(-1600)}`,
        },
      ],
    });

    const tokens4000 = estimateContextTokens({ messages: rung4000.messages }, ESTIMATE);
    const rung1000 = trimOf(records, { maxTokens: tokens4000 - 1 });
    expect(rung1000.toolResultLimit).toBe(1000);
    expect(rung1000.messages[2]).toMatchObject({
      content: [
        {
          type: "text",
          text: `${content.slice(0, 600)}…[99000 chars truncated]…${content.slice(-400)}`,
        },
      ],
    });

    const tokens1000 = estimateContextTokens({ messages: rung1000.messages }, ESTIMATE);
    const rung400 = trimOf(records, { maxTokens: tokens1000 - 1 });
    expect(rung400.toolResultLimit).toBe(400);
    expect(rung400.messages[2]).toMatchObject({
      content: [
        {
          type: "text",
          text: `${content.slice(0, 240)}…[99600 chars truncated]…${content.slice(-160)}`,
        },
      ],
    });
  });

  it("裁剪只作用于工具结果，Prompt、可见正文与 rawArguments 保持原文", () => {
    const prompt = "TASK ".repeat(400);
    const answer = "ANSWER ".repeat(400);
    const rawArguments = JSON.stringify({ path: "ARG".repeat(3000) });
    const content = "r".repeat(100_000);
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", prompt),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read", arguments: JSON.parse(rawArguments) }], {
        text: answer,
      }),
      makeToolResultRecord(3, "run-1", "c1", "success", { content }),
    ];
    const snapshot = JSON.stringify(records);

    const full = trimOf(records);
    const fullTokens = estimateContextTokens({ messages: full.messages }, ESTIMATE);
    const rung4000 = trimOf(records, { maxTokens: fullTokens - 1 });

    expect(rung4000.toolResultLimit).toBe(4000);
    expect(rung4000.messages[0]).toMatchObject({ content: prompt });
    expect(rung4000.messages[1]).toMatchObject({
      content: [
        { type: "text", text: answer },
        { type: "toolCall", rawArguments },
      ],
    });
    expect(JSON.stringify(rung4000.messages[2])).toContain("chars truncated");
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it("最低阶梯仍超预算时返回 too_large 且不产出超限消息", () => {
    expect(
      trimCompactionMessages(selectionMessages(twoTurnRecords()), {
        ...TRIM_OPTIONS,
        maxTokens: 1,
      }),
    ).toEqual({ status: "too_large" });
  });
});
