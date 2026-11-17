import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StopReason } from "@earendil-works/pi-ai";
import { SessionStore, type SessionRef, type SessionStoreOptions } from "../../src/sessions/session-store.js";
import type {
  AssistantMessageRecord,
  StoredAssistantMessage,
  CheckpointRecord,
  RunFinishedRecord,
  RunModelSnapshot,
  SessionRunOutcome,
  ToolResultRecord,
  ToolResultStatus,
  UserPromptRecord,
} from "../../src/sessions/records.js";

const RECORD_TS = "2026-10-27T10:00:00.000Z";

const tmpDirs: string[] = [];

export function tempDir(prefix = "shana-sessions-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const WORKSPACE_ID = "demo-workspace-0123456789ab";

export function sessionRef(sessionId: string, workspaceId = WORKSPACE_ID): SessionRef {
  return { workspaceId, sessionId };
}

export function makeStore(options: Partial<SessionStoreOptions> = {}): {
  store: SessionStore;
  sessionsDir: string;
} {
  const sessionsDir = options.sessionsDir ?? tempDir();
  const store = new SessionStore({ sessionsDir, ...options });
  return { store, sessionsDir };
}

export function messagesPathOf(sessionsDir: string, ref: SessionRef): string {
  return path.join(sessionsDir, ref.workspaceId, ref.sessionId, "messages.jsonl");
}

export function metaPathOf(sessionsDir: string, ref: SessionRef): string {
  return path.join(sessionsDir, ref.workspaceId, ref.sessionId, "meta.json");
}

export function fixedNow(iso = "2026-10-27T10:00:00.000Z"): () => Date {
  return () => new Date(iso);
}

export function makeModelSnapshot(): RunModelSnapshot {
  return {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-flash",
    modelName: "DeepSeek Flash",
    reasoning: true,
    thinking: true,
    reasoningEffort: "high",
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

export function makeAssistantMessage(
  toolCalls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [],
  text = "ok",
  options: { stopReason?: StopReason } = {},
): StoredAssistantMessage {
  const content: Array<Record<string, unknown>> = [];
  if (text.length > 0) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      rawArguments: JSON.stringify(call.arguments ?? {}),
      parse: { status: "parsed", arguments: call.arguments ?? {} },
    });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? (toolCalls.length ? "toolUse" : "stop"),
    timestamp: 1,
  } as unknown as StoredAssistantMessage;
}

export function makeUserPromptRecord(recordSeq: number, runId: string, text: string): UserPromptRecord {
  return { recordSeq, ts: RECORD_TS, type: "user_prompt", runId, text };
}

export function makeAssistantRecord(
  recordSeq: number,
  runId: string,
  toolCalls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }> = [],
  options: { text?: string; stopReason?: StopReason } = {},
): AssistantMessageRecord {
  return {
    recordSeq,
    ts: RECORD_TS,
    type: "assistant_message",
    runId,
    message: makeAssistantMessage(toolCalls, options.text ?? "ok", {
      stopReason: options.stopReason,
    }),
  };
}

export function makeToolResultRecord(
  recordSeq: number,
  runId: string,
  toolCallId: string,
  status: ToolResultStatus,
  options: { toolName?: string; content?: string; assistantRecordSeq?: number } = {},
): ToolResultRecord {
  return {
    recordSeq,
    ts: RECORD_TS,
    type: "tool_result",
    runId,
    toolCallId,
    assistantRecordSeq: options.assistantRecordSeq ?? recordSeq - 1,
    toolName: options.toolName ?? "read",
    status,
    content: options.content ?? "ok",
  };
}

export function makeCheckpointRecord(
  recordSeq: number,
  summary: string,
  coveredUpTo: number,
): CheckpointRecord {
  return {
    recordSeq,
    ts: RECORD_TS,
    type: "checkpoint",
    summary,
    coveredUpTo,
    model: { providerId: "deepseek", modelId: "deepseek-flash" },
  };
}

export function makeRunFinishedRecord(
  recordSeq: number,
  runId: string,
  outcome: SessionRunOutcome,
): RunFinishedRecord {
  return { recordSeq, ts: RECORD_TS, type: "run_finished", runId, outcome, persisted: true };
}
