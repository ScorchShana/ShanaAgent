import type { ApprovalDecision } from "../core/state.js";
import { analyzeBash } from "./bash-policy.js";
import {
  emptySessionGrants,
  evaluatePermission,
  withGrant,
  type ApprovalGrantKey,
  type ApprovalMode,
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
      revalidate?: () => Promise<void>;
      basis:
        | "workspace_read"
        | "skills_read"
        | "session_grant"
        | "workspace_write"
        | "bash_policy"
        | "mode_full"
        | "approved_once"
        | "approved_for_session";
    }
  | { decision: "deny"; reason: PermissionDenyReason }
  | { decision: "cancelled" };

export interface ApprovalManagerOptions {
  approver?: Approver;
  analyzeBash?: typeof analyzeBash;
  /** analyzer 抛错时的诊断出口（永不兜底放行，按 ask 处理）。 */
  onAnalyzerError?: (error: unknown) => void;
}

export class ApprovalManager {
  #grants: SessionGrants = emptySessionGrants();
  readonly #approver: Approver | undefined;
  readonly #analyzeBash: typeof analyzeBash;
  readonly #onAnalyzerError: ((error: unknown) => void) | undefined;

  constructor(options: ApprovalManagerOptions = {}) {
    this.#approver = options.approver;
    this.#analyzeBash = options.analyzeBash ?? analyzeBash;
    this.#onAnalyzerError = options.onAnalyzerError;
  }

  get grants(): SessionGrants {
    return {
      shellCommands: new Set(this.#grants.shellCommands),
      fileScopes: new Set(this.#grants.fileScopes),
    };
  }

  async requestPermission(
    subject: ToolCallSubject,
    options: { signal?: AbortSignal; mode: ApprovalMode },
  ): Promise<PermissionOutcome> {
    if (options.signal?.aborted) return { decision: "cancelled" };
    const verdict = evaluatePermission(subject, this.#grants, options.mode);
    if (verdict.outcome === "allow") {
      return { decision: "allow", basis: verdict.basis };
    }
    if (options.signal?.aborted) return { decision: "cancelled" };

    if (verdict.request.access === "shell" && subject.pathPolicy) {
      try {
        const result = await this.#analyzeBash(verdict.request.command!, {
          mode: options.mode,
          pathPolicy: subject.pathPolicy,
          shellExecutable: subject.action.type === "shell" ? subject.action.shellExecutable : undefined,
        });
        if (options.signal?.aborted) return { decision: "cancelled" };
        if (result.decision === "allow")
          return { decision: "allow", basis: "bash_policy", revalidate: result.revalidate };
      } catch (error) {
        this.#onAnalyzerError?.(error);
      }
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
