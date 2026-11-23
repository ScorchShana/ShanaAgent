import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  FAILED_REQUEST_ANNOTATION,
  IMAGE_COMPACTION_OMITTED_TEXT,
  IMAGE_OMITTED_TEXT,
  INTERRUPTED_RESPONSE_ANNOTATION,
  MISSING_TOOL_RESULT_TEXT,
  PREVIOUS_REQUEST_INTERRUPTED_PREFIX,
  UNKNOWN_RESULT_ANNOTATION,
  assertCandidateCheckpointValid,
  buildContext,
  estimateContextTokens,
  estimateMessageTokens,
  estimateTokens,
  isRequestFeasible,
  loadRootAgentsMd,
  measuredPromptTokens,
  planCompaction,
  planEffectiveContext,
  reachesCompactionThreshold,
  toAgentsMdReference,
  toolResultMessage,
  trimCompactionMessages,
  turnMessages,
} from "../../src/core/context-builder.js";
import type { Usage } from "@earendil-works/pi-ai";
import type { StoredContext } from "../../src/llm/history-replay.js";
import { prepareReplay } from "../../src/llm/history-replay.js";
import { CheckpointInvalidError } from "../../src/sessions/recovery.js";
import type { SessionRecord, SkillSnapshot, ToolResultRecord, UserPromptRecord } from "../../src/sessions/records.js";
import { renderSkillMessage } from "../../src/core/skills.js";
import {
  makeAssistantRecord,
  makeCheckpointRecord,
  makePngImage,
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
  it("失败 Run 保留原 Prompt；缺结果 Turn 受控进入（合成 unknown 占位），Prompt 恒进", () => {
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
    expect(plan.runs[0]?.turns.map((turn) => turn.assistant.recordSeq)).toEqual([2, 4, 6]);
    expect(plan.runs[0]?.turns[2]?.missingCalls).toEqual([{ toolCallId: "c3", toolName: "read" }]);
    expect(plan.runs[0]?.turns[2]?.hasUnknown).toBe(true);
    expect(plan.runs[0]?.excludedTurns).toEqual([]);

    expect(plan.runs[1]?.promptIncluded).toBe(true);
    expect(plan.runs[1]?.failed).toBe(true);
    expect(plan.runs[1]?.turns.map((turn) => turn.assistant.recordSeq)).toEqual([9]);
    expect(plan.runs[1]?.turns[0]?.hasUnknown).toBe(true);
    expect(plan.runs[1]?.excludedTurns).toEqual([]);
  });

  it("构建的消息含原 Prompt、完整 Turn 与缺结果占位/未知标注，再拼当前 Prompt", async () => {
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
      "assistant",
      "toolResult",
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(built.context.messages[0]).toMatchObject({ role: "user", content: "first" });
    expect(built.context.messages[1]).toBe(records[1]?.message);
    expect(built.context.messages[3]).toBe(records[3]?.message);
    expect(built.context.messages[5]).toBe(records[5]?.message);
    expect(built.context.messages[6]).toMatchObject({
      role: "toolResult",
      toolCallId: "c3",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(built.context.messages[7]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
    expect(built.context.messages[8]).toMatchObject({ role: "user", content: "second" });
    expect(built.context.messages[12]).toMatchObject({ role: "user", content: "now" });
    expect(() => prepareReplay(built.context)).not.toThrow();
  });
});

describe("V5 unknown 受控进入", () => {
  it("含 unknown 结果的 Turn 进上下文并附询问标注；缺结果 Turn 合成占位", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "do it"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "write" }]),
      makeToolResultRecord(3, "run-1", "c1", "unknown", { toolName: "write" }),
      interruption(4, "run-1", "c1"),
      makeUserPromptRecord(5, "run-2", "retry"),
      makeAssistantRecord(6, "run-2", [{ id: "c2", name: "write" }]),
      interruption(7, "run-2", "c2"),
    ];

    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.promptIncluded).toBe(true);
    expect(plan.runs[0]?.turns).toHaveLength(1);
    expect(plan.runs[0]?.turns[0]?.hasUnknown).toBe(true);
    expect(plan.runs[0]?.turns[0]?.missingCalls).toEqual([]);
    expect(plan.runs[0]?.excludedTurns).toEqual([]);
    expect(plan.runs[1]?.turns[0]?.missingCalls).toEqual([{ toolCallId: "c2", toolName: "write" }]);
    expect(plan.runs[1]?.turns[0]?.hasUnknown).toBe(true);

    const built = await buildContext({
      records,
      currentPrompt: "now",
      workspacePath: makeWorkspace(),
    });
    expect(built.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(built.context.messages[0]).toMatchObject({ content: "do it" });
    // 真实 unknown 结果原文进上下文（isError），不被占位替换。
    expect(built.context.messages[2]).toMatchObject({ toolCallId: "c1", isError: true });
    expect(built.context.messages[3]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
    expect(built.context.messages[4]).toMatchObject({ content: "retry" });
    expect(built.context.messages[6]).toMatchObject({
      toolCallId: "c2",
      toolName: "write",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(built.context.messages[7]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
    expect(built.context.messages[8]).toMatchObject({ content: "now" });
    expect(() => prepareReplay(built.context)).not.toThrow();
  });
});

describe("V7 检查点使用", () => {
  it.each(["length", "error", "pending", "deferred"] as const)(
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
      makeAssistantRecord(2, "run-1", [], { stopReason: "error" }),
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
    expect(plan.runs[0]?.prompt).toEqual(records[0]);
    expect(plan.runs[0]?.turns.map((turn) => turn.assistant.recordSeq)).toEqual([5, 7]);
    expect(plan.runs[0]?.turns[1]?.hasUnknown).toBe(true);
    expect(plan.runs[0]?.excludedTurns).toEqual([]);

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
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(built.context.messages[2]).toBe(records[4]?.message);
    expect(built.context.messages[5]).toMatchObject({ toolCallId: "c3", isError: true });
    expect(built.context.messages[6]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
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
    const prompt = built.context.systemPrompt ?? "";
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
    const prompt = built.context.systemPrompt ?? "";
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

it("默认系统提示词 CRLF checkout 归一为 LF", async () => {
  const read = vi
    .spyOn(fs.promises, "readFile")
    .mockResolvedValueOnce(Buffer.from("<agent>\r\nrule\r\n</agent>\r\n"));
  try {
    const built = await buildContext({
      records: [],
      currentPrompt: "hi",
      workspacePath: "unused",
      agentsMd: { path: "unused/AGENTS.md", present: false },
    });
    expect(built.context.systemPrompt).toBe("<agent>\nrule\n</agent>\n");
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
const START_COMPACTION = {
  trigger: "start" as const,
  retainedContextBudget: 0,
  tokenEstimate: ESTIMATE,
};
const TAIL_COMPACTION = {
  trigger: "continuation" as const,
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
      planCompaction([makeUserPromptRecord(1, "run-1", "first")], START_COMPACTION),
    ).toEqual({ status: "noop" });
  });

  it("触发点 (A) 覆盖当前 Prompt 之前的全部 eligible Turn", () => {
    const records = twoRunRecords();
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
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

  it("只有最新 Turn 时触发点 (B) 与手动压缩都返回 noop", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "only"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    expect(planCompaction(records, TAIL_COMPACTION)).toEqual({ status: "noop" });
    expect(planCompaction(records, { ...TAIL_COMPACTION, trigger: "manual" })).toEqual({ status: "noop" });
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
    // 当前 Run 的 prompt 与两个 Turn 都在预算内。
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

    // 预算充足时完整保留最新 Run，前一个 Run 进入摘要。
    const wholeRun = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 1000 }),
    );
    expect(wholeRun.coveredUpTo).toBe(5);
    expect(wholeRun.retainedMessages[0]).toMatchObject({ content: "second" });

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

  it("被排除的 Turn 不进入压缩输入；零 Turn Run 的 Prompt 与 unknown Turn 照常进入", () => {
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
    expect(plan.runs[1]?.turns[0]?.hasUnknown).toBe(true);

    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(selection.coveredUpTo).toBe(8);
    // run-1 零 Turn 但 Prompt 恒进上下文，落在覆盖范围内时同样进摘要输入，不被静默丢掉。
    expect(selection.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(selection.messages[0]).toMatchObject({ content: "first" });
    expect(selection.messages[1]).toMatchObject({ content: "second" });
    expect(selection.messages[4]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
    expect(selection.messages[5]).toMatchObject({ content: "third" });
  });

  it("stopReason=length 但工具结果齐全的 Turn 仍可压缩，调用与结果不被拆开", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }], { stopReason: "length" }),
      makeToolResultRecord(3, "run-1", "c1", "success"),
    ];
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
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
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(selection.coveredUpTo).toBe(2);
    expect(() => assertCandidateCheckpointValid(records, selection.coveredUpTo)).not.toThrow();
    expect(() => planEffectiveContext([...records, makeCheckpointRecord(3, "S", 2)])).not.toThrow();
  });

  it("跨多个 Run 时被覆盖 Run 的 Prompt 进入压缩输入且只出现一次", () => {
    const records = twoRunRecords();
    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 11 }),
    );
    expect(selection.coveredUpTo).toBe(5);
    const prompts = selection.messages.filter((message) => message.role === "user");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ content: "first" });
  });
});

describe("按 Run 压缩与回放", () => {
  it("手动压缩单个多 Turn Run 保留 prompt、最新 Turn 和后续失败请求", async () => {
    const records: SessionRecord[] = [
      ...twoRunRecords().slice(0, 5),
      makeUserPromptRecord(6, "run-2", "later"),
      makeRunFinishedRecord(7, "run-2", "failed"),
    ];
    const selected = expectSelection(planCompaction(records, {
      ...TAIL_COMPACTION, trigger: "manual", retainedContextBudget: 10_000,
    }));
    expect(selected.coveredUpTo).toBe(3);
    expect(selected.retainedMessages.map((message) => message.role)).toEqual([
      "user", "assistant", "toolResult", "user", "user",
    ]);
    const resumed = await buildContext({
      records: [...records, makeCheckpointRecord(8, "summary", selected.coveredUpTo)],
      workspacePath: makeWorkspace(),
    });
    expect(resumed.context.messages.slice(1)).toEqual(selected.retainedMessages);
    expect(resumed.context.messages[1]).toMatchObject({ content: "first" });
    expect(resumed.context.messages[4]).toMatchObject({ content: "later" });
  });

  it("首请求溢出时保留前一 Run 的 prompt、最新 Turn 和当前请求", () => {
    const records = [
      ...twoRunRecords().slice(0, 5),
      makeUserPromptRecord(6, "active", "next"),
    ];
    const selected = expectSelection(planCompaction(records, {
      ...TAIL_COMPACTION, trigger: "overflow", currentRunId: "active", retainedContextBudget: 0,
    }));
    expect(selected.coveredUpTo).toBe(3);
    expect(selected.retainedMessages).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      records[3]!.message,
      expect.objectContaining({ role: "toolResult", toolCallId: "c2" }),
      expect.objectContaining({ role: "user", content: "next" }),
    ]);
  });

  it("同一 Run 连续压缩只摘要新前缀，仍然保留原始 prompt", async () => {
    const records = [
      ...twoRunRecords().slice(0, 5),
      makeCheckpointRecord(6, "previous", 3),
      makeAssistantRecord(7, "run-1", []),
    ];
    const options = { ...TAIL_COMPACTION, currentRunId: "run-1" };
    const selected = expectSelection(planCompaction(records, options));
    expect(selected.previousSummary).toBe("previous");
    expect(selected.coveredUpTo).toBe(5);
    const workspacePath = makeWorkspace();
    const before = await buildContext({ records, workspacePath });
    expect(selected.messages).toEqual(before.context.messages.slice(1, -1));
    expect(selected.retainedMessages).toEqual([
      expect.objectContaining({ role: "user", content: "first" }),
      records[6]!.message,
    ]);
    const resumed = await buildContext({
      records: [...records, makeCheckpointRecord(8, "updated", 5)], workspacePath,
    });
    expect(resumed.context.messages.slice(1)).toEqual(selected.retainedMessages);
  });

  it("A 覆盖已结束的零 Turn Run，重建后当前请求保留中断前缀", () => {
    const records = [
      makeUserPromptRecord(1, "cancelled", "before"),
      makeRunFinishedRecord(2, "cancelled", "cancelled"),
      makeUserPromptRecord(3, "active", "after"),
    ];
    const selected = expectSelection(planCompaction(records, {
      ...START_COMPACTION, currentRunId: "active",
    }));
    expect(selected.coveredUpTo).toBe(2);
    expect(selected.messages).toHaveLength(1);
    expect(selected.retainedMessages).toEqual([
      expect.objectContaining({ content: PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "after" }),
    ]);
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

  it("触发点 (A) 压缩后从含 Prompt 的记录重建，Prompt 只出现一次", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeUserPromptRecord(4, "run-2", "now"),
    ];
    const selection = expectSelection(planCompaction(records, { ...START_COMPACTION, currentRunId: "run-2" }));
    expect(selection.coveredUpTo).toBe(3);
    records.push(makeCheckpointRecord(5, "S", 3));

    // Prompt 恒进上下文：重建不传 currentPrompt（传入会重复，调用方契约见 BuildContextInput）。
    const rebuilt = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(
      rebuilt.context.messages.filter(
        (message) => message.role === "user" && message.content === "now",
      ),
    ).toHaveLength(1);
    expect(rebuilt.context.messages.map((message) => message.role)).toEqual(["user", "user"]);
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
    return expectSelection(planCompaction(records, START_COMPACTION)).messages;
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

describe("取消/中断 Turn 的上下文资格与标注", () => {
  it("仅文本的 aborted Turn 进入上下文并附中断标注", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.turns).toHaveLength(1);
    expect(plan.runs[0]?.promptIncluded).toBe(true);

    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(built.context.messages[2]).toMatchObject({
      role: "user",
      content: INTERRUPTED_RESPONSE_ANNOTATION,
    });
    expect(() => prepareReplay(built.context)).not.toThrow();
  });

  it("aborted Turn 的可配对 call 带 not_executed 结果进入上下文", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }], { stopReason: "aborted" }),
      makeToolResultRecord(3, "run-1", "c1", "not_executed"),
      makeRunFinishedRecord(4, "run-1", "cancelled"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(built.context.messages[2]).toMatchObject({ toolCallId: "c1", isError: true });
    expect(() => prepareReplay(built.context)).not.toThrow();
  });

  it("aborted Turn 的半截 call 在上下文被剥离，History 原文不变", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "", name: "read" }], {
        text: "half",
        stopReason: "aborted",
      }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    const assistant = built.context.messages[1];
    expect(assistant?.role === "assistant" && assistant.content.some((b) => b.type === "toolCall")).toBe(
      false,
    );
    expect(() => prepareReplay(built.context)).not.toThrow();
    // History 原文保留半截 call。
    const original = records[1];
    expect(
      original?.type === "assistant_message" &&
        original.message.content.some((b) => b.type === "toolCall"),
    ).toBe(true);
  });

  it("旧记录的 aborted thinking 构建上下文时剥离，History 原文不变", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const record = records[1]!;
    if (record.type === "assistant_message")
      record.message.content.unshift({ type: "thinking", thinking: "LEGACY_DRAFT" });
    const snapshot = JSON.stringify(records);
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(built.context.messages)).not.toContain("LEGACY_DRAFT");
    expect(JSON.stringify(records)).toBe(snapshot);
    expect(() => prepareReplay(built.context)).not.toThrow();
  });

  it("完成 Turn 的 thinking 保留进上下文（对照）", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { text: "done" }),
      makeRunFinishedRecord(3, "run-1", "completed"),
    ];
    const record = records[1]!;
    if (record.type === "assistant_message")
      record.message.content.unshift({ type: "thinking", thinking: "KEEP_DRAFT" });
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(JSON.stringify(built.context.messages)).toContain("KEEP_DRAFT");
  });

  it("aborted thinking 不计入上下文估算", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const withDraft = structuredClone(records);
    const record = withDraft[1]!;
    if (record.type === "assistant_message")
      record.message.content.unshift({ type: "thinking", thinking: "x".repeat(10_000) });
    const base = await buildContext({ records, workspacePath: makeWorkspace() });
    const inflated = await buildContext({ records: withDraft, workspacePath: makeWorkspace() });
    expect(estimateContextTokens(inflated.context, ESTIMATE)).toBe(
      estimateContextTokens(base.context, ESTIMATE),
    );
  });

  it("压缩摘要输入不含 aborted thinking（与正式请求同构）", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const record = records[1]!;
    if (record.type === "assistant_message")
      record.message.content.unshift({ type: "thinking", thinking: "SUMMARY_DRAFT" });
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(selection.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(JSON.stringify(selection.messages)).not.toContain("SUMMARY_DRAFT");
  });

  it("零 Turn 的取消 Run：Prompt 裸进上下文，无标注", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.turns).toEqual([]);
    expect(plan.runs[0]?.cancelled).toBe(true);
    expect(plan.runs[0]?.promptIncluded).toBe(true);

    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user"]);
    expect(built.context.messages[0]).toMatchObject({ content: "q" });
  });

  it("零 Turn 的失败 Run：Prompt 恒进上下文并附失败标注", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [], { stopReason: "error" }),
      makeRunFinishedRecord(3, "run-1", "failed"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.promptIncluded).toBe(true);
    expect(plan.runs[0]?.failed).toBe(true);
    expect(plan.runs[0]?.excludedTurns.map((turn) => turn.reason)).toEqual(["incomplete_response"]);
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(built.context.messages[0]).toMatchObject({ content: "q" });
    expect(built.context.messages[1]).toMatchObject({ content: FAILED_REQUEST_ANNOTATION });
  });

  it("零 Turn 的失败 Run（无任何响应记录）：Prompt 恒进并附失败标注", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeRunFinishedRecord(2, "run-1", "failed"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[0]?.promptIncluded).toBe(true);
    expect(plan.runs[0]?.failed).toBe(true);
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(built.context.messages[1]).toMatchObject({ content: FAILED_REQUEST_ANNOTATION });
  });

  it("aborted Turn 缺结果：中断标注与未知标注同时注入，占位不替换真实结果", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "bash" }], {
        text: "half",
        stopReason: "aborted",
      }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "user",
    ]);
    expect(built.context.messages[2]).toMatchObject({
      toolCallId: "c1",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(built.context.messages[3]).toMatchObject({ content: INTERRUPTED_RESPONSE_ANNOTATION });
    expect(built.context.messages[4]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
    expect(() => prepareReplay(built.context)).not.toThrow();
  });

  it("纯缺结果 Turn 可作压缩边界，占位与询问标注进入压缩输入", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "bash" }]),
      makeToolResultRecord(3, "run-1", "c1", "success", { toolName: "bash" }),
      makeUserPromptRecord(4, "run-2", "second"),
      makeAssistantRecord(5, "run-2", [{ id: "c2", name: "bash" }]),
      // 崩溃窗口：c2 无结果记录。
    ];
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(selection.coveredUpTo).toBe(5);
    expect(() => assertCandidateCheckpointValid(records, 5)).not.toThrow();
    expect(() => planEffectiveContext([...records, makeCheckpointRecord(6, "S", 5)])).not.toThrow();
    expect(selection.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "user",
    ]);
    expect(selection.messages[5]).toMatchObject({
      toolCallId: "c2",
      isError: true,
      content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(selection.messages[6]).toMatchObject({ content: UNKNOWN_RESULT_ANNOTATION });
  });

  it("planCompaction 覆盖 aborted Turn 时携带中断标注", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeAssistantRecord(4, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(5, "run-1", "cancelled"),
    ];
    const selection = planCompaction(records, {
      trigger: "start" as const,
      retainedContextBudget: 0,
      tokenEstimate: { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1 },
    });
    expect("messages" in selection).toBe(true);
    if (!("messages" in selection)) return;
    expect(
      selection.messages.some(
        (m) => m.role === "user" && m.content === INTERRUPTED_RESPONSE_ANNOTATION,
      ),
    ).toBe(true);
  });
});

describe("零 Turn 取消后的渲染期中断前缀", () => {
  it("下一条 Prompt 前置前缀，取消 Run 的 Prompt 裸进上下文（重建路径）", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "cancelled task"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
      makeUserPromptRecord(3, "run-2", "new task"),
    ];
    const plan = planEffectiveContext(records);
    expect(plan.runs[1]?.followsCancelledZeroTurn).toBe(true);
    expect(plan.runs[0]?.followsCancelledZeroTurn).toBe(false);
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(built.context.messages[0]).toMatchObject({ content: "cancelled task" });
    expect(built.context.messages[1]).toMatchObject({
      content: PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "new task",
    });
    // 前缀不落盘：记录恒存原文。
    expect(records[2]).toMatchObject({ text: "new task" });
  });

  it("prior + currentPrompt 路径与记录重建路径逐字一致（锚定同一性护栏）", async () => {
    const prior: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "cancelled task"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
    ];
    const rebuilt = await buildContext({
      records: [...prior, makeUserPromptRecord(3, "run-2", "new task")],
      workspacePath: makeWorkspace(),
    });
    const sent = await buildContext({
      records: prior,
      currentPrompt: "new task",
      workspacePath: makeWorkspace(),
      now: () => new Date(RECORD_TS),
    });
    expect(sent.context.messages).toEqual(rebuilt.context.messages);
    expect(sent.context.messages.at(-1)).toMatchObject({
      content: PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "new task",
    });
  });

  it("取消后无下一条 Prompt：正式请求与压缩输入全文无前缀", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeRunFinishedRecord(4, "run-1", "completed"),
      makeUserPromptRecord(5, "run-2", "dangling"),
      makeRunFinishedRecord(6, "run-2", "cancelled"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(JSON.stringify(built.context.messages)).not.toContain(
      PREVIOUS_REQUEST_INTERRUPTED_PREFIX,
    );
    expect(built.context.messages.at(-1)).toMatchObject({ content: "dangling" });
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(JSON.stringify(selection.messages)).not.toContain(PREVIOUS_REQUEST_INTERRUPTED_PREFIX);
  });

  it("半截文本取消（aborted Turn）不触发前缀，中断标注照旧（作用域 A 护栏）", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeAssistantRecord(2, "run-1", [], { text: "half", stopReason: "aborted" }),
      makeRunFinishedRecord(3, "run-1", "cancelled"),
      makeUserPromptRecord(4, "run-2", "second"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.at(-1)).toMatchObject({ content: "second" });
    expect(
      built.context.messages.some((m) => m.content === INTERRUPTED_RESPONSE_ANNOTATION),
    ).toBe(true);
    expect(JSON.stringify(built.context.messages)).not.toContain(
      PREVIOUS_REQUEST_INTERRUPTED_PREFIX,
    );
  });

  it("零 Turn 失败 Run 附失败标注，下一条 Prompt 无前缀", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "first"),
      makeRunFinishedRecord(2, "run-1", "failed"),
      makeUserPromptRecord(3, "run-2", "second"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(built.context.messages[1]).toMatchObject({ content: FAILED_REQUEST_ANNOTATION });
    expect(built.context.messages[2]).toMatchObject({ content: "second" });
    expect(JSON.stringify(built.context.messages)).not.toContain(
      PREVIOUS_REQUEST_INTERRUPTED_PREFIX,
    );
  });

  it("连续两次零 Turn 取消：后续 Prompt 各带一个前缀，首条裸", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "p1"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
      makeUserPromptRecord(3, "run-2", "p2"),
      makeRunFinishedRecord(4, "run-2", "cancelled"),
      makeUserPromptRecord(5, "run-3", "p3"),
    ];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages.map((m) => m.content)).toEqual([
      "p1",
      PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "p2",
      PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "p3",
    ]);
  });

  it("planCompaction：被覆盖的带前缀 Prompt 进摘要输入且前缀计入保留预算", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "cancelled task"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
      makeUserPromptRecord(3, "run-2", "new task"),
      makeAssistantRecord(4, "run-2", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(5, "run-2", "c1", "success"),
      makeAssistantRecord(6, "run-2", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(7, "run-2", "c2", "success"),
    ];
    // 每 Turn 估算 3、Prompt "new task" 2：预算 8 恰好在不计前缀时能保留两个 Turn；
    // 前缀计入后第一个 Turn 被覆盖，其 Prompt（带前缀）进摘要输入。
    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 8 }),
    );
    expect(selection.coveredUpTo).toBe(5);
    expect(selection.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
      "assistant",
      "toolResult",
    ]);
    // 被覆盖的裸取消 Prompt 无标注进摘要输入。
    expect(selection.messages[0]).toMatchObject({ content: "cancelled task" });
    expect(selection.messages[1]).toMatchObject({
      content: PREVIOUS_REQUEST_INTERRUPTED_PREFIX + "new task",
    });
  });
});

describe("measuredPromptTokens", () => {
  const usage = (overrides: Partial<Usage> = {}): Usage => ({
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  });
  it("sums input + cacheRead + cacheWrite (input excludes cache hits)", () => {
    expect(measuredPromptTokens(usage({ input: 500, cacheRead: 12000, cacheWrite: 300 }))).toBe(12800);
  });
  it("rejects undefined and the all-zero uncounted placeholder", () => {
    expect(measuredPromptTokens(undefined)).toBeNull();
    expect(
      measuredPromptTokens(usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })),
    ).toBeNull();
  });
  it("accepts cache-only measurements", () => {
    expect(measuredPromptTokens(usage({ input: 0, cacheRead: 9000 }))).toBe(9000);
  });
  it("rejects negative or non-finite fields", () => {
    expect(measuredPromptTokens(usage({ input: -1 }))).toBeNull();
    expect(measuredPromptTokens(usage({ cacheRead: Number.NaN }))).toBeNull();
    expect(measuredPromptTokens(usage({ cacheWrite: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(measuredPromptTokens({ ...usage(), input: undefined as unknown as number })).toBeNull();
  });
});

describe("image 双模态（view_image）", () => {
  const TOKEN_OPTS = { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5 };
  const image = makePngImage(1920, 1080); // ceil(1920*1080/750) = 2765 tokens
  const imageRecords: SessionRecord[] = [
    makeUserPromptRecord(1, "run-1", "look"),
    makeAssistantRecord(2, "run-1", [{ id: "c1", name: "view_image", arguments: { path: "a.png" } }]),
    makeToolResultRecord(3, "run-1", "c1", "success", {
      toolName: "view_image",
      content: "(Image attached: image/png, 1920x1080, 44 bytes.)",
      images: [image],
    }),
  ];
  const imageResult = imageRecords[2] as ToolResultRecord;

  it("toolResultMessage 双模态块形态；image 块字段序固定 {type,data,mimeType}", () => {
    const vision = toolResultMessage(imageResult, true);
    expect(vision.content).toEqual([
      { type: "text", text: imageResult.content },
      { type: "image", data: image.data, mimeType: "image/png" },
    ]);
    expect(Object.keys(vision.content[1]!)).toEqual(["type", "data", "mimeType"]);
    const text = toolResultMessage(imageResult, false);
    expect(text.content).toEqual([
      { type: "text", text: imageResult.content },
      { type: "text", text: IMAGE_OMITTED_TEXT },
    ]);
    // 无 images 的记录两种模式同构
    const plain = makeToolResultRecord(3, "run-1", "c1", "success");
    expect(toolResultMessage(plain, true)).toEqual(toolResultMessage(plain, false));
  });

  it("estimateMessageTokens：image 按宽高公式计费；非视觉计占位文本而非 image", () => {
    const textTokens = estimateTokens(imageResult.content, TOKEN_OPTS);
    expect(estimateMessageTokens(toolResultMessage(imageResult, true), TOKEN_OPTS)).toBe(
      textTokens + 2765,
    );
    expect(estimateMessageTokens(toolResultMessage(imageResult, false), TOKEN_OPTS)).toBe(
      textTokens + estimateTokens(IMAGE_OMITTED_TEXT, TOKEN_OPTS),
    );
    // 头部解析失败回退 4096
    const broken = { ...imageResult, images: [{ ...image, data: "AAAA" }] };
    expect(estimateMessageTokens(toolResultMessage(broken, true), TOKEN_OPTS)).toBe(textTokens + 4096);
  });

  it("buildContext 双模态：默认带 image 块；imageInput=false 全上下文无 image 块且含占位", async () => {
    const workspacePath = makeWorkspace();
    const vision = await buildContext({ records: imageRecords, workspacePath });
    const rebuilt = vision.context.messages[2];
    expect(rebuilt).toMatchObject({ role: "toolResult" });
    expect(JSON.stringify(vision.context)).toContain('"type":"image"');
    const text = await buildContext({ records: imageRecords, workspacePath, imageInput: false });
    expect(JSON.stringify(text.context)).not.toContain('"type":"image"');
    expect(JSON.stringify(text.context)).toContain(IMAGE_OMITTED_TEXT);
    // turnMessages 与 buildContext 同构
    const turn = vision.plan.runs[0]!.turns[0]!;
    expect(turnMessages(turn, true)).toEqual(vision.context.messages.slice(1));
    expect(turnMessages(turn, false)).toEqual(text.context.messages.slice(1));
  });

  it("planCompaction 双模态同构：摘要输入与正式请求按同一能力渲染", () => {
    const options = {
      trigger: "start" as const,
      retainedContextBudget: 0,
      tokenEstimate: TOKEN_OPTS,
    };
    const vision = planCompaction(imageRecords, { ...options, imageInput: true });
    const text = planCompaction(imageRecords, { ...options, imageInput: false });
    if (!("messages" in vision) || !("messages" in text)) throw new Error("expected selection");
    expect(JSON.stringify(vision.messages)).toContain('"type":"image"');
    expect(JSON.stringify(text.messages)).not.toContain('"type":"image"');
    expect(JSON.stringify(text.messages)).toContain(IMAGE_OMITTED_TEXT);
    expect(vision.coveredUpTo).toBe(text.coveredUpTo);
  });

  it("保留预算按能力同构计费：image token 使尾部少保留 Turn", () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "view_image" }]),
      makeToolResultRecord(5, "run-1", "c2", "success", { toolName: "view_image", images: [image] }),
    ];
    const options = { trigger: "continuation" as const, retainedContextBudget: 200, tokenEstimate: TOKEN_OPTS };
    const vision = planCompaction(records, { ...options, imageInput: true });
    // 最新 Turn 含 2765 image tokens，超出 200 预算 → 只保留最新 Turn，前一 Turn 被覆盖。
    if (!("messages" in vision)) throw new Error("expected selection");
    expect(vision.coveredUpTo).toBe(3);
    // 非视觉渲染下两个 Turn 都是小文本 → 全部保留 → noop。
    expect(planCompaction(records, { ...options, imageInput: false })).toEqual({ status: "noop" });
  });

  it("trimCompactionMessages：base 未超预算保留图；阶梯每档丢图换占位后收敛", () => {
    const turn = planEffectiveContext(imageRecords).runs[0]!.turns[0]!;
    const messages = turnMessages(turn, true);
    const textOnlyTokens = estimateContextTokens(
      { messages: turnMessages(turn, false) },
      TOKEN_OPTS,
    );
    const base = trimCompactionMessages(messages, {
      tokenEstimate: TOKEN_OPTS,
      toolResultMaxChars: 4000,
      maxTokens: 100_000,
    });
    if (base.status !== "ok") throw new Error("expected ok");
    expect(base.toolResultLimit).toBeNull();
    expect(JSON.stringify(base.messages)).toContain('"type":"image"');
    const trimmed = trimCompactionMessages(messages, {
      tokenEstimate: TOKEN_OPTS,
      toolResultMaxChars: 4000,
      maxTokens: textOnlyTokens + 100,
    });
    if (trimmed.status !== "ok") throw new Error("expected ok");
    expect(trimmed.toolResultLimit).toBe(4000); // factor 1 档即丢图收敛
    expect(JSON.stringify(trimmed.messages)).not.toContain('"type":"image"');
    expect(JSON.stringify(trimmed.messages)).toContain(IMAGE_COMPACTION_OMITTED_TEXT);
    expect(
      trimCompactionMessages(messages, {
        tokenEstimate: TOKEN_OPTS,
        toolResultMaxChars: 4000,
        maxTokens: 1,
      }),
    ).toEqual({ status: "too_large" });
  });
});

describe("skill 显式调用渲染同构", () => {
  const skill: SkillSnapshot = {
    name: "review",
    location: "/skills/review/SKILL.md",
    content: "# Review\n\ncheck the diff",
  };
  const skillPrompt = (seq: number, runId: string, text: string): UserPromptRecord => ({
    ...makeUserPromptRecord(seq, runId, text),
    skill,
  });

  it("重建路径：快照展开为权威格式，记录恒存完整原文", async () => {
    const records = [skillPrompt(1, "run-1", "/skill:review fix the bug")];
    const built = await buildContext({ records, workspacePath: makeWorkspace() });
    expect(built.context.messages[0]).toMatchObject({
      content: renderSkillMessage(skill, "fix the bug"),
    });
    expect(records[0]!.text).toBe("/skill:review fix the bug");
  });

  it("prior + currentPrompt/currentSkill 与记录重建逐字一致（锚定同一性护栏）", async () => {
    const rebuilt = await buildContext({
      records: [skillPrompt(1, "run-1", "/skill:review fix the bug")],
      workspacePath: makeWorkspace(),
    });
    const sent = await buildContext({
      records: [],
      currentPrompt: "/skill:review fix the bug",
      currentSkill: skill,
      workspacePath: makeWorkspace(),
      now: () => new Date(RECORD_TS),
    });
    expect(sent.context.messages).toEqual(rebuilt.context.messages);
  });

  it("空请求：消息以 </skill> 结束，双路径一致", async () => {
    const rebuilt = await buildContext({
      records: [skillPrompt(1, "run-1", "/skill:review")],
      workspacePath: makeWorkspace(),
    });
    const sent = await buildContext({
      records: [],
      currentPrompt: "/skill:review",
      currentSkill: skill,
      workspacePath: makeWorkspace(),
      now: () => new Date(RECORD_TS),
    });
    expect(sent.context.messages).toEqual(rebuilt.context.messages);
    expect((sent.context.messages[0] as { content: string }).content.endsWith("</skill>")).toBe(true);
  });

  it("零 Turn 取消叠加：前缀在最前，skill 块与请求相邻，双路径一致", async () => {
    const prior: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "cancelled task"),
      makeRunFinishedRecord(2, "run-1", "cancelled"),
    ];
    const expected = PREVIOUS_REQUEST_INTERRUPTED_PREFIX + renderSkillMessage(skill, "fix the bug");
    const rebuilt = await buildContext({
      records: [...prior, skillPrompt(3, "run-2", "/skill:review fix the bug")],
      workspacePath: makeWorkspace(),
    });
    const sent = await buildContext({
      records: prior,
      currentPrompt: "/skill:review fix the bug",
      currentSkill: skill,
      workspacePath: makeWorkspace(),
      now: () => new Date(RECORD_TS),
    });
    expect(sent.context.messages).toEqual(rebuilt.context.messages);
    expect(rebuilt.context.messages.at(-1)).toMatchObject({ content: expected });
  });

  it("planCompaction 摘要输入与重建同源展开", () => {
    const records: SessionRecord[] = [
      skillPrompt(1, "run-1", "/skill:review first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeUserPromptRecord(4, "run-2", "second"),
      makeAssistantRecord(5, "run-2", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(6, "run-2", "c2", "success"),
    ];
    const selection = expectSelection(planCompaction(records, START_COMPACTION));
    expect(selection.messages[0]).toMatchObject({
      content: renderSkillMessage(skill, "first"),
    });
  });

  it("保留预算按展开全文计费：裸命令文本能保留的预算，展开后保留不下", () => {
    const records: SessionRecord[] = [
      skillPrompt(1, "run-1", "/skill:review first"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }]),
      makeToolResultRecord(3, "run-1", "c1", "success"),
      makeAssistantRecord(4, "run-1", [{ id: "c2", name: "read" }]),
      makeToolResultRecord(5, "run-1", "c2", "success"),
    ];
    const selection = expectSelection(
      planCompaction(records, { ...TAIL_COMPACTION, retainedContextBudget: 19 }),
    );
    expect(selection.coveredUpTo).toBe(3);
    expect(selection.messages[0]).toMatchObject({
      content: renderSkillMessage(skill, "first"),
    });
    // 反证：同一预算按裸 text（无快照）估算会保留全部 Turn。
    const raw: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "/skill:review first"),
      ...records.slice(1),
    ];
    expect(planCompaction(raw, { ...TAIL_COMPACTION, retainedContextBudget: 19 })).toEqual({
      status: "noop",
    });
  });

  it("无快照的普通 Prompt 渲染不受影响", async () => {
    const built = await buildContext({
      records: [makeUserPromptRecord(1, "run-1", "/skill:review 不是调用（无快照）")],
      workspacePath: makeWorkspace(),
    });
    expect(built.context.messages[0]).toMatchObject({
      content: "/skill:review 不是调用（无快照）",
    });
  });
});
