import type { ApprovalDecision } from "../core/state.js";
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
      basis:
        | "workspace_read"
        | "skills_read"
        | "session_grant"
        | "approved_once"
        | "approved_for_session";
    }
  | { decision: "deny"; reason: PermissionDenyReason }
  | { decision: "cancelled" };

export interface ApprovalManagerOptions {
  approver?: Approver;
}

export class ApprovalManager {
  #grants: SessionGrants = emptySessionGrants();
  readonly #approver: Approver | undefined;

  constructor(options: ApprovalManagerOptions = {}) {
    this.#approver = options.approver;
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
