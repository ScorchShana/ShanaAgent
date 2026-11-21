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

// D10：文件工具不再有会话授权（auto 区内写直接放行，区外写逐次人工不可豁免），
// 会话授权只剩 bash 精确命令字符串。
export interface SessionGrants {
  shellCommands: ReadonlySet<string>;
}

export function emptySessionGrants(): SessionGrants {
  return { shellCommands: new Set<string>() };
}

export type ApprovalGrantKey = { kind: "shell_command"; command: string };

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

function buildApprovalRequest(subject: ToolCallSubject, allowShellGrant = false): ApprovalRequest {
  const base = { toolCallId: subject.toolCallId, toolName: subject.toolName };
  const action = subject.action;

  if (action.type === "read") {
    const { paths, touchesOutsideWorkspace } = readFields(action);
    // 区外读取无法被会话授权豁免，区内读取本就自动允许，故不产生授权键。
    return { ...base, access: "read", paths, touchesOutsideWorkspace, grantKey: null };
  }

  if (action.type === "write") {
    return {
      ...base,
      access: "write",
      operation: action.operation,
      paths: [action.path.realPath],
      touchesOutsideWorkspace: !action.path.insideWorkspace,
      // 区外写入逐次人工审批，会话授权不能豁免（I7）。
      grantKey: null,
    };
  }

  if (action.type === "shell") {
    return {
      ...base,
      access: "shell",
      paths: [],
      touchesOutsideWorkspace: false,
      command: action.command,
      grantKey: allowShellGrant ? { kind: "shell_command", command: action.command } : null,
    };
  }

  return { ...base, access: "unknown", paths: [], touchesOutsideWorkspace: false, grantKey: null };
}

export function withGrant(grants: SessionGrants, key: ApprovalGrantKey): SessionGrants {
  return { shellCommands: new Set([...grants.shellCommands, key.command]) };
}

/**
 * 三模式判定（纯函数；bash analyzer 在 ApprovalManager 层，不在此处）。
 * 顺序：unknown 防御 → full 放行 → read 分支 → confirm 逐次审批 → auto 写入与 bash 授权。
 */
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
    return { outcome: "ask", request: buildApprovalRequest(subject) };
  }

  if (mode === "confirm") return { outcome: "ask", request: buildApprovalRequest(subject) };

  if (subject.action.type === "write") {
    if (subject.action.path.insideWorkspace) return { outcome: "allow", basis: "workspace_write" };
    return { outcome: "ask", request: buildApprovalRequest(subject) };
  }

  if (subject.action.type === "shell") {
    if (grants.shellCommands.has(subject.action.command)) {
      return { outcome: "allow", basis: "session_grant" };
    }
    return { outcome: "ask", request: buildApprovalRequest(subject, true) };
  }

  return { outcome: "ask", request: buildApprovalRequest(subject) };
}
