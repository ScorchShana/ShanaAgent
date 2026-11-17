import type { StoredContext } from "../llm/history-replay.js";
import fs from "node:fs";
import path from "node:path";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  isTurnComplete,
  toolCallsOfMessage,
  type AgentsMdReference,
  type AssistantMessageRecord,
  type CheckpointRecord,
  type SessionRecord,
  type ToolResultRecord,
  type UserPromptRecord,
} from "../sessions/records.js";
import {
  findLatestCheckpoint,
  responseExclusionReason,
  type ResponseExclusionReason,
} from "../sessions/recovery.js";

export type TurnExclusionReason =
  ResponseExclusionReason | "unknown_side_effect" | "incomplete_results" | "follows_incomplete_turn";

export interface EligibleTurn {
  assistant: AssistantMessageRecord;
  results: ToolResultRecord[];
}

export interface ExcludedTurn {
  assistant: AssistantMessageRecord;
  reason: TurnExclusionReason;
  // 触发排除的 Tool Call：缺失结果或结果 unknown；follows_incomplete_turn 时为空。
  toolCallIds: string[];
}

export interface RunPlan {
  prompt: UserPromptRecord | null;
  promptIncluded: boolean;
  turns: EligibleTurn[];
  excludedTurns: ExcludedTurn[];
}

export interface EffectiveContextPlan {
  checkpoint: CheckpointRecord | null;
  coveredUpTo: number;
  runs: RunPlan[];
}

export interface TokenEstimateOptions {
  asciiCharsPerToken: number;
  nonAsciiCharsPerToken: number;
}

// 请求可行性的固定余量，不进 settings.json。
export const CONTEXT_SAFETY_MARGIN_TOKENS = 4096;

// 近似估算，不依赖 Provider tokenizer；仅用于预算与压缩阈值判断。
export function estimateTokens(text: string, options: TokenEstimateOptions): number {
  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 0x80) asciiChars += 1;
    else nonAsciiChars += 1;
  }
  return Math.ceil(
    asciiChars / options.asciiCharsPerToken + nonAsciiChars / options.nonAsciiCharsPerToken,
  );
}

export function estimateMessageTokens(
  message: StoredContext["messages"][number],
  options: TokenEstimateOptions,
): number {
  const content = message.content;
  if (typeof content === "string") return estimateTokens(content, options);
  let total = 0;
  for (const block of content) {
    if (block.type === "text") total += estimateTokens(block.text, options);
    else if (block.type === "thinking") total += estimateTokens(block.thinking, options);
    else if (block.type === "toolCall") total += estimateTokens(block.rawArguments, options);
  }
  return total;
}

// 统计实际发送给 Provider 的内容：系统提示词、消息、工具 Schema；
// 时间戳、usage、priorContent 等未发送字段不计入。
export function estimateContextTokens(
  context: StoredContext,
  options: TokenEstimateOptions,
): number {
  let total = context.systemPrompt === undefined ? 0 : estimateTokens(context.systemPrompt, options);
  for (const message of context.messages) total += estimateMessageTokens(message, options);
  if (context.tools !== undefined && context.tools.length > 0) {
    total += estimateTokens(JSON.stringify(context.tools), options);
  }
  return total;
}

export function isRequestFeasible(estimatedTokens: number, contextWindow: number): boolean {
  return estimatedTokens + CONTEXT_SAFETY_MARGIN_TOKENS <= contextWindow;
}

export function reachesCompactionThreshold(
  estimatedTokens: number,
  contextWindow: number,
  thresholdRatio: number,
): boolean {
  return estimatedTokens >= contextWindow * thresholdRatio;
}

type TurnClassification =
  | { kind: "eligible"; results: ToolResultRecord[] }
  | { kind: "excluded"; reason: TurnExclusionReason; toolCallIds: string[] };

function classifyTurn(
  assistant: AssistantMessageRecord,
  toolResults: readonly ToolResultRecord[],
): TurnClassification {
  const calls = toolCallsOfMessage(assistant.message);
  const callIds = new Set(calls.map((call) => call.id));
  const matching = toolResults.filter(
    (result) =>
      result.assistantRecordSeq === assistant.recordSeq &&
      result.runId === assistant.runId &&
      callIds.has(result.toolCallId),
  );
  const missingToolCallIds = calls
    .filter((call) => !matching.some((result) => result.toolCallId === call.id))
    .map((call) => call.id);
  const unknownToolCallIds = [
    ...new Set(matching.filter((result) => result.status === "unknown").map((result) => result.toolCallId)),
  ];

  const exclusion = responseExclusionReason(assistant);
  if (exclusion !== null) {
    return {
      kind: "excluded",
      reason: exclusion,
      toolCallIds: exclusion === "truncated" ? missingToolCallIds : [],
    };
  }
  if (unknownToolCallIds.length > 0) {
    return { kind: "excluded", reason: "unknown_side_effect", toolCallIds: unknownToolCallIds };
  }
  if (!isTurnComplete(assistant, toolResults)) {
    return { kind: "excluded", reason: "incomplete_results", toolCallIds: missingToolCallIds };
  }
  return {
    kind: "eligible",
    results: calls.map((call) => matching.find((result) => result.toolCallId === call.id)!),
  };
}

export function planEffectiveContext(records: readonly SessionRecord[]): EffectiveContextPlan {
  const checkpoint = findLatestCheckpoint(records);
  const coveredUpTo = checkpoint?.coveredUpTo ?? 0;
  const toolResults = records.filter((record): record is ToolResultRecord => record.type === "tool_result");
  const runs: RunPlan[] = [];
  let current: RunPlan | null = null;
  let blockedReason: TurnExclusionReason | null = null;

  for (const record of records) {
    if (record.recordSeq <= coveredUpTo) continue;

    if (record.type === "user_prompt") {
      current = { prompt: record, promptIncluded: false, turns: [], excludedTurns: [] };
      runs.push(current);
      blockedReason = null;
      continue;
    }
    if (record.type !== "assistant_message") continue;

    if (current === null) {
      current = { prompt: null, promptIncluded: false, turns: [], excludedTurns: [] };
      runs.push(current);
    }
    if (blockedReason !== null) {
      current.excludedTurns.push({
        assistant: record,
        reason: "follows_incomplete_turn",
        toolCallIds: [],
      });
      continue;
    }

    const classification = classifyTurn(record, toolResults);
    if (classification.kind === "eligible") {
      current.turns.push({ assistant: record, results: classification.results });
    } else {
      current.excludedTurns.push({
        assistant: record,
        reason: classification.reason,
        toolCallIds: classification.toolCallIds,
      });
      blockedReason = classification.reason;
    }
  }

  // 失败 Run 的原始 Prompt 仅在至少一个完整 Turn 时进入上下文。
  for (const run of runs) {
    run.promptIncluded = run.prompt !== null && run.turns.length > 0;
  }

  return { checkpoint, coveredUpTo, runs };
}

export interface AgentsMdDeps {
  readFile?: (filePath: string) => Promise<string>;
}

export interface AgentsMdLoad {
  path: string;
  present: boolean;
  content?: string;
  readError?: string;
}

export async function loadRootAgentsMd(
  workspacePath: string,
  deps: AgentsMdDeps = {},
): Promise<AgentsMdLoad> {
  const filePath = path.join(workspacePath, "AGENTS.md");
  const readFile = deps.readFile ?? ((target: string) => fs.promises.readFile(target, "utf8"));
  try {
    const content = await readFile(filePath);
    return {
      path: filePath,
      present: true,
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { path: filePath, present: false };
    }
    return {
      path: filePath,
      present: true,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function toAgentsMdReference(load: AgentsMdLoad): AgentsMdReference {
  return {
    path: load.path,
    present: load.present,
  };
}

export type ContextBuildWarning = {
  kind: "agents_md_read_failed";
  path: string;
  message: string;
};

export interface BuildContextInput {
  records: readonly SessionRecord[];
  // 仅在开始新请求时追加；从已含当前 Prompt 的记录重建时省略，避免重复。
  currentPrompt?: string;
  workspacePath: string;
  systemPrompt?: string;
  // 仅提供环境正文；<environment> 区块由 buildContext 包裹。
  environment?: string;
  // 调用方传入的 Session 冻结快照；缺省时在本函数内读取一次（测试或独立调用）。
  agentsMd?: AgentsMdLoad;
  now?: () => Date;
}

export interface BuiltContext {
  context: StoredContext;
  plan: EffectiveContextPlan;
  agentsMd: AgentsMdLoad;
  warnings: ContextBuildWarning[];
}

function promptMessage(record: UserPromptRecord): UserMessage {
  return { role: "user", content: record.text, timestamp: Date.parse(record.ts) };
}

export function wrapConversationSummary(summary: string): string {
  return `<conversation_summary>\n${summary}\n</conversation_summary>`;
}

function summaryMessage(checkpoint: CheckpointRecord): UserMessage {
  return {
    role: "user",
    content: wrapConversationSummary(checkpoint.summary),
    timestamp: Date.parse(checkpoint.ts),
  };
}

function toolResultMessage(record: ToolResultRecord): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    content: [{ type: "text", text: record.content }],
    isError: record.status !== "success",
    timestamp: Date.parse(record.ts),
  };
}

function renderAgentsMd(load: AgentsMdLoad, warnings: ContextBuildWarning[]): string | null {
  if (!load.present) return null;
  if (load.readError !== undefined) {
    warnings.push({ kind: "agents_md_read_failed", path: load.path, message: load.readError });
    return null;
  }
  if (load.content === undefined) return null;
  const closingNewline = load.content.endsWith("\n") ? "" : "\n";
  return `<project_instructions>\n${load.content}${closingNewline}</project_instructions>`;
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const plan = planEffectiveContext(input.records);
  const agentsMd = input.agentsMd ?? (await loadRootAgentsMd(input.workspacePath));
  const warnings: ContextBuildWarning[] = [];
  const messages: StoredContext["messages"] = [];

  if (plan.checkpoint !== null) {
    messages.push(summaryMessage(plan.checkpoint));
  }
  for (const run of plan.runs) {
    if (run.promptIncluded && run.prompt !== null) {
      messages.push(promptMessage(run.prompt));
    }
    for (const turn of run.turns) {
      messages.push(turn.assistant.message);
      for (const result of turn.results) {
        messages.push(toolResultMessage(result));
      }
    }
  }
  if (input.currentPrompt !== undefined) {
    const now = input.now ?? (() => new Date());
    messages.push({
      role: "user",
      content: input.currentPrompt,
      timestamp: now().getTime(),
    });
  }

  const sections: string[] = [];
  const systemPrompt =
    input.systemPrompt ??
    new TextDecoder("utf-8", { fatal: true }).decode(
      await fs.promises.readFile(new URL("../../prompts/constitution.md", import.meta.url)),
    );
  if (systemPrompt.trim().length === 0 || systemPrompt.includes("\0")) {
    throw new Error("System prompt is empty or contains NUL.");
  }
  sections.push(systemPrompt);
  const environment = input.environment?.trim();
  if (environment !== undefined && environment.length > 0) {
    sections.push(`<environment>\n${environment}\n</environment>`);
  }
  const agentsSection = renderAgentsMd(agentsMd, warnings);
  if (agentsSection !== null) sections.push(agentsSection);

  const context: StoredContext = { messages };
  if (sections.length > 0) context.systemPrompt = sections.join("\n\n");

  return { context, plan, agentsMd, warnings };
}

export interface CompactionSelection {
  messages: StoredContext["messages"];
  coveredUpTo: number;
  previousSummary: string | null;
}

export interface PlanCompactionOptions {
  keepLatestTurn: boolean;
  retainedContextBudget: number;
  tokenEstimate: TokenEstimateOptions;
}

interface PlannedTurn {
  run: RunPlan;
  turn: EligibleTurn;
}

function turnBoundary(turn: EligibleTurn): number {
  let boundary = turn.assistant.recordSeq;
  for (const result of turn.results) boundary = Math.max(boundary, result.recordSeq);
  return boundary;
}

function estimateTurnTokens(turn: EligibleTurn, tokenEstimate: TokenEstimateOptions): number {
  let total = estimateMessageTokens(turn.assistant.message, tokenEstimate);
  for (const result of turn.results) {
    total += estimateMessageTokens(toolResultMessage(result), tokenEstimate);
  }
  return total;
}

// 提交前预校验候选覆盖边界；非法边界会让 /resume 直接失败。
export function assertCandidateCheckpointValid(
  records: readonly SessionRecord[],
  coveredUpTo: number,
): void {
  let lastSeq = 0;
  for (const record of records) lastSeq = Math.max(lastSeq, record.recordSeq);
  const candidate: CheckpointRecord = {
    type: "checkpoint",
    recordSeq: lastSeq + 1,
    ts: records[records.length - 1]?.ts ?? new Date(0).toISOString(),
    summary: "candidate",
    coveredUpTo,
    model: { providerId: "candidate", modelId: "candidate" },
  };
  findLatestCheckpoint([...records, candidate]);
}

export function planCompaction(
  records: readonly SessionRecord[],
  options: PlanCompactionOptions,
): CompactionSelection | { status: "noop" } {
  const plan = planEffectiveContext(records);
  const planned: PlannedTurn[] = [];
  for (const run of plan.runs) {
    for (const turn of run.turns) planned.push({ run, turn });
  }
  if (planned.length === 0) return { status: "noop" };

  let tailStart = planned.length;
  if (options.keepLatestTurn) {
    // Prompt 只有在所属 Run 没有 Turn 被覆盖时才留在重建后的 Context 里；
    // 保留预算按此归属计入，否则会高估尾部成本而少保留 Turn。
    const firstTurnOfRun = new Map<RunPlan, number>();
    for (const [index, entry] of planned.entries()) {
      if (!firstTurnOfRun.has(entry.run)) firstTurnOfRun.set(entry.run, index);
    }
    const promptTokens = (run: RunPlan) =>
      run.prompt === null ? 0 : estimateTokens(run.prompt.text, options.tokenEstimate);

    const latestIndex = planned.length - 1;
    const latest = planned[latestIndex]!;
    tailStart = latestIndex;
    let retained = estimateTurnTokens(latest.turn, options.tokenEstimate);
    if (firstTurnOfRun.get(latest.run) === latestIndex) retained += promptTokens(latest.run);
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
      const candidate = planned[index]!;
      let cost = estimateTurnTokens(candidate.turn, options.tokenEstimate);
      if (firstTurnOfRun.get(candidate.run) === index) cost += promptTokens(candidate.run);
      if (retained + cost > options.retainedContextBudget) break;
      retained += cost;
      tailStart = index;
    }
  }
  // 最新 Turn 之前没有可压缩 Turn：noop，不算失败。
  if (tailStart === 0) return { status: "noop" };

  const covered = planned.slice(0, tailStart);
  const coveredSeqs = new Set(covered.map(({ turn }) => turn.assistant.recordSeq));
  const messages: StoredContext["messages"] = [];
  for (const run of plan.runs) {
    const turns = run.turns.filter((turn) => coveredSeqs.has(turn.assistant.recordSeq));
    if (turns.length === 0) continue;
    if (run.prompt !== null) messages.push(promptMessage(run.prompt));
    for (const turn of turns) {
      messages.push(turn.assistant.message);
      for (const result of turn.results) messages.push(toolResultMessage(result));
    }
  }
  const coveredUpTo = turnBoundary(covered[covered.length - 1]!.turn);
  assertCandidateCheckpointValid(records, coveredUpTo);
  return { messages, coveredUpTo, previousSummary: plan.checkpoint?.summary ?? null };
}

const COMPACTION_TRIM_LADDER = [1, 1 / 4, 1 / 10] as const;
const COMPACTION_TRIM_FLOOR_CHARS = 200;
const COMPACTION_TRIM_HEAD_PARTS = 3;
const COMPACTION_TRIM_TAIL_PARTS = 2;

export interface CompactionTrimOptions {
  tokenEstimate: TokenEstimateOptions;
  toolResultMaxChars: number;
  maxTokens: number;
}

export type CompactionTrimResult =
  | { status: "ok"; messages: StoredContext["messages"]; toolResultLimit: number | null }
  | { status: "too_large" };

function trimToolResultText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const headLength = Math.floor(
    (limit * COMPACTION_TRIM_HEAD_PARTS) / (COMPACTION_TRIM_HEAD_PARTS + COMPACTION_TRIM_TAIL_PARTS),
  );
  const tailLength = limit - headLength;
  const omitted = text.length - headLength - tailLength;
  return `${text.slice(0, headLength)}…[${omitted} chars truncated]…${text.slice(-tailLength)}`;
}

function withoutThinking(messages: StoredContext["messages"]): StoredContext["messages"] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.content.some((block) => block.type === "thinking")) {
      return message;
    }
    return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
  });
}

function trimToolResults(messages: StoredContext["messages"], limit: number): StoredContext["messages"] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    return {
      ...message,
      content: message.content.map((block) =>
        block.type === "text" ? { ...block, text: trimToolResultText(block.text, limit) } : block,
      ),
    };
  });
}

// 回退裁剪路径：保留覆盖范围消息形式，仅阶梯裁剪 toolResult 文本并剥离 Thinking；
// 一律克隆消息对象，不改 Session 原文。
export function trimCompactionMessages(
  messages: StoredContext["messages"],
  options: CompactionTrimOptions,
): CompactionTrimResult {
  const base = withoutThinking(messages);
  if (estimateContextTokens({ messages: base }, options.tokenEstimate) <= options.maxTokens) {
    return { status: "ok", messages: base, toolResultLimit: null };
  }
  const tried = new Set<number>();
  for (const factor of COMPACTION_TRIM_LADDER) {
    const limit = Math.max(COMPACTION_TRIM_FLOOR_CHARS, Math.floor(options.toolResultMaxChars * factor));
    if (tried.has(limit)) continue;
    tried.add(limit);
    const trimmed = trimToolResults(base, limit);
    if (estimateContextTokens({ messages: trimmed }, options.tokenEstimate) <= options.maxTokens) {
      return { status: "ok", messages: trimmed, toolResultLimit: limit };
    }
  }
  return { status: "too_large" };
}
