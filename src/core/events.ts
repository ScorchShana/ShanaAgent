import type { ApprovalSummary, ApprovalDecision, RunOutcome, RunPhase } from "./state.js";

export interface RunStartedEvent {
  type: "run.started";
  runId: string;
}

export interface RunStateChangedEvent {
  type: "run.state_changed";
  runId: string;
  phase: RunPhase;
}

export interface ToolStartedEvent {
  type: "tool.started";
  runId: string;
  toolCallId: string;
  toolName: string;
}

export interface ToolCompletedEvent {
  type: "tool.completed";
  runId: string;
  toolCallId: string;
}

export interface PermissionRequestedEvent {
  summary?: ApprovalSummary;
  type: "permission.requested";
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
}

export interface PermissionResolvedEvent {
  type: "permission.resolved";
  approvalId: string;
  decision: ApprovalDecision;
}

export interface RunFinishedEvent {
  type: "run.finished";
  runId: string;
  outcome: RunOutcome;
  persisted: boolean;
  error?: string;
}

export interface CompactionStartedEvent {
  type: "compaction.started";
  runId?: string;
}

export interface CompactionFinishedEvent {
  type: "compaction.finished";
  runId?: string;
  status: "completed" | "cancelled" | "noop" | "failed";
  path?: "primary" | "fallback";
  coveredUpTo?: number;
  error?: string;
}

export type FormalEvent =
  | RunStartedEvent
  | RunStateChangedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | RunFinishedEvent
  | CompactionStartedEvent
  | CompactionFinishedEvent;

export interface LlmTextDeltaEvent {
  type: "llm.text.delta";
  runId: string;
  delta: string;
}

export interface LlmThinkingDeltaEvent {
  type: "llm.thinking.delta";
  runId: string;
  delta: string;
}

export interface ToolOutputDeltaEvent {
  type: "tool.output.delta";
  runId: string;
  toolCallId: string;
  delta: string;
}

export type StreamingEvent = LlmTextDeltaEvent | LlmThinkingDeltaEvent | ToolOutputDeltaEvent;

export type BusEvent = FormalEvent | StreamingEvent;
