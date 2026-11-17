import { describe, expect, it } from "vitest";
import { RUN_OUTCOMES } from "../../src/core/state.js";
import {
  DEFINITE_TOOL_RESULT_STATUSES,
  isTurnContextComplete,
  normalizeAbortedMessage,
  parseSessionRecord,
  parseSessionMeta,
  RecordValidationError,
  SESSION_RECORD_TYPES,
  SESSION_RUN_OUTCOMES,
  TOOL_RESULT_STATUSES,
  type AssistantMessageRecord,
  type ToolResultRecord,
} from "../../src/sessions/records.js";
import { makeAssistantMessage } from "./helpers.js";

const TS = "2026-10-27T10:00:00.000Z";

function assistant(
  toolCalls: Array<{ id: string; name: string }> = [{ id: "c1", name: "read" }],
  seq = 2,
): AssistantMessageRecord {
  return {
    recordSeq: seq,
    ts: TS,
    type: "assistant_message",
    runId: "run-1",
    message: makeAssistantMessage(toolCalls),
  };
}

function toolResult(
  status: ToolResultRecord["status"],
  toolCallId = "c1",
  runId = "run-1",
  seq = 3,
): ToolResultRecord {
  return {
    recordSeq: seq,
    ts: TS,
    type: "tool_result",
    assistantRecordSeq: 2,
    runId,
    toolCallId,
    toolName: "read",
    status,
    content: "ok",
  };
}

describe("V1 记录枚举与 Schema 校验", () => {
  it("记录类型、tool_result 状态、run_finished 结果枚举一致", () => {
    expect([...SESSION_RECORD_TYPES]).toEqual([
      "user_prompt",
      "run_started",
      "assistant_message",
      "tool_result",
      "interruption",
      "run_finished",
      "checkpoint",
    ]);
    expect([...TOOL_RESULT_STATUSES]).toEqual([
      "success",
      "error",
      "denied",
      "timeout",
      "not_executed",
      "unknown",
    ]);
    expect([...DEFINITE_TOOL_RESULT_STATUSES]).toEqual([
      "success",
      "error",
      "denied",
      "timeout",
      "not_executed",
    ]);
    // T2 Controller 的 RunOutcome 与本记录枚举必须保持同一集合
    expect([...SESSION_RUN_OUTCOMES]).toEqual([...RUN_OUTCOMES]);
  });

  it("合法记录通过校验；首条记录必须且仅允许首条携带 version", () => {
    const prompt = { recordSeq: 1, ts: TS, type: "user_prompt", runId: "run-1", text: "hi" };
    expect(parseSessionRecord(prompt, { expectVersion: false }).type).toBe("user_prompt");
    expect(parseSessionRecord({ ...prompt, version: 2 }, { expectVersion: true }).recordSeq).toBe(1);
    expect(() => parseSessionRecord(prompt, { expectVersion: true })).toThrow(/缺少 "version"/);
    expect(() =>
      parseSessionRecord({ ...prompt, recordSeq: 2, version: 2 }, { expectVersion: false }),
    ).toThrow(/仅首条记录允许/);
  });

  it("非法 type / status / outcome / 未知字段被拒绝", () => {
    expect(() =>
      parseSessionRecord({ recordSeq: 1, ts: TS, type: "bogus", version: 2 }, { expectVersion: true }),
    ).toThrow(RecordValidationError);
    expect(() =>
      parseSessionRecord(
        {
          recordSeq: 2,
          ts: TS,
          type: "tool_result",
          assistantRecordSeq: 1,
          runId: "run-1",
          toolCallId: "c1",
          toolName: "read",
          status: "ok",
          content: "",
        },
        { expectVersion: false },
      ),
    ).toThrow(/"status"/);
    expect(() =>
      parseSessionRecord(
        {
          recordSeq: 2,
          ts: TS,
          type: "run_finished",
          runId: "run-1",
          outcome: "done",
          persisted: true,
        },
        { expectVersion: false },
      ),
    ).toThrow(/"outcome"/);
    expect(() =>
      parseSessionRecord(
        { recordSeq: 2, ts: TS, type: "user_prompt", text: "hi", extra: 1 },
        { expectVersion: false },
      ),
    ).toThrow(/未知字段/);
  });

  it("tool_result 可选 priorContent：全量快照字符串校验（V12）", () => {
    const base = {
      recordSeq: 2,
      ts: TS,
      type: "tool_result",
      assistantRecordSeq: 1,
      runId: "run-1",
      toolCallId: "c1",
      toolName: "write",
      status: "success",
      content: "new body",
    };
    const parsed = parseSessionRecord(
      { ...base, priorContent: "old body\nfull snapshot" },
      { expectVersion: false },
    );
    expect(parsed.type).toBe("tool_result");
    if (parsed.type === "tool_result") {
      expect(parsed.priorContent).toBe("old body\nfull snapshot");
      expect(parsed.content).toBe("new body");
    }
    expect(() => parseSessionRecord({ ...base, priorContent: 42 }, { expectVersion: false })).toThrow(
      /"priorContent"/,
    );
    // 新建文件的空快照必须合法，否则成功写入的 Session 会被误判损坏。
    const created = parseSessionRecord({ ...base, priorContent: "" }, { expectVersion: false });
    if (created.type === "tool_result") expect(created.priorContent).toBe("");
  });
});

describe("V8 Turn 上下文完整判据", () => {
  it.each(DEFINITE_TOOL_RESULT_STATUSES)("确定状态 %s 判定完整", (status) => {
    expect(isTurnContextComplete(assistant(), [toolResult(status)])).toBe(true);
  });

  it("配对 unknown 结果受控完整（进上下文 + 询问标注，门控另行保留）", () => {
    expect(isTurnContextComplete(assistant(), [toolResult("unknown")])).toBe(true);
  });

  it("缺结果受控完整（崩溃窗口，构建上下文时合成 unknown 占位）", () => {
    expect(isTurnContextComplete(assistant(), [])).toBe(true);
    expect(
      isTurnContextComplete(
        assistant([
          { id: "c1", name: "read" },
          { id: "c2", name: "write" },
        ]),
        [toolResult("success", "c1")],
      ),
    ).toBe(true);
  });

  it("不同 runId 的同名 toolCallId 属错配，判定不完整", () => {
    expect(isTurnContextComplete(assistant(), [toolResult("success", "c1", "run-2")])).toBe(false);
  });

  it("多余结果（引用不存在的 call）属协议损坏，判定不完整", () => {
    expect(isTurnContextComplete(assistant(), [toolResult("success", "ghost")])).toBe(false);
  });

  it("interruption 不是 tool_result，不参与判定", () => {
    const interruption = {
      recordSeq: 3,
      ts: TS,
      type: "interruption" as const,
      runId: "run-1",
      toolCallId: "c1",
      reason: "unknown side effect",
    };
    expect(interruption.type).toBe("interruption");
    expect(isTurnContextComplete(assistant(), [])).toBe(true);
    expect(isTurnContextComplete(assistant(), [toolResult("denied")])).toBe(true);
  });

  it("无工具调用的 assistant 消息判定完整", () => {
    expect(isTurnContextComplete(assistant([]), [])).toBe(true);
  });
});

describe("aborted Turn 完整判据与归一化", () => {
  function aborted(
    toolCalls: Array<{ id: string; name: string }>,
    text = "half",
  ): AssistantMessageRecord {
    return {
      recordSeq: 2,
      ts: TS,
      type: "assistant_message",
      runId: "run-1",
      message: makeAssistantMessage(toolCalls, text, { stopReason: "aborted" }),
    };
  }

  it("仅文本的 aborted 响应判定完整", () => {
    expect(isTurnContextComplete(aborted([]), [])).toBe(true);
  });

  it("可配对 call 带确定结果判定完整", () => {
    expect(
      isTurnContextComplete(aborted([{ id: "c1", name: "read" }]), [toolResult("not_executed")]),
    ).toBe(true);
  });

  it("可配对 call 缺结果受控完整（崩溃窗口，合成 unknown 占位；门控仍列出缺结果）", () => {
    expect(isTurnContextComplete(aborted([{ id: "c1", name: "read" }]), [])).toBe(true);
  });

  it("半截 call（空 id）被剥离后不影响完整性", () => {
    const record = aborted([{ id: "", name: "read" }]);
    expect(isTurnContextComplete(record, [])).toBe(true);
    const normalized = normalizeAbortedMessage(record.message);
    expect(normalized.content.some((block) => block.type === "toolCall")).toBe(false);
    expect(normalized.content.some((block) => block.type === "text")).toBe(true);
  });

  it("重复 id 的 call 仅保留首个", () => {
    const record = aborted([
      { id: "c1", name: "read" },
      { id: "c1", name: "write" },
    ]);
    const normalized = normalizeAbortedMessage(record.message);
    const calls = normalized.content.filter((block) => block.type === "toolCall");
    expect(calls).toHaveLength(1);
    expect(isTurnContextComplete(record, [toolResult("not_executed", "c1")])).toBe(true);
  });

  it("normalizeAbortedMessage 不改非 aborted 消息", () => {
    const message = makeAssistantMessage([{ id: "c1", name: "read" }]);
    expect(normalizeAbortedMessage(message)).toBe(message);
  });
});

it("accepts optional v2 elapsedMs and rejects invalid audit durations", () => {
  const record = {
    type: "run_finished",
    recordSeq: 1,
    ts: TS,
    version: 2,
    runId: "r",
    outcome: "completed",
    persisted: true,
  };
  expect(parseSessionRecord(record, { expectVersion: true })).toEqual(record);
  for (const elapsedMs of [0, 62234, Number.MAX_SAFE_INTEGER])
    expect(parseSessionRecord({ ...record, elapsedMs }, { expectVersion: true })).toMatchObject({
      elapsedMs,
    });
  for (const elapsedMs of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => parseSessionRecord({ ...record, elapsedMs }, { expectVersion: true })).toThrow(
      RecordValidationError,
    );
});

describe("autoDecisionEnabled metadata", () => {
  const meta = { version: 2, sessionId: "s1", workspaceId: "ws", createdAt: TS };
  it("preserves absence and accepts both booleans", () => {
    expect(parseSessionMeta(meta)).not.toHaveProperty("autoDecisionEnabled");
    for (const enabled of [true, false]) {
      expect(parseSessionMeta({ ...meta, autoDecisionEnabled: enabled }).autoDecisionEnabled).toBe(enabled);
    }
  });
  it.each([null, 0, 1, "true", {}, []])("rejects non-boolean %j", (value) => {
    expect(() => parseSessionMeta({ ...meta, autoDecisionEnabled: value })).toThrow(RecordValidationError);
  });
});
