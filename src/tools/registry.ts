import { assertPathTargetUnchanged, type ResolvedToolPath } from "../security/path-policy.js";
import { loadPrompts, type PromptBundle } from "./prompts.js";
import { DEFAULT_SHELL_TIMEOUT_MS, parseSettings, type Settings } from "../llm/settings-store.js";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { PathPolicy } from "../security/path-policy.js";
import { editFileContent, type EditArguments } from "./edit.js";
import { validateGlobPattern, searchGlob, type GlobArguments } from "./glob.js";
import { searchFiles, type GrepArguments } from "./grep.js";
import {
  readFileRange,
  validateReadPathBudget,
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  type ReadArguments,
} from "./read.js";
import {
  detectShell,
  runShellCommand,
  shellResultToOutcome,
  type ShellDescriptor,
  type SpawnProcess,
  type TerminateProcessTree,
  type TerminationDetails,
} from "./shell.js";
import { viewImageFile, type ViewImageArguments } from "./view-image.js";
import { writeFileContent, type WriteArguments } from "./write.js";
import type { ToolResultImage } from "../sessions/records.js";

// 规范全集；默认注册表仅六件，view_image 按模型 image 输入能力条件注册。
export const TOOL_NAMES = ["read", "glob", "grep", "write", "edit", "bash", "view_image"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const SHELL_TOOL_NAMES = ["bash"] as const;
export type ShellToolName = (typeof SHELL_TOOL_NAMES)[number];


export interface ToolParameterProperty {
  type: "string" | "integer" | "boolean";
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  default?: number | boolean;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required: string[];
  additionalProperties: false;
}

export interface ReadToolAction {
  type: "read";
  paths: ResolvedToolPath[];
}

export interface WriteToolAction {
  type: "write";
  path: ResolvedToolPath;
  operation: "create" | "overwrite" | "edit";
}

export interface ShellToolAction {
  shellExecutable?: string;
  type: "shell";
  command: string;
}

export type ToolAction = ReadToolAction | WriteToolAction | ShellToolAction;

export type ToolOutcomeStatus = "success" | "error" | "timeout" | "unknown" | "not_executed";
export type ToolOutcomeCategory = "io" | "path" | "shell" | "cancelled" | "internal";

export interface ToolOutcome {
  status: ToolOutcomeStatus;
  content: string;
  category?: ToolOutcomeCategory;
  termination?: TerminationDetails;
  // write/edit 写入前旧文件全量快照（新建文件为空串），仅供 tool_result.priorContent，不进入模型可见 content
  priorContent?: string;
  // 仅 view_image 成功读取携带（恒单图）；错误/取消/拒绝路径不得携带。
  images?: ToolResultImage[];
}

export interface ToolPlan {
  action: ToolAction;
  execute(): Promise<ToolOutcome>;
}

export interface ToolDiagnostic {
  stage: string;
  code?: string;
  temporaryPath?: string;
  error?: unknown;
}

export function reportToolDiagnostic(
  sink: ((event: ToolDiagnostic) => void) | undefined,
  stage: string,
  error: unknown,
): void {
  try {
    sink?.({ stage, error, code: (error as NodeJS.ErrnoException | null)?.code });
  } catch {
    // Diagnostic delivery must not replace the tool result.
  }
}

export interface ToolContext {
  assertPathTarget?: () => Promise<void>;
  onDiagnostic?: (event: ToolDiagnostic) => void;
  onCleanupWarning?: (temporaryPath: string) => void;
  onPendingShell?: (cleanup: import("./shell.js").PendingShellCleanup) => void;
  onOutput?: (snapshot: string) => void;
  workspaceRoot: string;
  pathPolicy: PathPolicy;
  platform: NodeJS.Platform;
  editMaxFileBytes?: number;
  viewImageMaxBytes?: number;
  globTimeoutMs?: number;
  grepStderrMaxChars?: number;
  signal?: AbortSignal;
  spawnProcess?: SpawnProcess;
  terminateTree?: TerminateProcessTree;
  killConfirmTimeoutMs?: number;
  ripgrepPath?: string;
}

export interface RegisteredTool {
  name: ToolName;
  description: string;
  parameters: ToolParameterSchema;

  prepare(raw: JsonObject, context: ToolContext): Promise<ToolPlan>;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export function defaultNeedsApproval(action: ToolAction): boolean {
  // skills 区只读默认放行（与区内读取同档）；write/edit/bash 不豁免。
  if (action.type === "read")
    return action.paths.some((target) => !target.insideWorkspace && !target.insideSkills);
  return true;
}

export class ToolRegistry {
  readonly #tools: readonly RegisteredTool[];
  readonly #byName: ReadonlyMap<string, RegisteredTool>;

  constructor(tools: readonly RegisteredTool[]) {
    const byName = new Map<string, RegisteredTool>();
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`);
      byName.set(tool.name, tool);
    }
    this.#tools = [...tools];
    this.#byName = byName;
  }

  get(name: string): RegisteredTool | undefined {
    return this.#byName.get(name);
  }

  list(): readonly RegisteredTool[] {
    return this.#tools;
  }

  names(): readonly string[] {
    return this.#tools.map((tool) => tool.name);
  }
}

function withPathCheck(context: ToolContext, target: ResolvedToolPath): ToolContext {
  const snapshot = { ...target };
  return { ...context, assertPathTarget: () => assertPathTargetUnchanged(context.pathPolicy, snapshot) };
}

interface ToolDefinition<Args> {
  name: ToolName;
  description: string;
  parameters: ToolParameterSchema;
  parseArguments(raw: JsonObject): Args;
  prepare(args: Args, context: ToolContext): ToolPlan | Promise<ToolPlan>;
}

function defineTool<Args>(definition: ToolDefinition<Args>): RegisteredTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,

    async prepare(raw, context) {
      const args = definition.parseArguments(raw);
      return definition.prepare(args, context);
    },
  };
}

export function formatErrorString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function toRecord(raw: JsonObject, _toolName: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolArgumentError("Arguments must be a JSON object. Not executed.");
  }
  return raw as Record<string, unknown>;
}

function checkAllowedKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  _toolName: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) {
      throw new ToolArgumentError(`Unknown argument ${formatErrorString(key)}. Not executed.`);
    }
  }
}

function ensureNoNul(value: string, key: string, _toolName: string): void {
  if (value.includes("\0")) {
    throw new ToolArgumentError(`${key} contains NUL characters. Not executed.`);
  }
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  toolName: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ToolArgumentError(
      record[key] === undefined
        ? `Missing required argument ${formatErrorString(key)}. Not executed.`
        : `${key} must be a string. Not executed.`,
    );
  }
  if (options.allowEmpty === false && value.length === 0) {
    throw new ToolArgumentError(`${key} must not be empty. Not executed.`);
  }
  if (!["content", "old_string", "new_string"].includes(key)) ensureNoNul(value, key, toolName);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, toolName: string): string | undefined {
  if (record[key] === undefined) return undefined;
  return requireString(record, key, toolName, { allowEmpty: false });
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  _toolName: string,
  max?: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolArgumentError(`${key} must be a positive integer. Not executed.`);
  }
  if (max !== undefined && value > max) {
    throw new ToolArgumentError(`${key} must be between 1 and ${max}. Not executed.`);
  }
  return value;
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  _toolName: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolArgumentError(`${key} must be a boolean. Not executed.`);
  }
  return value;
}

// T13: 模型可见描述、参数 Schema 与报错模板尚未定稿，以下均为引擎占位。
const readTool = defineTool<ReadArguments>({
  name: "read",
  description: "",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "File path relative to the workspace or absolute.",
      },
      offset: {
        type: "integer",
        minimum: 1,
        default: 1,
        description: "First line to read, starting at 1.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        default: 2000,
        description: "Maximum number of lines to return.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "read");
    checkAllowedKeys(record, ["path", "offset", "limit"], "read");
    const path = requireString(record, "path", "read", { allowEmpty: false });
    const offset = optionalPositiveInteger(record, "offset", "read") ?? 1;
    const limit = optionalPositiveInteger(record, "limit", "read", READ_MAX_LIMIT) ?? READ_DEFAULT_LIMIT;
    return { path, offset, limit };
  },
  prepare(args, context) {
    const error = validateReadPathBudget(args);
    if (error) throw new ToolArgumentError(error);
    const target = context.pathPolicy.resolve(args.path);
    return {
      action: { type: "read", paths: [target] },
      execute: () => readFileRange(args, target, withPathCheck(context, target)),
    };
  },
});

const globTool = defineTool<GlobArguments>({
  name: "glob",
  description: "",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description:
          "Case-sensitive glob pattern relative to path, e.g. '**/*.ts', 'src/*.{ts,tsx}', or 'src'. Supports *, ?, character classes, brace expansion, and ** directory segments. Use '/' separators. No absolute paths, '..' segments, backslashes, NUL, negation patterns, or extglobs.",
      },
      path: {
        type: "string",
        minLength: 1,
        description: "Search directory, workspace-relative or absolute. Defaults to the workspace root.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "glob");
    checkAllowedKeys(record, ["pattern", "path"], "glob");
    const pattern = requireString(record, "pattern", "glob", { allowEmpty: false });
    const invalid = validateGlobPattern(pattern);
    if (invalid) throw new ToolArgumentError(invalid);
    return { pattern, path: optionalString(record, "path", "glob") };
  },
  prepare(args, context) {
    const scope = context.pathPolicy.resolve(args.path ?? ".");
    return {
      action: { type: "read", paths: [scope] },
      execute: () => searchGlob(args, scope, withPathCheck(context, scope)),
    };
  },
});

const grepTool = defineTool<GrepArguments>({
  name: "grep",
  description: "",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description:
          "Regular expression to search for. Matching is case-sensitive by default. Use (?i) for case-insensitive matching.",
      },
      path: {
        type: "string",
        minLength: 1,
        description:
          "File or directory relative to the workspace or absolute. Defaults to the workspace root.",
      },
      glob: {
        type: "string",
        minLength: 1,
        description: "File filter glob, for example '*.ts'.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        default: 100,
        description: "Maximum number of matching lines to return.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "grep");
    checkAllowedKeys(record, ["pattern", "path", "glob", "limit"], "grep");
    const pattern = requireString(record, "pattern", "grep", { allowEmpty: false });
    const path = optionalString(record, "path", "grep");
    return {
      pattern,
      path,
      glob: optionalString(record, "glob", "grep"),
      limit: optionalPositiveInteger(record, "limit", "grep", 500) ?? 100,
    };
  },
  prepare(args, context) {
    const target = context.pathPolicy.resolve(args.path ?? ".");
    return {
      action: { type: "read", paths: [target] },
      execute: () => searchFiles(args, target, withPathCheck(context, target)),
    };
  },
});

const writeTool = defineTool<WriteArguments>({
  name: "write",
  description: "",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "File path relative to the workspace or absolute.",
      },
      content: {
        type: "string",
        description:
          "Complete new file content. Empty creates or overwrites with an empty file. Maximum 400000 characters. Must contain valid Unicode without NUL.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "write");
    checkAllowedKeys(record, ["path", "content"], "write");
    const path = requireString(record, "path", "write", { allowEmpty: false });
    const content = requireString(record, "content", "write", { allowEmpty: true });
    return { path, content };
  },
  prepare(args, context) {
    const target = context.pathPolicy.resolve(args.path);
    return {
      action: {
        type: "write",
        path: target,
        operation: target.exists ? "overwrite" : "create",
      },
      execute: () => writeFileContent(args, target, withPathCheck(context, target)),
    };
  },
});

const editTool = defineTool<EditArguments>({
  name: "edit",
  description: "",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Existing file path relative to the workspace or absolute.",
      },
      old_string: {
        type: "string",
        minLength: 1,
        description:
          "Exact text to replace after newline normalization. Maximum 100000 characters before normalization. Must contain valid Unicode without NUL.",
      },
      new_string: {
        type: "string",
        description:
          "Replacement text; empty deletes the match. Maximum 100000 characters before normalization. Must contain valid Unicode without NUL.",
      },
      replace_all: {
        type: "boolean",
        default: false,
        description: "Replace all matches. When false, exactly one match is required.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "edit");
    checkAllowedKeys(record, ["path", "old_string", "new_string", "replace_all"], "edit");
    const path = requireString(record, "path", "edit", { allowEmpty: false });
    const oldString = requireString(record, "old_string", "edit", { allowEmpty: false });
    const newString = requireString(record, "new_string", "edit", { allowEmpty: true });
    const replaceAll = optionalBoolean(record, "replace_all", "edit") ?? false;
    return { path, oldString, newString, replaceAll };
  },
  prepare(args, context) {
    const target = context.pathPolicy.resolve(args.path);
    return {
      action: { type: "write", path: target, operation: "edit" },
      execute: () => editFileContent(args, target, withPathCheck(context, target)),
    };
  },
});

const viewImageTool = defineTool<ViewImageArguments>({
  name: "view_image",
  description: "",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Image file path relative to the workspace or absolute.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  parseArguments(raw) {
    const record = toRecord(raw, "view_image");
    checkAllowedKeys(record, ["path"], "view_image");
    return { path: requireString(record, "path", "view_image", { allowEmpty: false }) };
  },
  prepare(args, context) {
    const target = context.pathPolicy.resolve(args.path);
    return {
      action: { type: "read", paths: [target] },
      execute: () => viewImageFile(args, target, withPathCheck(context, target)),
    };
  },
});

interface ShellArguments {
  command: string;
  timeout: number;
}

function createShellTool(shell: ShellDescriptor): RegisteredTool {
  return defineTool<ShellArguments>({
    name: shell.kind,
    description: "",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          minLength: 1,
          description: "Bash command to run in the workspace root.",
        },
        timeout: {
          type: "integer",
          minimum: 1,
          maximum: 1200,
          default: 120,
          description: "Execution timeout in seconds. Defaults to 120. Maximum 1200.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parseArguments(raw) {
      const record = toRecord(raw, shell.kind);
      checkAllowedKeys(record, ["command", "timeout"], shell.kind);
      const command = requireString(record, "command", shell.kind, { allowEmpty: false });
      return {
        command,
        timeout:
          optionalPositiveInteger(record, "timeout", shell.kind, 1200) ?? DEFAULT_SHELL_TIMEOUT_MS / 1000,
      };
    },
    prepare(args, context) {
      return {
          action: { type: "shell", command: args.command, shellExecutable: shell.executable },
        execute: async () => {
          const result = await runShellCommand(args.command, {
            cwd: context.workspaceRoot,
            shell,
            timeoutMs: args.timeout * 1000,
            signal: context.signal,
            onDiagnostic: context.onDiagnostic,
            onPendingShell: context.onPendingShell,
            onOutput: context.onOutput,
            spawnProcess: context.spawnProcess,
            terminateTree: context.terminateTree,
            killConfirmTimeoutMs: context.killConfirmTimeoutMs,
            platform: context.platform,
          });
          return shellResultToOutcome(result, args.timeout * 1000);
        },
      };
    },
  });
}

export function createToolRegistry(
  platform: NodeJS.Platform = process.platform,
  settings: Pick<
    Settings,
    "editMaxFileBytes" | "viewImageMaxBytes" | "globTimeoutMs" | "grepStderrMaxChars"
  > = parseSettings(undefined),
  prompts: PromptBundle = loadPrompts(),
  imageInput = false,
): ToolRegistry {
  const shell = detectShell(platform);
  const tools = [readTool, globTool, grepTool, writeTool, editTool, createShellTool(shell)];
  // 无视觉能力时工具集中不存在 view_image，幻觉调用走既有 Unknown tool 错误。
  if (imageInput) tools.push(viewImageTool);
  return new ToolRegistry(
    tools.map((tool) => ({
      ...tool,
      description: prompts.tools[tool.name]!
        .replaceAll("{editMaxFileBytes}", String(settings.editMaxFileBytes))
        .replaceAll("{viewImageMaxBytes}", String(settings.viewImageMaxBytes)),
    })),
  );
}
