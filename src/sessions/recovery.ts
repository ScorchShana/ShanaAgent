import {
  isTurnContextComplete,
  normalizeAbortedMessage,
  toolCallsOfMessage,
  type AssistantMessageRecord,
  type CheckpointRecord,
  type SessionMeta,
  type SessionRecord,
  type ToolResultRecord,
} from "./records.js";
import type { SessionLoadWarning, SessionRef, SessionStore } from "./session-store.js";

export class CheckpointInvalidError extends Error {
  readonly checkpoint: CheckpointRecord;

  constructor(checkpoint: CheckpointRecord, reason: string) {
    super(`检查点 #${checkpoint.recordSeq} 无效: ${reason}`);
    this.name = "CheckpointInvalidError";
    this.checkpoint = checkpoint;
  }
}

export interface UnknownSideEffect {
  runId: string;
  toolCallId: string;
  toolName: string;
  reason: "reported_unknown" | "missing_result";
}

export class UnknownSideEffectsError extends Error {
  readonly unknownResults: readonly UnknownSideEffect[];

  constructor(unknownResults: readonly UnknownSideEffect[]) {
    super(`有 ${unknownResults.length} 个工具结果未知，需用户知情确认后才能开始新 Run`);
    this.name = "UnknownSideEffectsError";
    this.unknownResults = unknownResults;
  }
}

function isToolResult(record: SessionRecord): record is ToolResultRecord {
  return record.type === "tool_result";
}

function isAssistant(record: SessionRecord): record is AssistantMessageRecord {
  return record.type === "assistant_message";
}

export type ResponseExclusionReason = "truncated" | "incomplete_response";

export function responseExclusionReason(assistant: AssistantMessageRecord): ResponseExclusionReason | null {
  if (assistant.message.stopReason === "length" && toolCallsOfMessage(assistant.message).length === 0)
    return "truncated";
  // 零 call 的 aborted 轮没有可回放内容：pi-ai 会整条丢弃它，上下文里只剩孤立的中断标注。按 truncated
  // 排除后取消 Run 归为"无可回放 Turn"，中断信号由下一条 Prompt 的渲染期前缀承载（§6）。
  if (
    assistant.message.stopReason === "aborted" &&
    toolCallsOfMessage(normalizeAbortedMessage(assistant.message)).length === 0
  ) {
    return "truncated";
  }
  if (
    assistant.message.stopReason !== "toolUse" &&
    assistant.message.stopReason !== "stop" &&
    assistant.message.stopReason !== "length" &&
    assistant.message.stopReason !== "aborted"
  ) {
    return "incomplete_response";
  }
  return null;
}

export function findUnknownSideEffects(records: readonly SessionRecord[]): UnknownSideEffect[] {
  const results = records.filter(isToolResult);
  const unknown: UnknownSideEffect[] = results
    .filter((result) => result.status === "unknown")
    .map((result) => ({
      runId: result.runId,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      reason: "reported_unknown",
    }));

  for (const assistant of records.filter(isAssistant)) {
    const stop = assistant.message.stopReason;
    if (stop !== "toolUse" && stop !== "stop" && stop !== "aborted") continue;
    // aborted 的可配对 call 均会合成 not_executed 结果；缺结果即崩溃窗口，需门控（不论 parse 是否完整）。
    const message = stop === "aborted" ? normalizeAbortedMessage(assistant.message) : assistant.message;
    const calls = toolCallsOfMessage(message);
    for (const call of calls) {
      if (!call.id || !call.name) continue;
      if (stop !== "aborted" && call.parse.status !== "parsed") continue;
      const hasResult = results.some(
        (result) =>
          result.assistantRecordSeq === assistant.recordSeq &&
          result.runId === assistant.runId &&
          result.toolCallId === call.id,
      );
      if (!hasResult) {
        unknown.push({
          runId: assistant.runId,
          toolCallId: call.id,
          toolName: call.name,
          reason: "missing_result",
        });
      }
    }
  }
  return unknown;
}

export function findLatestCheckpoint(records: readonly SessionRecord[]): CheckpointRecord | null {
  let latest: CheckpointRecord | null = null;
  for (const record of records) {
    if (record.type === "checkpoint" && (latest === null || record.recordSeq > latest.recordSeq)) {
      latest = record;
    }
  }
  if (latest !== null) assertCheckpointValid(records, latest);
  return latest;
}

// coveredUpTo 定位审计边界；摘要只使用有效上下文，允许跳过先前失败 Run。
function assertCheckpointValid(records: readonly SessionRecord[], checkpoint: CheckpointRecord): void {
  const coveredUpTo = checkpoint.coveredUpTo;
  if (coveredUpTo < 1) {
    throw new CheckpointInvalidError(checkpoint, `coveredUpTo=${coveredUpTo}，至少须覆盖一条记录`);
  }
  if (coveredUpTo >= checkpoint.recordSeq) {
    throw new CheckpointInvalidError(checkpoint, `coveredUpTo=${coveredUpTo} 不是检查点之前的记录`);
  }
  const boundary = records.find((record) => record.recordSeq === coveredUpTo);
  if (boundary === undefined) {
    throw new CheckpointInvalidError(checkpoint, `coveredUpTo=${coveredUpTo} 超出已有记录范围`);
  }

  const assistants = records.filter(
    (record): record is AssistantMessageRecord => isAssistant(record) && record.recordSeq <= coveredUpTo,
  );
  const toolResults = records.filter(
    (record): record is ToolResultRecord => isToolResult(record) && record.recordSeq <= coveredUpTo,
  );

  const eligible = new Set<number>();
  // 可回放 = 完整且未被排除，与 planEffectiveContext 同判据：run_finished 只有在其 Run 无可回放 Turn 时
  // 才是合法边界（planCompaction 对零 Turn 的 Run 会退到 run_finished）。可作审计边界与可回放是两件事——
  // 边界轮自身不可回放不影响它界定覆盖范围，故 tool_result / assistant_message 两个边界分支仍用 eligible，
  // 改动前写下的检查点（coveredUpTo 正落在被排除轮上）保持有效。
  const replayable = new Set<number>();
  let blocked = false;
  for (const record of records) {
    if (record.recordSeq > coveredUpTo) break;
    if (record.type === "user_prompt") blocked = false;
    if (record.type !== "assistant_message") continue;
    if (!isTurnContextComplete(record, toolResults)) blocked = true;
    if (blocked) continue;
    eligible.add(record.recordSeq);
    if (responseExclusionReason(record) === null) replayable.add(record.recordSeq);
  }

  if (boundary.type === "run_finished") {
    const prompt = records.findLast(
      (record) => record.type === "user_prompt" && record.recordSeq < coveredUpTo,
    );
    if (
      prompt?.type === "user_prompt" && prompt.runId === boundary.runId &&
      !assistants.some((record) => record.runId === boundary.runId && replayable.has(record.recordSeq)) &&
      !records.some((record) => record.recordSeq > coveredUpTo &&
        (record.type === "assistant_message" || record.type === "tool_result") && record.runId === boundary.runId)
    ) return;
    throw new CheckpointInvalidError(checkpoint, "边界必须属于已结束且无可回放 Turn 的 Run");
  }

  if (boundary.type === "tool_result") {
    const owner = assistants[assistants.length - 1];
    if (owner === undefined) {
      throw new CheckpointInvalidError(checkpoint, `边界 #${coveredUpTo} 不是 Turn 边界`);
    }
    const ownerToolCallIds = new Set(toolCallsOfMessage(owner.message).map((call) => call.id));
    if (!ownerToolCallIds.has(boundary.toolCallId)) {
      throw new CheckpointInvalidError(checkpoint, `边界 #${coveredUpTo} 不属于最近的 Turn`);
    }
    const ownerResults = records.filter(
      (record): record is ToolResultRecord =>
        isToolResult(record) &&
        record.assistantRecordSeq === owner.recordSeq &&
        record.runId === owner.runId &&
        ownerToolCallIds.has(record.toolCallId),
    );
    if (ownerResults.some((result) => result.recordSeq > coveredUpTo)) {
      throw new CheckpointInvalidError(
        checkpoint,
        `覆盖范围在 Turn 中途结束（结果 #${coveredUpTo} 之后仍有本 Turn 的工具结果）`,
      );
    }
    if (!eligible.has(owner.recordSeq)) throw new CheckpointInvalidError(checkpoint, "边界 Turn 不完整");
    return;
  }

  if (boundary.type === "assistant_message") {
    if (!eligible.has(boundary.recordSeq)) {
      throw new CheckpointInvalidError(checkpoint, `边界 Turn 不完整 #${coveredUpTo}`);
    }
    const message =
      boundary.message.stopReason === "aborted"
        ? normalizeAbortedMessage(boundary.message)
        : boundary.message;
    const calls = toolCallsOfMessage(message);
    if (calls.length === 0) return;
    // 纯缺结果 Turn（崩溃窗口）可作边界：Run 已死且不重放，结果永不再现，上下文按 unknown 占位合成。
    // 任一 call 已有结果（含 unknown）时边界必须落在最后一条 tool_result，否则覆盖在 Turn 中途结束。
    const callIds = new Set(calls.map((call) => call.id));
    const hasAnyResult = records.some(
      (record) =>
        record.type === "tool_result" &&
        record.assistantRecordSeq === boundary.recordSeq &&
        record.runId === boundary.runId &&
        callIds.has(record.toolCallId),
    );
    if (hasAnyResult) {
      throw new CheckpointInvalidError(
        checkpoint,
        `边界是含工具调用的 assistant_message #${coveredUpTo}，Turn 未结束`,
      );
    }
    return;
  }

  throw new CheckpointInvalidError(checkpoint, `边界记录类型 ${boundary.type} 不是 Turn 边界`);
}

export interface ResumeResult {
  meta: SessionMeta;
  records: SessionRecord[];
  warnings: SessionLoadWarning[];
  checkpoint: CheckpointRecord | null;
  unknownSideEffects: UnknownSideEffect[];
}

export async function resumeSession(store: SessionStore, source: SessionRef): Promise<ResumeResult> {
  const snapshot = await store.openSession(source);
  try {
    if (snapshot.records.length === 0) throw new Error("会话为空");
    return {
      ...snapshot,
      checkpoint: findLatestCheckpoint(snapshot.records),
      unknownSideEffects: findUnknownSideEffects(snapshot.records),
    };
  } catch (error) {
    await store.releaseSession(source);
    throw error;
  }
}

export class RunStartGate {
  readonly unknownResults: readonly UnknownSideEffect[];
  private acknowledged = false;

  constructor(records: readonly SessionRecord[]) {
    this.unknownResults = findUnknownSideEffects(records);
  }

  get requiresAcknowledgement(): boolean {
    return this.unknownResults.length > 0 && !this.acknowledged;
  }

  // 仅内存确认“已知晓结果未知”，不改写任何记录。
  acknowledge(): void {
    this.acknowledged = true;
  }

  assertCanStartRun(): void {
    if (this.requiresAcknowledgement) {
      throw new UnknownSideEffectsError(this.unknownResults);
    }
  }
}

export function createRunStartGate(records: readonly SessionRecord[]): RunStartGate {
  return new RunStartGate(records);
}
