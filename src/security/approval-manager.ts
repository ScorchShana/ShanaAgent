import type { ApprovalDecision } from "../core/state.js";
import { matchFirstCommand, type BashCommandAnalyzer } from "./bash-policy.js";
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
  /** auto 模式 bash 判定 seam；缺省为首命令白名单 analyzer。 */
  analyzeBash?: BashCommandAnalyzer;
  /** analyzer 抛错时的诊断出口（永不兜底放行，按 ask 处理）。 */
  onAnalyzerError?: (error: unknown) => void;
}

export class ApprovalManager {
  #grants: SessionGrants = emptySessionGrants();
  readonly #approver: Approver | undefined;
  readonly #analyzeBash: BashCommandAnalyzer;
  readonly #onAnalyzerError: ((error: unknown) => void) | undefined;

  constructor(options: ApprovalManagerOptions = {}) {
    this.#approver = options.approver;
    this.#analyzeBash = options.analyzeBash ?? matchFirstCommand;
    this.#onAnalyzerError = options.onAnalyzerError;
  }

  get grants(): SessionGrants {
    return { shellCommands: new Set(this.#grants.shellCommands) };
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

    // auto 模式 bash：会话授权已在 evaluatePermission 命中放行，此处 analyzer 是第二道；
    // 判不了或抛错一律落人工，绝不兜底放行。
    if (options.mode === "auto" && verdict.request.access === "shell") {
      let analyzed: ReturnType<BashCommandAnalyzer>;
      try {
        analyzed = this.#analyzeBash(verdict.request.command ?? "");
      } catch (error) {
        this.#onAnalyzerError?.(error);
        analyzed = "ask";
      }
      if (analyzed === "allow") return { decision: "allow", basis: "bash_policy" };
    }

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
