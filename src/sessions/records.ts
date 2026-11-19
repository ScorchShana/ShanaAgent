import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import path from "node:path";

import type { ArgumentParse } from "../llm/argument-parser.js";
import { hasNonFiniteNumber } from "../llm/argument-parser.js";

export interface StoredToolCall {
  type: "toolCall";
  id: string;
  name: string;
  rawArguments: string;
  parse: ArgumentParse;
}
export type StoredAssistantMessage = Omit<AssistantMessage, "content"> & {
  content: (Exclude<AssistantMessage["content"][number], { type: "toolCall" }> | StoredToolCall)[];
};

export const SESSION_FORMAT_VERSION = 5;

export const SESSION_RECORD_TYPES = [
  "user_prompt",
  "run_started",
  "assistant_message",
  "tool_result",
  "interruption",
  "run_finished",
  "checkpoint",
] as const;
export type SessionRecordType = (typeof SESSION_RECORD_TYPES)[number];

export const TOOL_RESULT_STATUSES = [
  "success",
  "error",
  "denied",
  "timeout",
  "not_executed",
  "unknown",
] as const;
export type ToolResultStatus = (typeof TOOL_RESULT_STATUSES)[number];

export const DEFINITE_TOOL_RESULT_STATUSES = [
  "success",
  "error",
  "denied",
  "timeout",
  "not_executed",
] as const;
export type DefiniteToolResultStatus = (typeof DEFINITE_TOOL_RESULT_STATUSES)[number];

export function isDefiniteToolResultStatus(status: ToolResultStatus): status is DefiniteToolResultStatus {
  return (DEFINITE_TOOL_RESULT_STATUSES as readonly string[]).includes(status);
}

export const SESSION_RUN_OUTCOMES = ["completed", "cancelled", "failed", "turn_limit"] as const;
export type SessionRunOutcome = (typeof SESSION_RUN_OUTCOMES)[number];

export interface SessionMeta {
  version: number;
  sessionId: string;
  workspaceId: string;
  createdAt: string;
  sourceSessionId?: string;
  autoDecisionEnabled?: boolean;
}

interface RecordBase {
  recordSeq: number;
  ts: string;
  version?: number;
}

// skill 名唯一字符集（大小写敏感）：加载器与记录校验共用，同时拒绝 ../、绝对路径与 NUL。
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// 提交时快照：content 为剥 frontmatter 后正文，location 为 SKILL.md realpath 绝对路径。
// 渲染展开是 (text, skill) 的纯函数，压缩/回放天然同构，无需重读磁盘。
export interface SkillSnapshot {
  name: string;
  location: string;
  content: string;
}

export interface UserPromptRecord extends RecordBase {
  type: "user_prompt";
  runId?: string;
  // 恒存用户完整原文（含 /skill:name 命令行）；skill 仅在显式调用时快照。
  text: string;
  skill?: SkillSnapshot;
}

export interface RunModelSnapshot {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  // 仅旧记录可能缺失；新记录由 createModelSnapshot 写入。
  reasoning?: boolean;
  thinking: boolean;
  reasoningEffort: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}

export interface AgentsMdReference {
  path: string;
  present: boolean;
  // 仅旧记录可能出现；新记录只写 path 与 present。
  sha256?: string;
}

export interface RunStartedRecord extends RecordBase {
  type: "run_started";
  runId: string;
  model: RunModelSnapshot;
  settings: JsonObject;
  agentsMd: AgentsMdReference;
}

export interface AssistantMessageRecord extends RecordBase {
  type: "assistant_message";
  runId: string;
  message: StoredAssistantMessage;
}

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface ToolResultImage {
  // base64 原文不脱敏（图像数据非凭据）；宽高仅供估算与 TUI，wire 消息块不带宽高。
  data: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export interface ToolResultRecord extends RecordBase {
  type: "tool_result";
  runId: string;
  assistantRecordSeq: number;
  toolCallId: string;
  toolName: string;
  status: ToolResultStatus;
  content: string;
  // write/edit 写入前旧文件全量快照，仅供 TUI 历史 Diff，不进入 LLM Context
  priorContent?: string;
  // 仅 view_image 成功读取产出；恒单图。解析层只校形态，语义由工具层保证。
  images?: ToolResultImage[];
}

export interface InterruptionRecord extends RecordBase {
  type: "interruption";
  runId?: string;
  toolCallId?: string;
  reason: string;
  detail?: string;
}

export interface RunFinishedRecord extends RecordBase {
  elapsedMs?: number;
  type: "run_finished";
  runId: string;
  outcome: SessionRunOutcome;
  // 与 run.finished 事件同名：落盘记录恒为 true；写入失败时不会产生记录，由事件标注 false。
  persisted: boolean;
  error?: string;
}

export interface CheckpointModelRef {
  providerId: string;
  modelId: string;
}

// 生成摘要那次请求自身的实测用量：Cache/Speed 需要跨重启与 /resume 累积，只能靠落盘。
// durationMs 缺省表示 Provider 未报告耗时，此时只计 token、不计速度（不补零冒充测量）。
export interface CheckpointUsage {
  input: number;
  cacheRead: number;
  output: number;
  durationMs?: number;
}

export interface CheckpointRecord extends RecordBase {
  type: "checkpoint";
  summary: string;
  coveredUpTo: number;
  model: CheckpointModelRef;
  promptVersion?: string;
  usage?: CheckpointUsage;
}

export type SessionRecord =
  | UserPromptRecord
  | RunStartedRecord
  | AssistantMessageRecord
  | ToolResultRecord
  | InterruptionRecord
  | RunFinishedRecord
  | CheckpointRecord;

type WithoutCommon<T> = T extends unknown ? Omit<T, "recordSeq" | "ts" | "version"> : never;
export type NewSessionRecord = WithoutCommon<SessionRecord>;

export class RecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordValidationError";
  }
}

function fail(scope: string, message: string): never {
  throw new RecordValidationError(`${scope}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(raw: Record<string, unknown>, allowed: readonly string[], scope: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) fail(scope, `未知字段 "${key}"`);
  }
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  scope: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = raw[key];
  if (typeof value !== "string") fail(scope, `"${key}" 必须是字符串`);
  if (options.allowEmpty === false && value.length === 0) {
    fail(scope, `"${key}" 不能为空字符串`);
  }
  return value;
}

function optionalString(raw: Record<string, unknown>, key: string, scope: string): void {
  if (raw[key] !== undefined) requireString(raw, key, scope);
}

function requireBoolean(raw: Record<string, unknown>, key: string, scope: string): boolean {
  const value = raw[key];
  if (typeof value !== "boolean") fail(scope, `"${key}" 必须是布尔值`);
  return value;
}

function requireInteger(raw: Record<string, unknown>, key: string, scope: string): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(scope, `"${key}" 必须是整数`);
  }
  return value;
}

function requireEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  scope: string,
): T {
  const value = raw[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(scope, `"${key}" 必须是 ${allowed.join(" | ")} 之一`);
  }
  return value as T;
}

const META_KEYS = [
  "version",
  "sessionId",
  "workspaceId",
  "createdAt",
  "sourceSessionId",
  "autoDecisionEnabled",
] as const;

export function parseSessionMeta(raw: unknown): SessionMeta {
  const scope = "meta.json";
  if (!isPlainObject(raw)) fail(scope, "顶层必须是对象");
  checkKeys(raw, META_KEYS, scope);
  const version = requireInteger(raw, "version", scope);
  if (version !== SESSION_FORMAT_VERSION) {
    fail(scope, `版本 ${version} 不受支持（当前支持 ${SESSION_FORMAT_VERSION}）`);
  }
  const sessionId = requireString(raw, "sessionId", scope, { allowEmpty: false });
  const workspaceId = requireString(raw, "workspaceId", scope, { allowEmpty: false });
  const createdAt = requireString(raw, "createdAt", scope, { allowEmpty: false });
  if (Number.isNaN(Date.parse(createdAt))) fail(scope, `"createdAt" 不是有效时间`);
  const meta: SessionMeta = { version, sessionId, workspaceId, createdAt };
  if (raw.sourceSessionId !== undefined) {
    meta.sourceSessionId = requireString(raw, "sourceSessionId", scope, { allowEmpty: false });
  }
  if (Object.hasOwn(raw, "autoDecisionEnabled")) {
    meta.autoDecisionEnabled = requireBoolean(raw, "autoDecisionEnabled", scope);
  }
  return meta;
}

const RUN_MODEL_KEYS = [
  "providerId",
  "providerName",
  "modelId",
  "modelName",
  "reasoning",
  "thinking",
  "reasoningEffort",
  "input",
  "contextWindow",
  "maxTokens",
] as const;

function parseRunModelSnapshot(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"model" 必须是对象');
  checkKeys(raw, RUN_MODEL_KEYS, scope);
  requireString(raw, "providerId", scope, { allowEmpty: false });
  requireString(raw, "providerName", scope);
  requireString(raw, "modelId", scope, { allowEmpty: false });
  requireString(raw, "modelName", scope);
  if (raw.reasoning !== undefined) requireBoolean(raw, "reasoning", scope);
  requireBoolean(raw, "thinking", scope);
  requireString(raw, "reasoningEffort", scope);
  const input = raw.input;
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
    fail(scope, '"input" 必须是字符串数组');
  }
  for (const key of ["contextWindow", "maxTokens"]) {
    if (requireInteger(raw, key, scope) <= 0) fail(scope, `"${key}" 必须为正整数`);
  }
}

function parseAgentsMdReference(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"agentsMd" 必须是对象');
  checkKeys(raw, ["path", "present", "sha256"], scope);
  requireString(raw, "path", scope, { allowEmpty: false });
  requireBoolean(raw, "present", scope);
  optionalString(raw, "sha256", scope);
}

const STOP_REASONS = ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"] as const;

function parseAssistantMessage(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"message" 必须是对象');
  if (raw.role !== "assistant") fail(scope, '"message.role" 必须是 "assistant"');
  for (const key of ["api", "provider", "model"]) requireString(raw, key, scope, { allowEmpty: false });
  const content = raw.content;
  if (!Array.isArray(content)) fail(scope, '"message.content" 必须是数组');
  for (const block of content) {
    if (!isPlainObject(block)) fail(scope, '"message.content" 项必须是对象');
    if (block.type === "text") {
      if (typeof block.text !== "string") fail(scope, "text 块缺少字符串 text");
    } else if (block.type === "thinking") {
      if (typeof block.thinking !== "string") fail(scope, "thinking 块缺少字符串 thinking");
    } else if (block.type === "toolCall") {
      requireString(block, "id", scope);
      requireString(block, "name", scope);
      checkKeys(block, ["type", "id", "name", "rawArguments", "parse"], scope);
      requireString(block, "rawArguments", scope);
      if (!isPlainObject(block.parse)) fail(scope, "toolCall 缺少 parse");
      if (block.parse.status === "parsed") {
        checkKeys(block.parse, ["status", "arguments"], scope);
        if (!isPlainObject(block.parse.arguments)) fail(scope, "parsed 必须包含参数对象");
        if (hasNonFiniteNumber(block.parse.arguments)) fail(scope, "parsed 参数不能包含非有限数值");
      } else {
        checkKeys(block.parse, ["status", "error"], scope);
        if (block.parse.status !== "invalid") fail(scope, "未知 parse 状态");
        requireEnum(
          block.parse,
          "error",
          ["syntax", "incomplete", "duplicate_key", "not_object", "non_finite_number"],
          scope,
        );
      }
    } else {
      fail(scope, `未知 content 块类型 ${JSON.stringify(block.type)}`);
    }
  }
  if (!isPlainObject(raw.usage)) fail(scope, '"message.usage" 必须是对象');
  requireEnum(raw, "stopReason", STOP_REASONS, scope);
  if (typeof raw.timestamp !== "number" || !Number.isFinite(raw.timestamp)) {
    fail(scope, '"message.timestamp" 必须是数字');
  }
}

// base64 硬上限对应 settings 可配的最大 viewImageMaxBytes；运行期读取按实际配置收紧。
const IMAGE_BASE64_MAX_DECODED_BYTES = 16_777_216;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function parseToolResultImages(raw: unknown, scope: string): void {
  if (!Array.isArray(raw) || raw.length !== 1) fail(scope, '"images" 必须是恰含 1 项的数组');
  const image = raw[0];
  if (!isPlainObject(image)) fail(scope, '"images" 项必须是对象');
  checkKeys(image, ["data", "mimeType", "width", "height"], scope);
  const data = requireString(image, "data", scope, { allowEmpty: false });
  if (!BASE64_PATTERN.test(data) || data.length % 4 !== 0) {
    fail(scope, '"images.data" 必须是合法 base64（长度为 4 的倍数）');
  }
  if (Buffer.byteLength(data, "base64") > IMAGE_BASE64_MAX_DECODED_BYTES) {
    fail(scope, `"images.data" 解码后不得超过 ${IMAGE_BASE64_MAX_DECODED_BYTES} 字节`);
  }
  requireEnum(image, "mimeType", IMAGE_MIME_TYPES, scope);
  for (const key of ["width", "height"] as const) {
    const value = image[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      fail(scope, `"images.${key}" 必须是正安全整数`);
    }
  }
}

function parseCheckpointModel(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"model" 必须是对象');
  checkKeys(raw, ["providerId", "modelId"], scope);
  requireString(raw, "providerId", scope, { allowEmpty: false });
  requireString(raw, "modelId", scope, { allowEmpty: false });
}

// 摘要请求用量：token 为非负有限数，durationMs 允许小数（实测耗时不做取整）。
function parseCheckpointUsage(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"usage" 必须是对象');
  checkKeys(raw, ["input", "cacheRead", "output", "durationMs"], scope);
  for (const key of ["input", "cacheRead", "output"] as const) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(scope, `"usage.${key}" 必须是非负有限数`);
    }
  }
  const durationMs = raw.durationMs;
  if (
    durationMs !== undefined &&
    (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)
  ) {
    fail(scope, '"usage.durationMs" 必须是非负有限数');
  }
}

function parseSkillSnapshot(raw: unknown, scope: string): void {
  if (!isPlainObject(raw)) fail(scope, '"skill" 必须是对象');
  checkKeys(raw, ["name", "location", "content"], scope);
  const name = requireString(raw, "name", scope, { allowEmpty: false });
  if (!SKILL_NAME_PATTERN.test(name)) fail(scope, '"skill.name" 含非法字符');
  const location = requireString(raw, "location", scope, { allowEmpty: false });
  // 会话文件可能跨平台拷贝，两种绝对路径形态都接受。
  if (!path.win32.isAbsolute(location) && !path.posix.isAbsolute(location)) {
    fail(scope, '"skill.location" 必须是绝对路径');
  }
  requireString(raw, "content", scope);
}

const COMMON_KEYS = ["recordSeq", "ts", "type", "runId", "version"] as const;
const TYPE_KEYS: Record<SessionRecordType, readonly string[]> = {
  user_prompt: ["text", "skill"],
  run_started: ["model", "settings", "agentsMd"],
  assistant_message: ["message"],
  tool_result: [
    "assistantRecordSeq",
    "toolCallId",
    "toolName",
    "status",
    "content",
    "priorContent",
    "images",
  ],
  interruption: ["toolCallId", "reason", "detail"],
  run_finished: ["outcome", "persisted", "error", "elapsedMs"],
  checkpoint: ["summary", "coveredUpTo", "model", "promptVersion", "usage"],
};

export interface ParseRecordOptions {
  expectVersion: boolean;
}

export function parseSessionRecord(raw: unknown, options: ParseRecordOptions): SessionRecord {
  const scope = "messages.jsonl 记录";
  if (!isPlainObject(raw)) fail(scope, "记录必须是 JSON 对象");
  const typeValue = raw.type;
  if (typeof typeValue !== "string" || !(SESSION_RECORD_TYPES as readonly string[]).includes(typeValue)) {
    fail(scope, `"type" 必须是 ${SESSION_RECORD_TYPES.join(" | ")} 之一`);
  }
  const type = typeValue as SessionRecordType;
  if (requireInteger(raw, "recordSeq", scope) < 1) fail(scope, '"recordSeq" 必须从 1 开始');
  if (Number.isNaN(Date.parse(requireString(raw, "ts", scope, { allowEmpty: false })))) {
    fail(scope, '"ts" 不是有效时间');
  }
  optionalString(raw, "runId", scope);
  if (options.expectVersion) {
    if (raw.version === undefined) fail(scope, '首条记录缺少 "version"');
    if (raw.version !== SESSION_FORMAT_VERSION) {
      fail(scope, `版本 ${String(raw.version)} 不受支持（当前支持 ${SESSION_FORMAT_VERSION}）`);
    }
  } else if (raw.version !== undefined) {
    fail(scope, '仅首条记录允许 "version"');
  }
  checkKeys(raw, [...COMMON_KEYS, ...TYPE_KEYS[type]], scope);

  switch (type) {
    case "user_prompt":
      requireString(raw, "text", scope);
      if (raw.skill !== undefined) parseSkillSnapshot(raw.skill, scope);
      break;
    case "run_started":
      if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        fail(scope, 'run_started 必须携带 "runId"');
      }
      parseRunModelSnapshot(raw.model, scope);
      if (!isPlainObject(raw.settings)) fail(scope, '"settings" 必须是对象');
      parseAgentsMdReference(raw.agentsMd, scope);
      break;
    case "assistant_message":
      if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        fail(scope, 'assistant_message 必须携带 "runId"');
      }
      parseAssistantMessage(raw.message, scope);
      break;
    case "tool_result": {
      if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        fail(scope, 'tool_result 必须携带 "runId"');
      }
      requireString(raw, "toolCallId", scope, { allowEmpty: false });
      requireString(raw, "toolName", scope, { allowEmpty: false });
      const ownerSeq = requireInteger(raw, "assistantRecordSeq", scope);
      if (ownerSeq < 1 || ownerSeq >= (raw.recordSeq as number)) fail(scope, "结果必须引用先前 Assistant");
      requireEnum(raw, "status", TOOL_RESULT_STATUSES, scope);
      requireString(raw, "content", scope);
      optionalString(raw, "priorContent", scope);
      if (raw.images !== undefined) parseToolResultImages(raw.images, scope);
      break;
    }
    case "interruption":
      requireString(raw, "reason", scope, { allowEmpty: false });
      optionalString(raw, "toolCallId", scope);
      optionalString(raw, "detail", scope);
      break;
    case "run_finished":
      if (typeof raw.runId !== "string" || raw.runId.length === 0) {
        fail(scope, 'run_finished 必须携带 "runId"');
      }
      if (
        raw.elapsedMs !== undefined &&
        (typeof raw.elapsedMs !== "number" || !Number.isSafeInteger(raw.elapsedMs) || raw.elapsedMs < 0)
      ) {
        fail(scope, '"elapsedMs" 必须是非负安全整数');
      }
      requireEnum(raw, "outcome", SESSION_RUN_OUTCOMES, scope);
      requireBoolean(raw, "persisted", scope);
      optionalString(raw, "error", scope);
      break;
    case "checkpoint":
      requireString(raw, "summary", scope, { allowEmpty: false });
      if (requireInteger(raw, "coveredUpTo", scope) < 0) {
        fail(scope, '"coveredUpTo" 必须是非负整数');
      }
      parseCheckpointModel(raw.model, scope);
      optionalString(raw, "promptVersion", scope);
      // usage 记录层可选：仅新 checkpoint 写入，旧/失败请求不补零。
      if (raw.usage !== undefined) parseCheckpointUsage(raw.usage, scope);
      break;
  }
  return raw as unknown as SessionRecord;
}

export function toolCallsOfMessage(message: StoredAssistantMessage): StoredToolCall[] {
  return message.content.filter((block): block is StoredToolCall => block.type === "toolCall");
}

// 用户中断的响应可能含半截 toolCall（id/name 缺失或 id 重复），它们从未执行、无法配对结果。
// History 保留原文供审计；构建上下文时剥离这些块，避免 prepareReplay 因非法 tool 身份抛错。
export function normalizeAbortedMessage(message: StoredAssistantMessage): StoredAssistantMessage {
  if (message.stopReason !== "aborted") return message;
  const seen = new Set<string>();
  const content = message.content.filter((block) => {
    if (block.type !== "toolCall") return true;
    if (!block.id || !block.name || seen.has(block.id)) return false;
    seen.add(block.id);
    return true;
  });
  return { ...message, content };
}

// 上下文完整性（区别于审计事实）：每个合法 call 有唯一配对结果（任意 status，含 unknown），
// 或无结果——缺结果只可能来自崩溃窗口（正常/取消路径每个 call 必落盘结果），
// 构建上下文时合成显式 unknown 占位，不落盘、不写成确定态。门控仍按记录判定，不受此函数影响。
export function isTurnContextComplete(
  assistant: AssistantMessageRecord,
  results: readonly ToolResultRecord[],
): boolean {
  const stop = assistant.message.stopReason;
  if (stop !== "stop" && stop !== "toolUse" && stop !== "length" && stop !== "aborted") return false;
  const message = stop === "aborted" ? normalizeAbortedMessage(assistant.message) : assistant.message;
  const calls = toolCallsOfMessage(message);
  if (calls.length === 0 && stop !== "stop" && stop !== "aborted") return false;
  if (
    calls.some((call) => !call.id || !call.name) ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  )
    return false;
  const owned = results.filter((result) => result.assistantRecordSeq === assistant.recordSeq);
  const callIds = new Set(calls.map((call) => call.id));
  // 多余结果（引用不存在的 call）属协议损坏，不因其存在而放行。
  if (owned.some((result) => !callIds.has(result.toolCallId))) return false;
  return calls.every((call) => {
    const matching = owned.filter((result) => result.toolCallId === call.id);
    if (matching.length === 0) return true;
    return (
      matching.length === 1 &&
      matching[0]!.runId === assistant.runId &&
      matching[0]!.toolName === call.name &&
      matching[0]!.recordSeq > assistant.recordSeq
    );
  });
}

export function validateResultReference(result: ToolResultRecord, records: readonly SessionRecord[]): void {
  const owner = records.find((record) => record.recordSeq === result.assistantRecordSeq);
  if (
    !owner ||
    owner.type !== "assistant_message" ||
    owner.runId !== result.runId ||
    !toolCallsOfMessage(owner.message).some(
      (call) => call.id === result.toolCallId && call.name === result.toolName,
    )
  ) {
    throw new RecordValidationError("tool_result: 无效的 Assistant 调用引用");
  }
}
