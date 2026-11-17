import {
  isTurnComplete,
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
  if (
    assistant.message.stopReason !== "toolUse" &&
    assistant.message.stopReason !== "stop" &&
    assistant.message.stopReason !== "length"
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
    if (assistant.message.stopReason !== "toolUse" && assistant.message.stopReason !== "stop") continue;
    const calls = toolCallsOfMessage(assistant.message);
    for (const call of calls) {
      if (call.parse.status !== "parsed" || !call.id || !call.name) continue;
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
  let blocked = false;
  for (const record of records) {
    if (record.recordSeq > coveredUpTo) break;
    if (record.type === "user_prompt") blocked = false;
    if (record.type !== "assistant_message") continue;
    if (!isTurnComplete(record, toolResults)) blocked = true;
    if (!blocked) eligible.add(record.recordSeq);
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
    if (!eligible.has(boundary.recordSeq) || toolCallsOfMessage(boundary.message).length > 0) {
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
