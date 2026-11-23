import { createHash } from "node:crypto";
import fs from "node:fs";
import type { UserMessage } from "@earendil-works/pi-ai";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  estimateContextTokens,
  estimateTokens,
  isRequestFeasible,
  planCompaction,
  planEffectiveContext,
  replayContextMessages,
  type PlanCompactionOptions,
  trimCompactionMessages,
  wrapConversationSummary,
} from "../core/context-builder.js";
import type { StoredContext } from "../llm/history-replay.js";
import type { ResolvedModel } from "../llm/model-config-store.js";
import { TurnError, type ModelService, type TurnResult } from "../llm/model-service.js";
import type { Settings } from "../llm/settings-store.js";
import type { NewSessionRecord, SessionRecord } from "./records.js";

export type CompactionPath = "primary" | "fallback";

export interface CompactionOutcome {
  status: "completed" | "cancelled" | "noop";
  coveredUpTo: number | null;
  path: CompactionPath;
}

export class CompactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompactionError";
  }
}

export interface CompactHistoryOptions {
  records: readonly SessionRecord[];
  // 调用方预构建的有效上下文（含 System Prompt、工具 Schema 与当前 Prompt）；
  // 主路径复用实际消息直到覆盖边界，以保留前缀缓存；回退仅发送预算内的覆盖内容。
  context: StoredContext;
  model: ResolvedModel;
  settings: Settings;
  signal: AbortSignal;
  retainedContextBudget: number;
  trigger: PlanCompactionOptions["trigger"];
  currentRunId?: string;
  // 手动 /compact 的用户附加重点：只进本次摘要请求，不落盘、不进 promptVersion。
  focus?: string;
  modelService: Pick<ModelService, "streamTurn">;
  appendRecord: (input: NewSessionRecord) => Promise<SessionRecord>;
  loadPrompt?: () => Promise<string>;
  now?: () => Date;
}

const TARGET_TOKENS_PLACEHOLDER = "{{TARGET_TOKENS}}";

async function loadCompactionPrompt(): Promise<string> {
  // CRLF checkout 归一（readPrompt 同款），保证摘要指令字节稳定。
  return new TextDecoder("utf-8", { fatal: true })
    .decode(await fs.promises.readFile(new URL("../../prompts/compaction.md", import.meta.url)))
    .replaceAll("\r\n", "\n");
}

function cancelled(path: CompactionPath): CompactionOutcome {
  return { status: "cancelled", coveredUpTo: null, path };
}

export async function compactHistory(options: CompactHistoryOptions): Promise<CompactionOutcome> {
  const { records, context, model, settings, signal, modelService, appendRecord } = options;
  const now = options.now ?? (() => new Date());
  const tokenEstimate = settings.tokenEstimate;
  if (signal.aborted) return cancelled("primary");

  const selection = planCompaction(records, {
    trigger: options.trigger,
    ...(options.currentRunId === undefined ? {} : { currentRunId: options.currentRunId }),
    retainedContextBudget: options.retainedContextBudget,
    tokenEstimate,
    // 与调用方预构建 context 同能力渲染，预算与摘要输入才与正式请求同构。
    imageInput: model.input.includes("image"),
  });
  if ("status" in selection) return { status: "noop", coveredUpTo: null, path: "primary" };

  const summaryTarget = settings.compactionSummaryTargetTokens;
  if (summaryTarget > model.maxTokens) {
    throw new CompactionError("压缩失败：摘要正文目标超出模型最大输出能力。");
  }

  let promptText: string;
  try {
    promptText = await (options.loadPrompt ?? loadCompactionPrompt)();
  } catch (error) {
    throw new CompactionError("压缩失败：无法加载压缩指令。", { cause: error });
  }
  if (
    promptText.trim().length === 0 ||
    promptText.includes("\0") ||
    !promptText.includes(TARGET_TOKENS_PLACEHOLDER)
  ) {
    throw new CompactionError("压缩失败：压缩指令文件无效。");
  }
  // 先替换占位符再拼 focus，focus 内的 {{TARGET_TOKENS}} 保持字面量；
  // trimEnd 避免模板自身结尾换行与分隔符叠加出多余空行。
  const focus = options.focus?.trim() ?? "";
  const filled = promptText.replaceAll(TARGET_TOKENS_PLACEHOLDER, String(summaryTarget));
  const instruction = focus ? `${filled.trimEnd()}\n\nAdditional focus:\n${focus}` : filled;
  const promptVersion = createHash("sha256").update(promptText).digest("hex").slice(0, 16);

  const contextWindow = model.contextWindow;
  // 思考与正文共享同一输出上限，请求输出预算须同时预留两者。
  const thinkingHeadroom =
    model.reasoning && model.thinking ? thinkingBudgetForLevel(model.reasoningEffort) : 0;
  const prefixLength = selection.messages.length + Number(selection.previousSummary !== null);
  const prefix = context.messages.slice(0, prefixLength);
  const estimated = estimateContextTokens({ ...context, messages: prefix }, tokenEstimate);
  const previousSummaryTokens =
    selection.previousSummary === null
      ? 0
      : estimateTokens(wrapConversationSummary(selection.previousSummary), tokenEstimate);
  const retainedTokens = estimateContextTokens(
    { ...context, messages: selection.retainedMessages }, tokenEstimate,
  );
  // 尾部也包括跨覆盖边界补回的 Run prompt。
  if (retainedTokens + summaryTarget >= contextWindow) {
    throw new CompactionError("压缩失败：保留尾部与摘要预算已超出上下文窗口。");
  }

  const instructionTokens = estimateTokens(instruction, tokenEstimate);
  const instructionMessage: UserMessage = {
    role: "user",
    content: instruction,
    timestamp: now().getTime(),
  };
  let path: CompactionPath;
  let requestContext: StoredContext;
  if (estimated + instructionTokens + summaryTarget + thinkingHeadroom + CONTEXT_SAFETY_MARGIN_TOKENS <= contextWindow) {
    path = "primary";
    requestContext = { ...context, messages: [...prefix, instructionMessage] };
  } else {
    path = "fallback";
    const systemTokens =
      context.systemPrompt === undefined ? 0 : estimateTokens(context.systemPrompt, tokenEstimate);
    const trimmed = trimCompactionMessages(selection.messages, {
      tokenEstimate,
      toolResultMaxChars: settings.compactionToolResultMaxChars,
      maxTokens:
        contextWindow -
        CONTEXT_SAFETY_MARGIN_TOKENS -
        summaryTarget -
        thinkingHeadroom -
        systemTokens -
        instructionTokens -
        previousSummaryTokens,
    });
    if (trimmed.status === "too_large") {
      throw new CompactionError("压缩失败：裁剪后的压缩消息仍超出预算。");
    }
    const summaryHead: UserMessage[] =
      selection.previousSummary === null
        ? []
        : [
            {
              role: "user",
              content: wrapConversationSummary(selection.previousSummary),
              timestamp: now().getTime(),
            },
          ];
    requestContext = {
      systemPrompt: context.systemPrompt,
      messages: [...summaryHead, ...trimmed.messages, instructionMessage],
      tools: [],
    };
  }

  if (signal.aborted) return cancelled(path);
  let result: TurnResult;
  try {
    result = await modelService.streamTurn({
      model,
      context: requestContext,
      signal,
      maxRetries: settings.compactionMaxRetries,
      // no-force：不传 maxTokens，pi-ai 缺省取 model.maxTokens 再按上下文钳制，正文仅由提示词软目标约束。
    });
  } catch (error) {
    if (error instanceof TurnError && error.kind === "cancelled") return cancelled(path);
    throw error;
  }
  if (signal.aborted) return cancelled(path);
  if (result.stopReason !== "stop") {
    throw new CompactionError(`压缩失败：摘要响应未正常结束（${result.stopReason}）。`);
  }
  if (result.toolCalls.length > 0) {
    throw new CompactionError("压缩失败：摘要响应包含工具调用。");
  }
  const summary = result.text.trim();
  if (summary.length === 0) {
    throw new CompactionError("压缩失败：摘要为空。");
  }
  const checkpoint: Extract<NewSessionRecord, { type: "checkpoint" }> = {
    type: "checkpoint",
    summary,
    coveredUpTo: selection.coveredUpTo,
    model: { providerId: model.providerId, modelId: model.id },
    promptVersion,
    // 摘要请求是真实请求，用量必须随 checkpoint 落盘，否则重启/多进程后 Cache/Speed 会漏计。
    usage: {
      input: result.usage.input,
      cacheRead: result.usage.cacheRead,
      output: result.usage.output,
      ...(typeof result.message.durationMs === "number" ? { durationMs: result.message.durationMs } : {}),
    },
  };
  const candidate = { ...checkpoint, recordSeq: (records.at(-1)?.recordSeq ?? 0) + 1, ts: now().toISOString() };
  const replay = planEffectiveContext([...records, candidate]);
  const rebuiltMessages = replayContextMessages(replay, model.input.includes("image"));
  const rebuiltTokens = estimateContextTokens({ ...context, messages: rebuiltMessages }, tokenEstimate);
  if (!isRequestFeasible(rebuiltTokens, contextWindow)) {
    throw new CompactionError("压缩失败：压缩后上下文仍超出请求预算。");
  }
  if (signal.aborted) return cancelled(path);
  // 追加与 fsync 是不可取消临界区：开始后收到的取消不影响 completed。
  await appendRecord(checkpoint);
  return { status: "completed", coveredUpTo: selection.coveredUpTo, path };
}
