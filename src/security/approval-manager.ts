import type { ApprovalDecision } from "../core/state.js";
import type { DecisionOutcome } from "../llm/decision-service.js";
import {
  emptySessionGrants,
  evaluatePermission,
  withGrant,
  type ApprovalGrantKey,
  type ApprovalRequest,
  type SessionGrants,
  type ToolCallSubject,
} from "./permissions.js";

/**
 * 审批处理器：生产实现由 AgentLoop 接到 Controller 的待批槽位（T8/T9），测试注入 Mock Approver。
 * 待决状态、approvalId、requested/resolved 事件与取消唤醒都归 Controller，本模块不另建一套待批状态。
 */
export type Approver = (request: ApprovalRequest) => Promise<ApprovalDecision>;

export type PermissionDenyReason = "no_approver" | "denied_by_user" | "approver_error";

export type PermissionOutcome =
  | {
      decision: "allow";
      basis: "workspace_read" | "session_grant" | "approved_once" | "approved_for_session" | "decision_model";
    }
  | { decision: "deny"; reason: PermissionDenyReason }
  | { decision: "cancelled" };

export interface ApprovalManagerOptions {
  approver?: Approver;
  onDecisionError?: (error: unknown) => void;
  decider?: (
    subject: ToolCallSubject,
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<DecisionOutcome>;
}

export class ApprovalManager {
  #grants: SessionGrants = emptySessionGrants();
  readonly #approver: Approver | undefined;
  readonly #decider: ApprovalManagerOptions["decider"];
  readonly #onDecisionError: ApprovalManagerOptions["onDecisionError"];

  constructor(options: ApprovalManagerOptions = {}) {
    this.#approver = options.approver;
    this.#decider = options.decider;
    this.#onDecisionError = options.onDecisionError;
  }

  get grants(): SessionGrants {
    return {
      fileTools: new Set(this.#grants.fileTools),
      shellCommands: new Set(this.#grants.shellCommands),
    };
  }

  async requestPermission(
    subject: ToolCallSubject,
    options: { signal?: AbortSignal } = {},
  ): Promise<PermissionOutcome> {
    if (options.signal?.aborted) return { decision: "cancelled" };
    const verdict = evaluatePermission(subject, this.#grants);
    if (verdict.outcome === "allow") {
      return { decision: "allow", basis: verdict.basis };
    }
    const request = verdict.request;
    const eligible =
      (request.access === "read" && ["read", "glob", "grep"].includes(subject.toolName)) ||
      (request.access === "write" &&
        !request.touchesOutsideWorkspace &&
        ["write", "edit"].includes(subject.toolName)) ||
      (request.access === "shell" && subject.toolName === "bash");
    if (eligible && this.#decider) {
      let result: DecisionOutcome;
      try {
        result = await this.#decider(subject, request, options.signal);
      } catch (error) {
        this.#onDecisionError?.(error);
        result = { kind: "fallback", category: "transport" };
      }
      if (options.signal?.aborted || result.kind === "cancelled") return { decision: "cancelled" };
      if (result.kind === "allow_once") return { decision: "allow", basis: "decision_model" };
    }
    if (options.signal?.aborted) return { decision: "cancelled" };
    const approver = this.#approver;
    if (!approver) {
      return { decision: "deny", reason: "no_approver" };
    }

    let decision: ApprovalDecision;
    try {
      decision = await approver(verdict.request);
    } catch {
      if (options.signal?.aborted) return { decision: "cancelled" };
      return { decision: "deny", reason: "approver_error" };
    }

    if (options.signal?.aborted || decision === "cancelled") return { decision: "cancelled" };
    if (decision === "deny") return { decision: "deny", reason: "denied_by_user" };
    if (decision === "session") {
      const key: ApprovalGrantKey | null = verdict.request.grantKey;
      if (key === null) return { decision: "allow", basis: "approved_once" };
      this.#grants = withGrant(this.#grants, key);
      return { decision: "allow", basis: "approved_for_session" };
    }
    return { decision: "allow", basis: "approved_once" };
  }
}
