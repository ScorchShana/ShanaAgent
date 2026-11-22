import type { PathPolicy, ResolvedToolPath } from "./path-policy.js";
import {
  defaultNeedsApproval,
  type ReadToolAction,
  type ToolAction,
  type WriteToolAction,
} from "../tools/registry.js";

export type ToolAccessKind = "read" | "write" | "shell" | "unknown";

// 审批模式的权威定义。sessions/records.ts 因层边界禁止依赖 security，
// 使用结构同一的本地联合（SESSION_APPROVAL_MODES）自行校验。
export type ApprovalMode = "confirm" | "auto" | "full";

export interface SessionGrants {
  shellCommands: ReadonlySet<string>;
  fileScopes: ReadonlySet<string>;
}

export function emptySessionGrants(): SessionGrants {
  return { shellCommands: new Set<string>(), fileScopes: new Set<string>() };
}

export type ApprovalGrantKey =
  | { kind: "shell_command"; command: string }
  | { kind: "file"; toolName: string; workspace?: string; paths: string[] };

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  access: ToolAccessKind;
  operation?: WriteToolAction["operation"];
  /** path-policy 解析后的真实路径，不含模型自报描述 */
  paths: string[];
  /** 任一真实路径落在工作区外 */
  touchesOutsideWorkspace: boolean;
  command?: string;
  /** “本会话允许”本次可写入的授权键；null 表示本次选择只对本次生效 */
  grantKey: ApprovalGrantKey | null;
}

export interface ToolCallSubject {
  toolCallId: string;
  toolName: string;
  action: ToolAction;
  workspaceRoot?: string;
  pathPolicy?: PathPolicy;
}

export type PermissionVerdict =
  | {
      outcome: "allow";
      basis: "workspace_read" | "skills_read" | "session_grant" | "workspace_write" | "mode_full";
    }
  | { outcome: "ask"; request: ApprovalRequest };

function readFields(action: ReadToolAction) {
  return {
    paths: action.paths.map((target) => target.realPath),
    touchesOutsideWorkspace: action.paths.some((target) => !target.insideWorkspace),
  };
}

function fileGrant(subject: ToolCallSubject, targets: ResolvedToolPath[]): ApprovalGrantKey | null {
  const includesWorkspace = targets.some((target) => target.insideWorkspace);
  const workspace = subject.workspaceRoot ?? subject.pathPolicy?.workspaceRoot;
  if (
    !targets.length ||
    targets.some((target) => target.danglingSymlink) ||
    (includesWorkspace && !workspace)
  )
    return null;
  return {
    kind: "file",
    toolName: subject.toolName,
    ...(includesWorkspace ? { workspace } : {}),
    paths: [...new Set(targets.filter((target) => !target.insideWorkspace).map((target) => target.realPath))],
  };
}

function scopeIds(key: Extract<ApprovalGrantKey, { kind: "file" }>): string[] {
  const ids = key.paths.map((path) => JSON.stringify([key.toolName, "path", path]));
  if (key.workspace) ids.push(JSON.stringify([key.toolName, "workspace", key.workspace]));
  return ids;
}

function buildApprovalRequest(subject: ToolCallSubject): ApprovalRequest {
  const base = { toolCallId: subject.toolCallId, toolName: subject.toolName };
  const action = subject.action;

  if (action.type === "read") {
    const { paths, touchesOutsideWorkspace } = readFields(action);
    return {
      ...base,
      access: "read",
      paths,
      touchesOutsideWorkspace,
      grantKey: fileGrant(subject, action.paths),
    };
  }

  if (action.type === "write") {
    return {
      ...base,
      access: "write",
      operation: action.operation,
      paths: [action.path.realPath],
      touchesOutsideWorkspace: !action.path.insideWorkspace,
      grantKey: fileGrant(subject, [action.path]),
    };
  }

  if (action.type === "shell") {
    return {
      ...base,
      access: "shell",
      paths: [],
      touchesOutsideWorkspace: false,
      command: action.command,
      grantKey: { kind: "shell_command", command: action.command },
    };
  }

  return { ...base, access: "unknown", paths: [], touchesOutsideWorkspace: false, grantKey: null };
}

export function withGrant(grants: SessionGrants, key: ApprovalGrantKey): SessionGrants {
  if (key.kind === "shell_command")
    return { ...grants, shellCommands: new Set([...grants.shellCommands, key.command]) };
  return { ...grants, fileScopes: new Set([...grants.fileScopes, ...scopeIds(key)]) };
}

export function evaluatePermission(
  subject: ToolCallSubject,
  grants: SessionGrants,
  mode: ApprovalMode,
): PermissionVerdict {
  if (!["read", "glob", "grep", "write", "edit", "bash", "view_image"].includes(subject.toolName)) {
    // executor 已先拦 unknown，此为纵深防御：任何模式都人工。
    return {
      outcome: "ask",
      request: { ...buildApprovalRequest(subject), access: "unknown", grantKey: null },
    };
  }
  const request = buildApprovalRequest(subject);
  const key = request.grantKey;
  if (
    key &&
    (key.kind === "shell_command"
      ? grants.shellCommands.has(key.command)
      : scopeIds(key).every((id) => grants.fileScopes.has(id)))
  ) {
    return { outcome: "allow", basis: "session_grant" };
  }
  // full 放行的是审批，不是安全校验：路径复验/UTF-8/限额/取消边界在 executor 层仍强制。
  if (mode === "full") return { outcome: "allow", basis: "mode_full" };
  if (subject.action.type === "read") {
    if (!defaultNeedsApproval(subject.action)) {
      // 含 skills 区路径的只读放行列 skills_read；纯区内仍 workspace_read。
      const basis = subject.action.paths.some((target) => target.insideSkills)
        ? "skills_read"
        : "workspace_read";
      return { outcome: "allow", basis };
    }
    return { outcome: "ask", request };
  }

  if (mode === "confirm") return { outcome: "ask", request };

  if (subject.action.type === "write") {
    if (subject.action.path.insideWorkspace) return { outcome: "allow", basis: "workspace_write" };
    return { outcome: "ask", request };
  }

  return { outcome: "ask", request };
}
