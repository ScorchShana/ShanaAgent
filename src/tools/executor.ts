import { fileOperationError } from "./write.js";
import { parseSettings, type Settings } from "../llm/settings-store.js";
import type { StoredToolCall, ToolResultImage } from "../sessions/records.js";
import type { PermissionDenyReason } from "../security/approval-manager.js";
import {
  createPathPolicy,
  assertPathTargetUnchanged,
  PathPolicyError,
  type PathPolicy,
} from "../security/path-policy.js";
import type { ToolResultStatus } from "../sessions/records.js";
import {
  createToolRegistry,
  formatErrorString,
  defaultNeedsApproval,
  ToolArgumentError,
  reportToolDiagnostic,
  type ToolDiagnostic,
  type RegisteredTool,
  type ToolAction,
  type ToolContext,
  type ToolOutcome,
  type ToolPlan,
  type ToolRegistry,
} from "./registry.js";
import type { SpawnProcess, TerminateProcessTree } from "./shell.js";

export type ToolCallRequest = StoredToolCall;

export interface ToolPermissionRequest {
  toolCallId: string;
  toolName: string;
  action: ToolAction;
}

export type ToolPermissionDecision =
  { decision: "allow" } | { decision: "deny"; reason: PermissionDenyReason } | { decision: "cancelled" };

export type ToolPermissionGate = (request: ToolPermissionRequest) => Promise<ToolPermissionDecision>;

export type ToolErrorCategory =
  "arguments" | "unknown_tool" | "path" | "permission" | "cancelled" | "io" | "shell" | "internal";

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  status: ToolResultStatus;
  content: string;
  errorCategory?: ToolErrorCategory;
  termination?: ToolOutcome["termination"];
  priorContent?: string;
  // 仅 view_image 成功结果携带；错误/取消/拒绝路径不携带。
  images?: ToolResultImage[];
}

export interface ToolExecutorOptions {
  workspaceRoot: string;
  onDiagnostic?: (event: ToolDiagnostic) => void;
  onCleanupWarning?: (temporaryPath: string) => void;
  onPendingShell?: (cleanup: import("./shell.js").PendingShellCleanup) => void;
  onToolOutput?: (toolCallId: string, snapshot: string) => void;
  settings?: Pick<Settings, "editMaxFileBytes" | "viewImageMaxBytes" | "globTimeoutMs" | "grepStderrMaxChars">;
  // 当前模型接受 image 输入时注册 view_image；默认 false（六工具）。
  imageInput?: boolean;
  permissionGate?: ToolPermissionGate;
  platform?: NodeJS.Platform;
  registry?: ToolRegistry;
  pathPolicy?: PathPolicy;
  spawnProcess?: SpawnProcess;
  terminateTree?: TerminateProcessTree;
  killConfirmTimeoutMs?: number;
  ripgrepPath?: string;
}

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #pathPolicy: PathPolicy;
  readonly #options: ToolExecutorOptions;

  constructor(options: ToolExecutorOptions) {
    this.#options = { ...options, settings: parseSettings(options.settings) };
    const platform = options.platform ?? process.platform;
    this.#pathPolicy = options.pathPolicy ?? createPathPolicy(options.workspaceRoot, platform);
    this.#registry =
      options.registry ??
      createToolRegistry(platform, this.#options.settings, undefined, options.imageInput ?? false);
  }

  get registry(): ToolRegistry {
    return this.#registry;
  }

  async execute(call: ToolCallRequest, options: { signal?: AbortSignal } = {}): Promise<ToolExecutionResult> {
    const signal = options.signal;
    const toolName = call.name;

    const fail = (
      status: ToolResultStatus,
      category: ToolErrorCategory,
      content: string,
    ): ToolExecutionResult => ({
      toolCallId: call.id,
      toolName,
      status,
      content: this.#finalize(status, content),
      errorCategory: category,
    });

    if (signal?.aborted) {
      return fail("not_executed", "cancelled", "Cancelled by user.");
    }
    if (call.parse.status === "invalid") {
      const reason =
        call.parse.error === "non_finite_number"
          ? "Argument number is out of range. Not executed. Use a finite number."
          : call.parse.error === "incomplete"
            ? "Incomplete arguments JSON. Not executed. Resend complete JSON."
            : "Invalid arguments JSON. Not executed. Resend valid JSON.";
      return fail("error", "arguments", reason);
    }

    const tool: RegisteredTool | undefined = this.#registry.get(call.name);
    if (!tool)
      return fail("error", "unknown_tool", `Unknown tool ${formatErrorString(call.name)}. Not executed.`);

    let plan: ToolPlan;
    try {
      plan = await tool.prepare(call.parse.arguments, this.#createContext(signal, call.id));
    } catch (error) {
      reportToolDiagnostic(this.#options.onDiagnostic, "tool.failure", error);
      if (error instanceof ToolArgumentError) return fail("error", "arguments", error.message);
      if (error instanceof PathPolicyError) return fail("error", "path", fileOperationError(error).content);
      return fail("error", "internal", "Internal error. Stop and ask user.");
    }

    if (signal?.aborted) {
      return fail("not_executed", "cancelled", "Cancelled by user.");
    }

    const approvedPaths = (
      plan.action.type === "read" ? plan.action.paths : plan.action.type === "write" ? [plan.action.path] : []
    ).map((target) => ({ ...target }));

    if (defaultNeedsApproval(plan.action)) {
      const gate = this.#options.permissionGate;
      if (!gate) {
        return fail("denied", "permission", permissionMessage("no_approver"));
      }
      let decision: ToolPermissionDecision;
      try {
        decision = await gate({ toolCallId: call.id, toolName: tool.name, action: plan.action });
      } catch (error) {
        reportToolDiagnostic(this.#options.onDiagnostic, "tool.approval", error);
        return fail("denied", "permission", permissionMessage("approver_error"));
      }
      if (decision.decision === "cancelled") {
        return fail("not_executed", "cancelled", permissionMessage("cancelled"));
      }
      if (decision.decision !== "allow") {
        return fail("denied", "permission", permissionMessage(decision.reason));
      }
    }

    if (signal?.aborted) {
      return fail("not_executed", "cancelled", "Cancelled by user.");
    }

    let outcome: ToolOutcome;
    try {
      for (const target of approvedPaths) await assertPathTargetUnchanged(this.#pathPolicy, target);
      if (signal?.aborted) return fail("not_executed", "cancelled", "Cancelled by user.");
      outcome = await plan.execute();
    } catch (error) {
      reportToolDiagnostic(this.#options.onDiagnostic, "tool.failure", error);
      if (error instanceof PathPolicyError) return fail("error", "path", fileOperationError(error).content);
      return fail("error", "internal", "Internal error. Stop and ask user.");
    }

    return {
      toolCallId: call.id,
      toolName: tool.name,
      status: outcome.status,
      content: this.#finalize(outcome.status, outcome.content),
      errorCategory: outcome.category,
      termination: outcome.termination,
      ...(outcome.priorContent !== undefined ? { priorContent: outcome.priorContent } : {}),
      ...(outcome.images !== undefined ? { images: outcome.images } : {}),
    };
  }

  #createContext(signal: AbortSignal | undefined, toolCallId: string): ToolContext {
    const onToolOutput = this.#options.onToolOutput;
    return {
      workspaceRoot: this.#pathPolicy.workspaceRoot,
      pathPolicy: this.#pathPolicy,
      platform: this.#options.platform ?? process.platform,
      ...(this.#options.settings ?? parseSettings(undefined)),
      signal,
      spawnProcess: this.#options.spawnProcess,
      terminateTree: this.#options.terminateTree,
      killConfirmTimeoutMs: this.#options.killConfirmTimeoutMs,
      ripgrepPath: this.#options.ripgrepPath,
      onDiagnostic: this.#options.onDiagnostic,
      onCleanupWarning: this.#options.onCleanupWarning,
      onPendingShell: this.#options.onPendingShell,
      onOutput: onToolOutput ? (snapshot) => onToolOutput(toolCallId, snapshot) : undefined,
    };
  }

  #finalize(status: ToolResultStatus, content: string): string {
    if (status === "success") return content;
    return content.startsWith("Error: ") ? content : `Error: ${content}`;
  }
}

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutor(options);
}

// T13 前为引擎占位文案，最终 `Error:` 模板待逐工具定稿。
function permissionMessage(reason: PermissionDenyReason | "cancelled"): string {
  switch (reason) {
    case "no_approver":
      return "Internal error. Stop and ask user.";
    case "approver_error":
      return "Internal error. Stop and ask user.";
    case "cancelled":
      return "Cancelled by user.";
    case "denied_by_user":
      return "User denied.";
    case "denied_by_policy":
      // 模式策略拒绝 ≠ 用户逐次拒绝，不得归为 User denied.（D2 最短文案）。
      return "Denied by read-only mode.";
  }
}
