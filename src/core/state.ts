import type { RunModelSnapshot, SessionMeta } from "../sessions/records.js";
import type { SessionRef } from "../sessions/session-store.js";

export const RUN_PHASES = [
  "preparing",
  "streaming",
  "compacting",
  "executing_tool",
  "awaiting_approval",
  "cancelling",
  "finalizing",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_OUTCOMES = ["completed", "cancelled", "failed", "turn_limit"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export interface ApprovalSummary {
  paths: string[];
  touchesOutsideWorkspace: boolean;
  operation?: string;
  command?: string;
  parameters?: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  summary?: ApprovalSummary;
}

export type ControllerStatus =
  { kind: "idle" } | { kind: "running"; runId: string; phase: RunPhase } | { kind: "compacting" };

export interface RunTiming {
  readonly runId: string;
  readonly elapsedMs: number;
}

export interface LastRunInfo {
  elapsedMs: number;
  runId: string;
  outcome: RunOutcome;
  persisted: boolean;
}

export interface StreamingAttempt {
  turn: number;
  attempt: number;
  status: "streaming" | "failed" | "completed" | "cancelled";
  text: string;
  thinking: string;
}

export interface AutoDecisionStatus {
  enabled: boolean;
  availability: "ready" | "missing" | "invalid" | "unavailable";
  message?: string;
}

export interface SessionView {
  autoDecision: AutoDecisionStatus;
  title: string | null;
  ref: SessionRef | null;
  model: RunModelSnapshot | null;
  models: RunModelSnapshot[];
  runModel: RunModelSnapshot | null;
  contextBaselineTokens: number | null;
}
export interface SessionListEntry extends SessionMeta {
  title: string;
  preview: string;
  lastActiveAt: string;
  occupied: boolean;
  runCount: number;
}

export interface ControllerSnapshot {
  runTiming: RunTiming | null;
  // contextEstimateTokens 由 Controller 在压缩完成时写入，不属于 Hook 提供的 SessionView。
  session: SessionView & { contextEstimateTokens: number | null };
  sessionOperation: boolean;
  streamingAttempts: StreamingAttempt[];
  status: ControllerStatus;
  pendingApproval: PendingApproval | null;
  accumulatedText: string;
  accumulatedThinking: string;
  lastRun: LastRunInfo | null;
}

export const APPROVAL_DECISIONS = ["once", "session", "deny", "cancelled"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export class BusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusyError";
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export class NotImplementedCommandError extends Error {
  constructor(command: string) {
    super(`${command}: 尚未实现（属后续任务）`);
    this.name = "NotImplementedCommandError";
  }
}
