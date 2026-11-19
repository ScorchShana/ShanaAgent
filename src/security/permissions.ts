import {
  defaultNeedsApproval,
  type ReadToolAction,
  type ToolAction,
  type WriteToolAction,
} from "../tools/registry.js";

export type ToolAccessKind = "read" | "write" | "shell" | "unknown";

export interface SessionGrants {
  fileTools: ReadonlySet<string>;
  shellCommands: ReadonlySet<string>;
}

export function emptySessionGrants(): SessionGrants {
  return { fileTools: new Set<string>(), shellCommands: new Set<string>() };
}

export type ApprovalGrantKey =
  { kind: "file_tool"; toolName: string } | { kind: "shell_command"; command: string };

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
  | { outcome: "allow"; basis: "workspace_read" | "skills_read" | "session_grant" }
  | { outcome: "ask"; request: ApprovalRequest };

const FILE_TOOLS_WITH_GRANT = new Set(["write", "edit"]);

function readFields(action: ReadToolAction) {
  return {
    paths: action.paths.map((target) => target.realPath),
    touchesOutsideWorkspace: action.paths.some((target) => !target.insideWorkspace),
  };
}

function buildApprovalRequest(subject: ToolCallSubject): ApprovalRequest {
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
      grantKey: FILE_TOOLS_WITH_GRANT.has(subject.toolName)
        ? { kind: "file_tool", toolName: subject.toolName }
        : null,
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

function hasGrant(grants: SessionGrants, key: ApprovalGrantKey): boolean {
  return key.kind === "file_tool"
    ? grants.fileTools.has(key.toolName)
    : grants.shellCommands.has(key.command);
}

export function withGrant(grants: SessionGrants, key: ApprovalGrantKey): SessionGrants {
  if (key.kind === "file_tool") {
    return { fileTools: new Set([...grants.fileTools, key.toolName]), shellCommands: grants.shellCommands };
  }
  return { fileTools: grants.fileTools, shellCommands: new Set([...grants.shellCommands, key.command]) };
}

export function evaluatePermission(subject: ToolCallSubject, grants: SessionGrants): PermissionVerdict {
  if (!["read", "glob", "grep", "write", "edit", "bash", "view_image"].includes(subject.toolName)) {
    return {
      outcome: "ask",
      request: { ...buildApprovalRequest(subject), access: "unknown", grantKey: null },
    };
  }
  if (!defaultNeedsApproval(subject.action)) {
    // 含 skills 区路径的只读放行列 skills_read；纯区内仍 workspace_read。
    const basis =
      subject.action.type === "read" && subject.action.paths.some((target) => target.insideSkills)
        ? "skills_read"
        : "workspace_read";
    return { outcome: "allow", basis };
  }
  const request = buildApprovalRequest(subject);
  if (request.grantKey !== null && !request.touchesOutsideWorkspace && hasGrant(grants, request.grantKey)) {
    return { outcome: "allow", basis: "session_grant" };
  }
  return { outcome: "ask", request };
}
