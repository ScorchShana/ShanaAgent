import type { StoredContext } from "../llm/history-replay.js";
import fs from "node:fs";
import path from "node:path";
import type { ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import {
  isTurnContextComplete,
  normalizeAbortedMessage,
  toolCallsOfMessage,
  type AgentsMdReference,
  type AssistantMessageRecord,
  type CheckpointRecord,
  type SessionRecord,
  type SessionRunOutcome,
  type StoredAssistantMessage,
  type ToolResultRecord,
  type UserPromptRecord,
  type SkillSnapshot,
} from "../sessions/records.js";
import {
  findLatestCheckpoint,
  responseExclusionReason,
  type ResponseExclusionReason,
} from "../sessions/recovery.js";
import { estimateImageTokens } from "../tools/image-header.js";
import { renderSkillMessage, splitSkillCommand } from "./skills.js";

// invalid_turn：协议损坏（非法 call 身份、多余/错配结果），正常落盘路径不会产生，防御性排除。
export type TurnExclusionReason =
  ResponseExclusionReason | "invalid_turn" | "follows_incomplete_turn";

export interface EligibleTurn {
  assistant: AssistantMessageRecord;
  // 配对的真实结果（任意 status，含 unknown），按 call 顺序。
  results: ToolResultRecord[];
  // 缺结果的 call（崩溃窗口）：构建上下文时合成显式 unknown 占位，不落盘。
  missingCalls: { toolCallId: string; toolName: string }[];
  // 配对 unknown 或缺结果：Turn 末尾附询问标注。
  hasUnknown: boolean;
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
  // Run 以用户取消/失败收尾；零 Turn 失败 Run 附失败标注，零 Turn 取消由下一条 Prompt 的前缀承载。
  cancelled: boolean;
  failed: boolean;
  // 紧邻其前的 Run 零 Turn 取消：本 Run 的 Prompt 渲染期前置中断前缀（不落盘）。
  followsCancelledZeroTurn: boolean;
  turns: EligibleTurn[];
  excludedTurns: ExcludedTurn[];
}

export interface EffectiveContextPlan {
  checkpoint: CheckpointRecord | null;
  coveredUpTo: number;
  runs: RunPlan[];
  nextPromptFollowsCancellation: boolean;
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
    else if (block.type === "image") total += estimateImageTokens(block.data);
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

// Provider 实测的 prompt tokens：input 已扣除缓存命中/写入，须三项相加才等于请求输入
// （pi-ai openai-completions 语义）。全零是时机 B 合成 partial 的"未计数"占位而非测量；
// 缺失/非法字段同样不可信。返回 null 时调用方必须回退字符估算，不得把 0 当实测。
export function measuredPromptTokens(usage: Usage | undefined): number | null {
  if (usage === undefined) return null;
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (parts.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0))
    return null;
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return total > 0 ? total : null;
}

type TurnClassification =
  | { kind: "eligible"; turn: EligibleTurn }
  | { kind: "excluded"; reason: TurnExclusionReason; toolCallIds: string[] };

function classifyTurn(
  assistant: AssistantMessageRecord,
  toolResults: readonly ToolResultRecord[],
): TurnClassification {
  // aborted 响应含半截 call，按归一化后的可配对 call 判定，与 isTurnContextComplete/turnMessages 一致。
  const message =
    assistant.message.stopReason === "aborted"
      ? normalizeAbortedMessage(assistant.message)
      : assistant.message;
  const calls = toolCallsOfMessage(message);
  const callIds = new Set(calls.map((call) => call.id));
  const matching = toolResults.filter(
    (result) =>
      result.assistantRecordSeq === assistant.recordSeq &&
      result.runId === assistant.runId &&
      callIds.has(result.toolCallId),
  );

  const exclusion = responseExclusionReason(assistant);
  if (exclusion !== null) {
    return { kind: "excluded", reason: exclusion, toolCallIds: [] };
  }
  if (!isTurnContextComplete(assistant, toolResults)) {
    const missingToolCallIds = calls
      .filter((call) => !matching.some((result) => result.toolCallId === call.id))
      .map((call) => call.id);
    return { kind: "excluded", reason: "invalid_turn", toolCallIds: missingToolCallIds };
  }

  // unknown/缺结果不再排除 Turn：配对合法，缺结果合成显式 unknown 占位（I6 修订），门控另行保留。
  const results: ToolResultRecord[] = [];
  const missingCalls: { toolCallId: string; toolName: string }[] = [];
  let hasUnknown = false;
  for (const call of calls) {
    const result = matching.find((candidate) => candidate.toolCallId === call.id);
    if (result === undefined) {
      missingCalls.push({ toolCallId: call.id, toolName: call.name });
      hasUnknown = true;
    } else {
      results.push(result);
      if (result.status === "unknown") hasUnknown = true;
    }
  }
  return { kind: "eligible", turn: { assistant, results, missingCalls, hasUnknown } };
}

export function planEffectiveContext(records: readonly SessionRecord[]): EffectiveContextPlan {
  const checkpoint = findLatestCheckpoint(records);
  const coveredUpTo = checkpoint?.coveredUpTo ?? 0;
  const toolResults = new Map<number, ToolResultRecord[]>();
  const outcomes = new Map<string, SessionRunOutcome>();
  for (const record of records) {
    if (record.type === "run_finished") outcomes.set(record.runId, record.outcome);
    if (record.type === "tool_result") {
      const owned = toolResults.get(record.assistantRecordSeq);
      if (owned) owned.push(record);
      else toolResults.set(record.assistantRecordSeq, [record]);
    }
  }
  const runs: RunPlan[] = [];
  const runIds = new Map<RunPlan, string | undefined>();
  let current: RunPlan | null = null;
  let blockedReason: TurnExclusionReason | null = null;

  for (const record of records) {

    if (record.type === "user_prompt") {
      current = { prompt: record, promptIncluded: false, cancelled: false, failed: false, followsCancelledZeroTurn: false, turns: [], excludedTurns: [] };
      runs.push(current);
      runIds.set(current, record.runId);
      blockedReason = null;
      continue;
    }
    if (record.type !== "assistant_message") continue;

    if (current === null) {
      current = { prompt: null, promptIncluded: false, cancelled: false, failed: false, followsCancelledZeroTurn: false, turns: [], excludedTurns: [] };
      runs.push(current);
      runIds.set(current, record.runId);
    }
    if (blockedReason !== null) {
      current.excludedTurns.push({
        assistant: record,
        reason: "follows_incomplete_turn",
        toolCallIds: [],
      });
      continue;
    }

    const classification = classifyTurn(record, toolResults.get(record.recordSeq) ?? []);
    if (classification.kind === "eligible") {
      current.turns.push(classification.turn);
    } else {
      current.excludedTurns.push({
        assistant: record,
        reason: classification.reason,
        toolCallIds: classification.toolCallIds,
      });
      blockedReason = classification.reason;
    }
  }

  // Prompt 恒进上下文（含失败/取消的零 Turn Run）；零 Turn 失败由 buildContext 附标注，
  // 零 Turn 取消的中断信息前置到记录序相邻的下一条 Prompt（渲染期，不落盘）。
  for (const [index, run] of runs.entries()) {
    const runId = runIds.get(run);
    const outcome = runId === undefined ? undefined : outcomes.get(runId);
    run.cancelled = outcome === "cancelled";
    run.failed = outcome === "failed";
    const previous = runs[index - 1];
    run.followsCancelledZeroTurn =
      previous !== undefined && previous.cancelled && previous.turns.length === 0;
  }

  const last = runs.at(-1);
  const nextPromptFollowsCancellation = last?.cancelled === true && last.turns.length === 0;
  // Resolve interruption prefixes before projecting the checkpoint tail.
  for (const run of runs) {
    run.turns = run.turns.filter((turn) => turn.assistant.recordSeq > coveredUpTo);
    run.excludedTurns = run.excludedTurns.filter((turn) => turn.assistant.recordSeq > coveredUpTo);
    if (run.prompt !== null && run.prompt.recordSeq <= coveredUpTo && run.turns.length === 0) {
      run.prompt = null;
    }
    run.promptIncluded = run.prompt !== null;
  }
  return {
    checkpoint,
    coveredUpTo,
    runs: runs.filter((run) => run.promptIncluded || run.turns.length > 0 || run.excludedTurns.length > 0),
    nextPromptFollowsCancellation,
  };
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
  // 与 currentPrompt 并列的 skill 快照，仅 Run 起点传入；重建路径由记录自带快照驱动。
  currentSkill?: SkillSnapshot;
  workspacePath: string;
  systemPrompt?: string;
  // 仅提供环境正文；<environment> 区块由 buildContext 包裹。
  environment?: string;
  // 调用方传入的 Session 冻结快照；缺省时在本函数内读取一次（测试或独立调用）。
  agentsMd?: AgentsMdLoad;
  // 当前模型是否接受 image 输入；false 时含图结果渲染为显式占位（默认 true）。
  imageInput?: boolean;
  now?: () => Date;
}

export interface BuiltContext {
  context: StoredContext;
  plan: EffectiveContextPlan;
  agentsMd: AgentsMdLoad;
  warnings: ContextBuildWarning[];
}

// user_prompt 的唯一渲染内核：skill 展开 + 中断前缀。重建 / currentPrompt / 压缩估算共用，
// 保证所有消费点逐字一致（锚定前缀同一性依赖此确定性）。前缀恒在最前，skill 块与请求相邻。
function renderPromptText(text: string, skill: SkillSnapshot | undefined, prefixed: boolean): string {
  const command = skill ? splitSkillCommand(text) : null;
  const body = skill && command ? renderSkillMessage(skill, command.request) : text;
  return prefixed ? PREVIOUS_REQUEST_INTERRUPTED_PREFIX + body : body;
}

function promptMessage(record: UserPromptRecord, prefixed = false): UserMessage {
  return {
    role: "user",
    content: renderPromptText(record.text, record.skill, prefixed),
    timestamp: Date.parse(record.ts),
  };
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

// 非视觉模型的渲染期占位：记录永久保留（I5），切回视觉模型后图片可逆恢复。
export const IMAGE_OMITTED_TEXT = "[Image omitted: the current model does not accept image input.]";
export const IMAGE_COMPACTION_OMITTED_TEXT = "[image omitted during compaction]";

export function toolResultMessage(record: ToolResultRecord, imageInput = true): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    // image 块字段序 {type,data,mimeType} 与 agent-loop Run 内构造逐字段同序：
    // 锚定前缀同一性用 JSON.stringify 比较（sameSentMessage），字段乱序会误判 prefix_mismatch。
    content: [
      { type: "text", text: record.content },
      ...(imageInput
        ? (record.images ?? []).map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          }))
        : record.images?.length
          ? [{ type: "text" as const, text: IMAGE_OMITTED_TEXT }]
          : []),
    ],
    isError: record.status !== "success",
    timestamp: Date.parse(record.ts),
  };
}

// 中断/失败/未知标注：渲染期注入的 user 消息，不落盘。防止模型把半截响应当完整结论续写、
// 把未知结果当未执行而盲目重试。
export const INTERRUPTED_RESPONSE_ANNOTATION = "[The user interrupted this response.]";
export const FAILED_REQUEST_ANNOTATION = "[This request failed before any response was generated.]";
// 零 Turn 取消 Run 的下一条 Prompt 渲染期前置此句（记录恒存原文），提示模型前一请求未完成、
// 勿连带回答。旧 Session 历史实测含已删除的取消标注：锚定偏高以标注大小为界、方向安全，
// 下次响应重新锚定消除（与 thinking 残差同理）。
export const PREVIOUS_REQUEST_INTERRUPTED_PREFIX =
  "[The previous request was interrupted before completion.]\n";
export const UNKNOWN_RESULT_ANNOTATION =
  "[Some tool results in this turn are unknown: the tools may have partially or fully executed, or may not have run at all. Do not retry them or assume their outcomes. Ask the user to verify the actual effects before continuing.]";

// 缺结果（崩溃窗口）的合成占位：显式声明"是否执行过都未知"，绝不写成确定态；仅上下文使用，不落盘。
export const MISSING_TOOL_RESULT_TEXT =
  "Error: The result of this tool call was not recorded (the process was interrupted). It is unknown whether the tool executed at all; it may have partially or fully run.";

function annotationMessage(text: string, ts: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.parse(ts) };
}

// 零 Turn 失败 Run：Prompt 后附失败标注，避免悬空 Prompt 误导模型。取消 Run 的 Prompt
// 裸进上下文，中断信息由其下一条 Prompt 的前缀承载（followsCancelledZeroTurn）。
function zeroTurnAnnotations(run: RunPlan): StoredContext["messages"] {
  if (run.prompt === null || run.turns.length > 0) return [];
  if (run.failed) return [annotationMessage(FAILED_REQUEST_ANNOTATION, run.prompt.ts)];
  return [];
}

function syntheticUnknownResultMessage(
  call: { toolCallId: string; toolName: string },
  ts: string,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    content: [{ type: "text", text: MISSING_TOOL_RESULT_TEXT }],
    isError: true,
    timestamp: Date.parse(ts),
  };
}

// 半截推理不进上下文：新记录已在落盘前剥离，旧记录在此读取时剥离（TUI 同构不显示）。
// 仅含 thinking 时克隆，不改 Session 原文。
function assistantWithoutThinking(message: StoredAssistantMessage): StoredAssistantMessage {
  if (!message.content.some((block) => block.type === "thinking")) return message;
  return { ...message, content: message.content.filter((block) => block.type !== "thinking") };
}

// eligible Turn → 上下文消息：assistant（aborted 归一化并剥离 thinking）+ 按 call 顺序的工具结果
// （缺结果合成 unknown 占位）+ 中断/未知标注。buildContext 与 planCompaction 共用，保证压缩与正式请求同构。
export function turnMessages(turn: EligibleTurn, imageInput = true): StoredContext["messages"] {
  const aborted = turn.assistant.message.stopReason === "aborted";
  const message = aborted
    ? assistantWithoutThinking(normalizeAbortedMessage(turn.assistant.message))
    : turn.assistant.message;
  const messages: StoredContext["messages"] = [message];
  const byCallId = new Map(turn.results.map((result) => [result.toolCallId, result]));
  for (const call of toolCallsOfMessage(message)) {
    const result = byCallId.get(call.id);
    messages.push(
      result !== undefined
        ? toolResultMessage(result, imageInput)
        : syntheticUnknownResultMessage({ toolCallId: call.id, toolName: call.name }, turn.assistant.ts),
    );
  }
  if (aborted) messages.push(annotationMessage(INTERRUPTED_RESPONSE_ANNOTATION, turn.assistant.ts));
  if (turn.hasUnknown) messages.push(annotationMessage(UNKNOWN_RESULT_ANNOTATION, turn.assistant.ts));
  return messages;
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

export function replayContextMessages(plan: EffectiveContextPlan, imageInput: boolean): StoredContext["messages"] {
  const messages = plan.checkpoint === null ? [] : [summaryMessage(plan.checkpoint)];
  return [...messages, ...plan.runs.flatMap((run) => runMessages(run, imageInput))];
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const plan = planEffectiveContext(input.records);
  const agentsMd = input.agentsMd ?? (await loadRootAgentsMd(input.workspacePath));
  const warnings: ContextBuildWarning[] = [];
  const messages = replayContextMessages(plan, input.imageInput ?? true);
  if (input.currentPrompt !== undefined) {
    const now = input.now ?? (() => new Date());
    // 与重建路径同一规则（新 Prompt 的 Run 尚未在记录里，取末尾 Run 判定）：
    // 锚定 sameSentMessage 逐条比较，两条路径必须逐字一致。
    const prefixed = plan.nextPromptFollowsCancellation;
    messages.push({
      role: "user",
      content: renderPromptText(input.currentPrompt, input.currentSkill, prefixed),
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
  retainedMessages: StoredContext["messages"];
}

export interface PlanCompactionOptions {
  trigger: "start" | "continuation" | "manual" | "overflow";
  currentRunId?: string;
  retainedContextBudget: number;
  tokenEstimate: TokenEstimateOptions;
  // 与正式请求同构：预算估算和摘要输入消息都按当前模型能力渲染 image 块。
  imageInput?: boolean;
}

function turnBoundary(turn: EligibleTurn): number {
  let boundary = turn.assistant.recordSeq;
  for (const result of turn.results) boundary = Math.max(boundary, result.recordSeq);
  return boundary;
}

function runPromptMessages(run: RunPlan): StoredContext["messages"] {
  if (!run.promptIncluded || run.prompt === null) return [];
  return [promptMessage(run.prompt, run.followsCancelledZeroTurn), ...zeroTurnAnnotations(run)];
}

function runMessages(run: RunPlan, imageInput: boolean): StoredContext["messages"] {
  return [...runPromptMessages(run), ...run.turns.flatMap((turn) => turnMessages(turn, imageInput))];
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
  const imageInput = options.imageInput ?? true;
  const { runs } = plan;
  const active = options.currentRunId === undefined
    ? undefined
    : runs.find((run) => run.prompt?.runId === options.currentRunId);
  const latestRun = runs.findLast((run) => run.turns.length > 0);
  // Overflow on the first request keeps the preceding Turn alongside the new prompt.
  let target = latestRun;
  if (options.trigger === "start") target = active;
  if (options.trigger === "continuation") target = active ?? latestRun;
  if (options.trigger === "overflow") target = latestRun ?? active;
  const targetIndex = target === undefined ? runs.length : runs.indexOf(target);
  const finishes = new Map<string, number>();
  for (const record of records) {
    if (record.type === "run_finished") finishes.set(record.runId, record.recordSeq);
  }
  let coveredUpTo = plan.coveredUpTo;
  for (const run of runs.slice(0, targetIndex)) {
    const last = run.turns.at(-1);
    if (last !== undefined) coveredUpTo = turnBoundary(last);
    else if (run.promptIncluded && run.prompt?.runId !== undefined) {
      const finish = finishes.get(run.prompt.runId);
      if (finish !== undefined) coveredUpTo = finish;
    }
  }

  if (target !== undefined && target.turns.length > 0 && options.trigger !== "start") {
    const trailing = runs.slice(targetIndex + 1).flatMap((run) => runMessages(run, imageInput));
    const latest = target.turns.length - 1;
    let cost = estimateContextTokens({
      messages: [...runPromptMessages(target), ...turnMessages(target.turns[latest]!, imageInput), ...trailing],
    }, options.tokenEstimate);
    let firstRetained = latest;
    while (firstRetained > 0) {
      const messages = turnMessages(target.turns[firstRetained - 1]!, imageInput);
      cost += estimateContextTokens({ messages }, options.tokenEstimate);
      if (cost > options.retainedContextBudget) break;
      firstRetained--;
    }
    // Explicit compaction and overflow remediation need to advance the checkpoint.
    const forceProgress = options.trigger === "manual" || options.trigger === "overflow";
    if (forceProgress && firstRetained === 0 && coveredUpTo === plan.coveredUpTo && latest > 0) {
      firstRetained = 1;
    }
    if (firstRetained > 0) coveredUpTo = turnBoundary(target.turns[firstRetained - 1]!);
  }

  if (coveredUpTo <= plan.coveredUpTo) return { status: "noop" };
  assertCandidateCheckpointValid(records, coveredUpTo);
  const messages: StoredContext["messages"] = [];
  const retainedMessages: StoredContext["messages"] = [];
  for (const run of runs) {
    const prompt = runPromptMessages(run);
    const coveredPrompt = run.prompt !== null && run.prompt.recordSeq <= coveredUpTo;
    if (coveredPrompt) messages.push(...prompt);
    if (!coveredPrompt || run.turns.some((turn) => turn.assistant.recordSeq > coveredUpTo)) {
      retainedMessages.push(...prompt);
    }
    for (const turn of run.turns) {
      const destination = turn.assistant.recordSeq <= coveredUpTo ? messages : retainedMessages;
      destination.push(...turnMessages(turn, imageInput));
    }
  }
  return { messages, retainedMessages, coveredUpTo, previousSummary: plan.checkpoint?.summary ?? null };
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
  return messages.map((message) =>
    message.role === "assistant" ? assistantWithoutThinking(message) : message,
  );
}

function trimToolResults(messages: StoredContext["messages"], limit: number): StoredContext["messages"] {
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    return {
      ...message,
      // 阶梯每档（含 factor 1）都丢图换占位：摘要是文本请求，image 块只膨胀预算；
      // base 未超预算的路径保留原图。
      content: message.content.map((block) =>
        block.type === "text"
          ? { ...block, text: trimToolResultText(block.text, limit) }
          : block.type === "image"
            ? { type: "text" as const, text: IMAGE_COMPACTION_OMITTED_TEXT }
            : block,
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
