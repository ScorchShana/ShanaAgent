import type { ApprovalMode } from "../security/permissions.js";
import type { Diagnostics } from "../diagnostics.js";
import type { PendingShellCleanup } from "../tools/shell.js";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  loadModelConfig,
  writeCurrentModel,
  writeReasoningEffort,
  type ResolvedModel,
} from "../llm/model-config-store.js";
import { createModelSnapshot, TurnError, type ModelService, type TurnResult } from "../llm/model-service.js";
import type { StoredContext } from "../llm/history-replay.js";
import { parseSettings, type Settings } from "../llm/settings-store.js";
import { ApprovalManager } from "../security/approval-manager.js";
import { createRunStartGate, resumeSession } from "../sessions/recovery.js";
import { compactHistory, type CompactionOutcome } from "../sessions/compaction-store.js";
import {
  normalizeAbortedMessage,
  toolCallsOfMessage,
  type NewSessionRecord,
  type SessionMeta,
  type SessionRecord,
  type StoredAssistantMessage,
  type UserPromptRecord,
} from "../sessions/records.js";
import type { SessionRef, SessionStore, SessionLoadWarning } from "../sessions/session-store.js";
import { createToolExecutor, type ToolExecutorOptions, type ToolExecutionResult } from "../tools/executor.js";
import { createToolRegistry } from "../tools/registry.js";
import {
  buildContext,
  estimateContextTokens,
  estimateMessageTokens,
  isRequestFeasible,
  loadRootAgentsMd,
  measuredPromptTokens,
  reachesCompactionThreshold,
  toAgentsMdReference,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  type AgentsMdLoad,
  type ContextBuildWarning,
} from "./context-builder.js";
import {
  SessionController,
  type CompactionDriver,
  type RunHandle,
  type LoopEnd,
} from "./session-controller.js";
import { splitSkillCommand } from "./skills.js";

export interface AgentSessionOptions {
  store: SessionStore;
  modelConfigPath?: string;
  workspaceId: string;
  ref?: SessionRef;
  workspaceRoot: string;
  // skills 根可注入（测试用临时目录）；缺省 ~/.shana/skills。
  skillsRoot?: string;
  getModel(): ResolvedModel;
  getSettings(): Settings;
  modelService: Pick<ModelService, "streamTurn">;
  diagnostics?: Diagnostics;
  environment?: string;
  systemPrompt?: string;
  onWarning?: (
    warning:
      | ContextBuildWarning
      | SessionLoadWarning
      | { kind: "temporary_file_cleanup_failed"; path: string }
      | { kind: "shell_cleanup_unconfirmed"; message: string }
      | { kind: "compaction_failed"; message: string },
  ) => void;
  executorOptions?: Pick<
    ToolExecutorOptions,
    "onDiagnostic" | "spawnProcess" | "terminateTree" | "platform" | "killConfirmTimeoutMs"
  >;
}

type ToolDefinitions = NonNullable<StoredContext["tools"]>;

function toolDefinitions(
  platform: NodeJS.Platform | undefined,
  settings: Settings,
  imageInput = false,
): ToolDefinitions {
  return createToolRegistry(platform, settings, undefined, imageInput)
    .list()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

function retainedContextBudget(context: StoredContext, model: ResolvedModel, settings: Settings): number {
  const fixedTokens = estimateContextTokens({ ...context, messages: [] }, settings.tokenEstimate);
  return Math.min(
    model.contextWindow - CONTEXT_SAFETY_MARGIN_TOKENS - settings.compactionSummaryTargetTokens - fixedTokens,
    Math.floor(model.contextWindow * settings.compactionRetainedContextRatio),
    settings.compactionRetainedContextMaxTokens,
  );
}

// usage 只有出自本 Run 模型的真实响应才是可信测量；身份不符（如代理改写模型）时
// tokenizer 可能不同，实测值不得用于锚定。
function sameModelIdentity(message: StoredAssistantMessage, model: ResolvedModel): boolean {
  return (
    message.provider === model.providerId && message.model === model.id && message.api === model.api
  );
}

// timestamp 不发送给 Provider（live Prompt 用发送时刻、重建用 record.ts），比较须忽略。
function sameSentMessage(
  a: StoredContext["messages"][number],
  b: StoredContext["messages"][number],
): boolean {
  const strip = (message: StoredContext["messages"][number]) => {
    const { timestamp: _timestamp, ...rest } = message;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

export async function createAgentSession(options: AgentSessionOptions): Promise<{
  controller: SessionController;
  acknowledgeUnknownSideEffects(): void;
}> {
  const workspaceId = options.workspaceId;
  if (options.ref && options.ref.workspaceId !== workspaceId)
    throw new Error("Cannot open a different workspace");
  const initial = options.ref ? await options.store.openSession(options.ref) : null;
  let ref: SessionRef | null = options.ref ? { ...options.ref } : null;
  let records = initial?.records ?? [];
  let openedAtSeq = records.at(-1)?.recordSeq ?? 0;
  let sessionMeta: SessionMeta | null = initial?.meta ?? null;
  let sessionWarnings: SessionLoadWarning[] = initial?.warnings ?? [];
  let approvalMode: ApprovalMode = sessionMeta?.approvalMode ?? "auto";
  // Run 起点冻结：运行中切换模式只影响后续 Run。
  let runApprovalMode: ApprovalMode = "auto";
  let metadataFresh = true;
  let recordsFresh = true;
  let recordsEpoch = 0;
  let resyncPromise: Promise<void> | null = null;
  // 标题/预览只显示请求原文（剥 /skill:name 命令前缀），记录恒存完整原文；
  // 空请求回退 skill:<name>，避免标题/预览空白。
  const displayPromptText = (record: UserPromptRecord): string => {
    const command = splitSkillCommand(record.text);
    if (!command) return record.text;
    return command.request.trim() ? command.request : `skill:${command.name}`;
  };
  const titleOf = (history: readonly SessionRecord[]): string => {
    const prompt = history.find((record) => record.type === "user_prompt" && record.text.trim());
    return prompt?.type === "user_prompt"
      ? (displayPromptText(prompt)
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim() ?? "未命名会话")
      : "未命名会话";
  };
  let sessionTitle = ref ? titleOf(records) : null;
  let modelConfig = options.modelConfigPath ? loadModelConfig(options.modelConfigPath) : undefined;
  const currentModel = (): ResolvedModel => {
    if (modelConfig === undefined) return options.getModel();
    if (modelConfig.status !== "ok") throw new Error(modelConfig.message);
    return modelConfig.current;
  };
  const displayModel = (model: ResolvedModel) => {
    const snapshot = createModelSnapshot(model);
    return { ...snapshot, input: [...snapshot.input] };
  };
  let gate = createRunStartGate(records);
  let unknownSignature = JSON.stringify(gate.unknownResults);
  const refreshGate = (): void => {
    const next = createRunStartGate(records);
    const signature = JSON.stringify(next.unknownResults);
    if (signature !== unknownSignature) {
      gate = next;
      unknownSignature = signature;
    }
  };
  let shellBlocked = false;
  const pendingShells = new Set<PendingShellCleanup>();
  let activeHandle: RunHandle | undefined;
  let runModel: ResolvedModel;
  let runSettings: Settings;
  let built: Awaited<ReturnType<typeof buildContext>>;
  // 不变量：contextTokens 是当前上下文的最佳已知 token 数——优先"最近一次实测 prompt +
  // 未测量增量的估算"（锚定），无可信实测时为全量估算（contextEstimated=true，状态栏加 ~）。
  // 状态栏直显此值；每处上下文变更（每 Turn/取消/压缩//new//resume）必须同步维护。
  let contextTokens = 0;
  // false = 未知（空闲态重建失败、model.json 非法等），状态栏显 "—"；Run 内恒 true。
  let contextTokensKnown = false;
  let contextEstimated = false;
  const setContextTokens = (tokens: number, estimated: boolean): void => {
    contextTokens = tokens;
    contextEstimated = estimated;
    contextTokensKnown = true;
  };
  const invalidateContextTokens = (): void => {
    contextTokensKnown = false;
    contextEstimated = false;
  };
  // Session 级冻结快照：进程启动、/new、/resume 时读取，Session 内不再重读。
  let sessionAgentsMd: AgentsMdLoad = await loadRootAgentsMd(options.workspaceRoot);
  const makeManager = () =>
    new ApprovalManager({
      onAnalyzerError: (error) =>
        options.diagnostics?.error(
          `bash analyzer failed; falling back to manual approval: ${error instanceof Error ? error.message : String(error)}`,
        ),
      approver: (request) => {
        if (!activeHandle) throw new Error("No active Run");
        const call = currentCalls.find((c) => c.id === request.toolCallId);
        return activeHandle.requestApproval({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          summary: {
            paths: request.paths,
            touchesOutsideWorkspace: request.touchesOutsideWorkspace,
            ...(request.operation ? { operation: request.operation } : {}),
            ...(request.command !== undefined ? { command: request.command } : {}),
            ...(call?.parse.status === "parsed" && (call.name === "write" || call.name === "edit")
              ? { parameters: call.parse.arguments }
              : {}),
          },
        });
      },
    });
  let manager = makeManager();
  let currentCalls: ReturnType<typeof toolCallsOfMessage> = [];
  const append = async (input: NewSessionRecord): Promise<SessionRecord> => {
    if (!ref) throw new Error("Session has not been initialized");
    let record: SessionRecord;
    try {
      record = await options.store.appendRecord(ref, input);
    } catch (error) {
      recordsFresh = false;
      throw error;
    }
    records.push(record);
    recordsEpoch += 1;
    return record;
  };
  // 用户取消时把已流式生成的部分响应落盘为受控中断 Turn：History 存原文（含半截 call）供审计，
  // 仅对可配对 call 合成 not_executed 结果（它们从未进入 executor）。无实质内容则不落盘。
  // 半截 thinking 在落盘前剥离（经授权修订 I5 审计范围）：推理草稿无续写价值，回传可能误导
  // 模型与压缩摘要。纯思考取消剥离后无实质内容 → 不落盘，Run 以零 Turn 取消收尾，
  // 下一条 Prompt 渲染期前置中断前缀。
  const persistAbortedTurn = async (
    handle: RunHandle,
    partial: StoredAssistantMessage | undefined,
  ): Promise<void> => {
    if (!partial) return;
    const stripped: StoredAssistantMessage = {
      ...partial,
      content: partial.content.filter((block) => block.type !== "thinking"),
    };
    const normalized = normalizeAbortedMessage(stripped);
    const calls = toolCallsOfMessage(normalized);
    const hasText = normalized.content.some(
      (block) => block.type === "text" && block.text.trim().length > 0,
    );
    if (!hasText && calls.length === 0) return;
    const assistant = await append({
      type: "assistant_message",
      runId: handle.runId,
      message: stripped,
    });
    for (const call of calls) {
      await append({
        type: "tool_result",
        runId: handle.runId,
        assistantRecordSeq: assistant.recordSeq,
        toolCallId: call.id,
        toolName: call.name,
        status: "not_executed",
        content: "Error: Cancelled by user.",
      });
      await handle.notifyToolCompleted(call.id);
    }
  };
  const resyncRecords = (): Promise<void> => {
    const target = ref;
    if (!target) return Promise.resolve();
    if (resyncPromise) return resyncPromise;
    resyncPromise = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const epoch = recordsEpoch;
        const loaded = await options.store.loadSession(target);
        if (ref !== target) return;
        if (recordsEpoch !== epoch) {
          if (attempt < 2) continue;
          throw new Error("Session 历史重同步期间记录持续变化");
        }
        records = loaded.records;
        sessionMeta = loaded.meta;
        sessionWarnings = loaded.warnings;
        recordsFresh = true;
        sessionTitle = ref ? titleOf(records) : null;
        refreshGate();
        return;
      }
    })().finally(() => {
      resyncPromise = null;
    });
    return resyncPromise;
  };
  // Run 起点锚定：最近一次实测 prompt 覆盖"当时发送的前缀"。仅当该前缀与当前重建上下文
  // 逐条一致、模型身份与工具 Schema 未变时才可信；任何不符回退纯估算（等同无锚定行为）。
  // 前缀重建比较自动覆盖 checkpoint 插入、标注/eligibility 差异等历史改写情形。
  // 已知有界残差：System Prompt/environment 不落盘，跨进程版本变更引起的固定头部漂移
  // 无法校验，误差以头部大小为界；工具 Schema 经 run_started 的 settings 快照校验。
  // 旧记录的 aborted thinking 读取时剥离：历史实测含当时发送的 thinking，锚定偏高，
  // 误差以被剥 thinking 大小为界、方向安全（提前压缩），下一次响应重新锚定即消除。
  const anchorContextTokens = async (
    context: StoredContext,
    model: ResolvedModel,
    settings: Settings,
  ): Promise<number | null> => {
    let reason = "no_measurement";
    let anchored: number | null = null;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!;
      if (record.type !== "assistant_message") continue;
      const measured = measuredPromptTokens(record.message.usage);
      if (measured === null) continue;
      if (!sameModelIdentity(record.message, model)) {
        reason = "model_mismatch";
        continue;
      }
      const started = records.find((r) => r.type === "run_started" && r.runId === record.runId);
      if (started === undefined || started.type !== "run_started") {
        reason = "run_started_missing";
        break;
      }
      let previousTools: ToolDefinitions;
      try {
        previousTools = toolDefinitions(
          options.executorOptions?.platform,
          parseSettings(started.settings),
          started.model.input.includes("image"),
        );
      } catch {
        reason = "run_settings_unreadable";
        break;
      }
      if (JSON.stringify(previousTools) !== JSON.stringify(context.tools)) {
        reason = "tools_changed";
        break;
      }
      let prefix: Awaited<ReturnType<typeof buildContext>>;
      try {
        prefix = await buildContext({
          records: records.slice(0, index),
          workspacePath: options.workspaceRoot,
          agentsMd: sessionAgentsMd,
          systemPrompt: options.systemPrompt,
          environment: options.environment,
          imageInput: model.input.includes("image"),
        });
      } catch {
        reason = "prefix_build_failed";
        break;
      }
      // 旧 checkpoint 未标记回放策略，跨进程载入的实测可能没有包含补回的 Prompt。
      if (record.recordSeq <= openedAtSeq && prefix.plan.runs.some(
        (run) => run.prompt && run.prompt.recordSeq <= prefix.plan.coveredUpTo,
      )) {
        reason = "restored_prompt";
        break;
      }
      const count = prefix.context.messages.length;
      if (
        prefix.context.systemPrompt !== context.systemPrompt ||
        count >= context.messages.length ||
        !prefix.context.messages.every((message, i) => sameSentMessage(message, context.messages[i]!))
      ) {
        reason = "prefix_mismatch";
        break;
      }
      let suffixTokens = 0;
      for (const message of context.messages.slice(count))
        suffixTokens += estimateMessageTokens(message, settings.tokenEstimate);
      anchored = measured + suffixTokens;
      break;
    }
    options.diagnostics?.debug(
      JSON.stringify({ event: "context.anchor", anchored: anchored !== null, reason: anchored !== null ? null : reason }),
    );
    return anchored;
  };
  // 统一取值：锚定优先（实测 prompt + 未测后缀估算，按实测口径显示）；无可信锚点全量估算。
  // 零占位 usage 被 measuredPromptTokens 拒绝，取消 Run 在此自然落入估算分支。
  const computeContextTokens = async (
    context: StoredContext,
    model: ResolvedModel,
    settings: Settings,
  ): Promise<{ tokens: number; estimated: boolean }> => {
    const anchored = await anchorContextTokens(context, model, settings);
    if (anchored !== null) return { tokens: anchored, estimated: false };
    return { tokens: estimateContextTokens(context, settings.tokenEstimate), estimated: true };
  };
  // 空闲态全量刷新：从 records 重建（含工具 Schema）后统一取值。失败返回 false 且不动现值，
  // 由调用方决定降级（会话切换清为未知；Run 收尾/手动压缩保留活值）。
  const refreshContextTokens = async (): Promise<boolean> => {
    try {
      const model = currentModel();
      const settings = parseSettings(options.getSettings());
      const imageInput = model.input.includes("image");
      const rebuilt = await buildContext({
        records,
        workspacePath: options.workspaceRoot,
        agentsMd: sessionAgentsMd,
        systemPrompt: options.systemPrompt,
        environment: options.environment,
        imageInput,
      });
      const computed = await computeContextTokens(
        {
          ...rebuilt.context,
          tools: toolDefinitions(options.executorOptions?.platform, settings, imageInput),
        },
        model,
        settings,
      );
      setContextTokens(computed.tokens, computed.estimated);
      return true;
    } catch {
      options.diagnostics?.debug(JSON.stringify({ event: "context.refresh", ok: false }));
      return false;
    }
  };
  const refreshContextTokensKeepingKnown = async (): Promise<void> => {
    const kept = contextTokensKnown ? { tokens: contextTokens, estimated: contextEstimated } : null;
    if (!(await refreshContextTokens()) && kept) setContextTokens(kept.tokens, kept.estimated);
  };
  const compactForRun = async (
    handle: RunHandle,
    signal: AbortSignal,
    trigger: "start" | "continuation" | "overflow",
  ): Promise<CompactionOutcome> => {
    handle.reportPhase("compacting");
    handle.notifyCompactionStarted();
    const tokenEstimate = runSettings.tokenEstimate;
    let outcome: CompactionOutcome;
    try {
      if (!recordsFresh) await resyncRecords();
      outcome = await compactHistory({
        records,
        context: built.context,
        model: runModel,
        settings: runSettings,
        signal,
        retainedContextBudget: retainedContextBudget(built.context, runModel, runSettings),
        trigger,
        currentRunId: handle.runId,
        modelService: options.modelService,
        appendRecord: append,
      });
    } catch (error) {
      handle.notifyCompactionFinished({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      handle.reportPhase("streaming");
      throw error;
    }
    // try/finally 保证重建抛错时 finished 事件仍恰发一次。
    try {
      if (outcome.status === "completed") {
        const tools = built.context.tools;
        // Prompt 已持久化且恒进上下文：未被覆盖时由 plan 保留，被覆盖时已进摘要输入。
        // 重建一律不传 currentPrompt，否则与记录中的 Prompt 重复。
        built = await buildContext({
          records,
          workspacePath: options.workspaceRoot,
          agentsMd: sessionAgentsMd,
          systemPrompt: options.systemPrompt,
          environment: options.environment,
          imageInput: runModel.input.includes("image"),
        });
        // 复用原数组保证与上一次正式请求逐字节一致。
        built.context.tools = tools;
        // 压后上下文未发送过、无实测可用，只能纯估算；下一次响应返回后重新锚定。
        setContextTokens(estimateContextTokens(built.context, tokenEstimate), true);
      }
    } finally {
      handle.notifyCompactionFinished(
        outcome.status === "completed" && outcome.coveredUpTo !== null
          ? { status: "completed", path: outcome.path, coveredUpTo: outcome.coveredUpTo }
          : { status: outcome.status },
      );
      handle.reportPhase("streaming");
    }
    if (outcome.status === "completed" && !isRequestFeasible(contextTokens, runModel.contextWindow)) {
      throw new Error(
        "Context length still exceeded after compaction. Use /compact or start a new Session.",
      );
    }
    return outcome;
  };
  const driver = {
    execute: async (handle: RunHandle, signal: AbortSignal): Promise<LoopEnd> => {
      activeHandle = handle;
      const executor = createToolExecutor({
        ...options.executorOptions,
        onDiagnostic: (event) => {
          try {
            const stack =
              event.error instanceof Error
                ? event.error.stack
                    ?.split("\n")
                    .filter((line) => /^\s+at\s/.test(line))
                    .join("\n")
                : undefined;
            options.diagnostics?.error(
              JSON.stringify({
                stage: event.stage,
                code: event.code,
                temporaryPath: event.temporaryPath,
                stack,
              }),
            );
            options.executorOptions?.onDiagnostic?.(event);
          } catch {
            // Diagnostics must not change the tool result.
          }
        },
        workspaceRoot: options.workspaceRoot,
        onPendingShell: (cleanup) => {
          pendingShells.add(cleanup);
        },
        onToolOutput: (toolCallId, snapshot) => handle.streamToolOutput(toolCallId, snapshot),
        settings: runSettings,
        imageInput: runModel.input.includes("image"),
        permissionGate: (request) => manager.requestPermission(request, { signal, mode: runApprovalMode }),
        onCleanupWarning: (path) => options.onWarning?.({ kind: "temporary_file_cleanup_failed", path }),
      });
      built.context.tools = executor.registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
      // 估算对代码/JSON 系统性偏低会让阈值触发漂移；有可信实测时以其锚定历史大头。
      const computed = await computeContextTokens(built.context, runModel, runSettings);
      setContextTokens(computed.tokens, computed.estimated);
      try {
        let autoCompactionFailedThisRun = false;
        let overflowRemediedThisRun = false;
        let skipThresholdCheck = false;
        let turn = 1;
        while (turn <= runSettings.maxTurns) {
          if (signal.aborted) throw new TurnError("cancelled", 0, "Run cancelled");
          if (skipThresholdCheck) {
            skipThresholdCheck = false;
          } else if (
            !autoCompactionFailedThisRun &&
            reachesCompactionThreshold(
              contextTokens,
              runModel.contextWindow,
              runSettings.compactionThresholdRatio,
            )
          ) {
            let compactionCancelled = false;
            try {
              const outcome = await compactForRun(handle, signal, turn > 1 ? "continuation" : "start");
              compactionCancelled = outcome.status === "cancelled";
            } catch (error) {
              autoCompactionFailedThisRun = true;
              if (!recordsFresh) await resyncRecords();
              if (!isRequestFeasible(contextTokens, runModel.contextWindow)) {
                throw error;
              }
              options.onWarning?.({
                kind: "compaction_failed",
                message: error instanceof Error ? error.message : String(error),
              });
            }
            if (compactionCancelled) throw new TurnError("cancelled", 0, "Run cancelled");
          }
          if (!isRequestFeasible(contextTokens, runModel.contextWindow)) {
            throw new Error("Context length exceeded. Use /compact or start a new Session.");
          }
          handle.beginAttempt(turn, 1);
          if (signal.aborted) throw new TurnError("cancelled", 0, "Run cancelled");
          let response: TurnResult;
          try {
            response = await options.modelService.streamTurn({
              model: runModel,
              context: built.context,
              maxRetries: runSettings.maxRetries,
              maxTokens: runModel.maxTokens,
              signal,
              onEvent: (event) => {
                handle.beginAttempt(turn, event.attempt);
                if (event.type === "attempt_failed") handle.finishAttempt("failed");
                if (event.type === "text_delta") handle.streamText(event.delta);
                if (event.type === "thinking_delta") handle.streamThinking(event.delta);
              },
            });
          } catch (error) {
            if (error instanceof TurnError && error.kind === "cancelled") {
              await persistAbortedTurn(handle, error.partial);
              throw error;
            }
            if (
              !(error instanceof TurnError) ||
              error.kind !== "context_overflow" ||
              overflowRemediedThisRun
            ) {
              throw error;
            }
            overflowRemediedThisRun = true;
            handle.finishAttempt("failed");
            let outcome: CompactionOutcome;
            try {
              outcome = await compactForRun(handle, signal, "overflow");
            } catch (remediationError) {
              throw new Error("Context length exceeded. Use /compact or start a new Session.", {
                cause: remediationError,
              });
            }
            if (outcome.status === "cancelled") throw new TurnError("cancelled", 0, "Run cancelled");
            if (outcome.status !== "completed") {
              throw new Error("Context length exceeded. Use /compact or start a new Session.");
            }
            // 同 Turn 重发：attempt 从 1 重计、不占 maxTurns；跳过阈值检查避免无新 Turn 重复压缩。
            skipThresholdCheck = true;
            continue;
          }
          // 完整生成的响应不因取消竞态丢弃：取消只阻止后续工具执行，已发生的生成如实落盘进上下文。
          handle.beginAttempt(turn, response.attempts);
          handle.finishAttempt("completed");
          currentCalls = toolCallsOfMessage(response.message);
          if (!["stop", "toolUse", "length"].includes(response.message.stopReason))
            throw new Error("Incomplete model response");
          if (
            currentCalls.some((c) => !c.id || !c.name) ||
            new Set(currentCalls.map((c) => c.id)).size !== currentCalls.length
          ) {
            await append({ type: "interruption", runId: handle.runId, reason: "protocol_error" });
            throw new Error("Invalid tool call identity");
          }
          const assistant = await append({
            type: "assistant_message",
            runId: handle.runId,
            message: response.message,
          });
          const results: ToolExecutionResult[] = [];
          for (const call of currentCalls) {
            handle.reportPhase("executing_tool");
            let result: ToolExecutionResult;
            if (signal.aborted) {
              result = {
                toolCallId: call.id,
                toolName: call.name,
                status: "not_executed",
                content: "Error: Cancelled by user.",
              };
            } else if (results.some((result) => result.status === "unknown")) {
              result = {
                toolCallId: call.id,
                toolName: call.name,
                status: "not_executed",
                content: "Error: Previous tool result is unknown. Not executed.",
              };
            } else if (response.message.stopReason === "length") {
              result =
                call.parse.status === "invalid"
                  ? await executor.execute(call)
                  : {
                      toolCallId: call.id,
                      toolName: call.name,
                      status: "not_executed",
                      content: "Error: Response truncated. Not executed. Generate the call again.",
                    };
            } else {
              handle.notifyToolStarted(call.id, call.name);
              result = await executor.execute(call, { signal });
            }
            if (result.termination && result.termination.kill !== "terminated") shellBlocked = true;
            await append({
              type: "tool_result",
              runId: handle.runId,
              assistantRecordSeq: assistant.recordSeq,
              toolCallId: call.id,
              toolName: call.name,
              status: result.status,
              content: result.content,
              ...(result.priorContent !== undefined ? { priorContent: result.priorContent } : {}),
              ...(result.images !== undefined ? { images: result.images } : {}),
            });
            results.push(result);
            if (result.status === "unknown") {
              refreshGate();
              await append({
                type: "interruption",
                runId: handle.runId,
                toolCallId: call.id,
                reason: "unknown_side_effect",
              });
            }
            await handle.notifyToolCompleted(call.id);
          }
          if (signal.aborted) throw new TurnError("cancelled", 0, "Run cancelled");
          if (results.some((r) => r.status === "unknown")) throw new Error("Tool side effects are unknown");
          if (currentCalls.length === 0) {
            if (response.message.stopReason !== "stop")
              throw new Error("Response truncated. Continue with a new prompt.");
            return { outcome: "completed" };
          }
          const newMessages = [
            response.message,
            ...results.map((result) => ({
              role: "toolResult" as const,
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              // image 块字段序 {type,data,mimeType} 必须与 toolResultMessage 重建同序（sameSentMessage 锚定）。
              content: [
                { type: "text" as const, text: result.content },
                ...(result.images ?? []).map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              ],
              isError: result.status !== "success",
              timestamp: Date.now(),
            })),
          ];
          built.context.messages.push(...newMessages);
          // usage 实测恰好覆盖刚发送的请求（前缀同一性由构造保证）；新增的 assistant/toolResults
          // 无人测过，只能估算。实测缺失或身份不符时回退增量估算。
          let deltaTokens = 0;
          for (const message of newMessages) {
            deltaTokens += estimateMessageTokens(message, runSettings.tokenEstimate);
          }
          const measured = measuredPromptTokens(response.usage);
          if (measured !== null && sameModelIdentity(response.message, runModel)) {
            setContextTokens(measured + deltaTokens, false);
          } else {
            // 实测缺失/身份不符回退增量估算，保持原有实测/估算口径。
            setContextTokens(contextTokens + deltaTokens, contextEstimated);
          }
          if (turn === runSettings.maxTurns) return { outcome: "turn_limit" };
          turn += 1;
        }
        return { outcome: "turn_limit" };
      } catch (error) {
        handle.finishAttempt(
          signal.aborted || (error instanceof TurnError && error.kind === "cancelled")
            ? "cancelled"
            : "failed",
        );
        refreshGate();
        if (error instanceof TurnError && error.kind === "context_overflow") {
          return {
            outcome: "failed",
            error: new Error("Context length exceeded. Use /compact or start a new Session."),
          };
        }
        return { outcome: "failed", error };
      } finally {
        activeHandle = undefined;
        currentCalls = [];
      }
    },
  };
  const closePendingShells = async (): Promise<void> => {
    for (const cleanup of pendingShells) {
      const result = await cleanup();
      if (result !== "terminated")
        options.onWarning?.({
          kind: "shell_cleanup_unconfirmed",
          message: "Shell termination could not be confirmed; a process may still be running.",
        });
    }
    pendingShells.clear();
  };
  const adoptSession = (
    nextRef: SessionRef | null,
    nextRecords: SessionRecord[],
    nextMeta: SessionMeta | null,
    nextWarnings: SessionLoadWarning[],
    nextAgentsMd: AgentsMdLoad,
  ): void => {
    ref = nextRef;
    records = nextRecords;
    openedAtSeq = nextRecords.at(-1)?.recordSeq ?? 0;
    sessionMeta = nextMeta;
    approvalMode = nextMeta?.approvalMode ?? "auto";
    metadataFresh = true;
    sessionWarnings = nextWarnings;
    sessionAgentsMd = nextAgentsMd;
    recordsFresh = true;
    recordsEpoch += 1;
    sessionTitle = ref ? titleOf(records) : null;
    gate = createRunStartGate(records);
    unknownSignature = JSON.stringify(gate.unknownResults);
    shellBlocked = false;
    manager = makeManager();
  };
  const compactor: CompactionDriver = {
    execute: async (signal, focus) => {
      if (!ref) throw new Error("当前没有打开的 Session，无法压缩。");
      const model = structuredClone(currentModel());
      const settings = parseSettings(options.getSettings());
      if (!recordsFresh) await resyncRecords();
      const imageInput = model.input.includes("image");
      const fresh = await buildContext({
        records,
        workspacePath: options.workspaceRoot,
        agentsMd: sessionAgentsMd,
        systemPrompt: options.systemPrompt,
        environment: options.environment,
        imageInput,
      });
      for (const warning of fresh.warnings) options.onWarning?.(warning);
      const context = {
        ...fresh.context,
        tools: toolDefinitions(options.executorOptions?.platform, settings, imageInput),
      };
      const outcome = await compactHistory({
        records,
        context,
        model,
        settings,
        signal,
        retainedContextBudget: retainedContextBudget(context, model, settings),
        trigger: "manual",
        focus,
        modelService: options.modelService,
        appendRecord: append,
      });
      if (outcome.status !== "completed") return outcome;
      // 压后全量刷新（无锚点落入纯估算）；重建失败保留活值，不影响压缩结果本身。
      await refreshContextTokensKeepingKnown();
      return outcome;
    },
  };
  const controller = new SessionController({
    driver,
    compactor,
    skillsRoot: options.skillsRoot,
    commands: {
      getApprovalMode: async () => {
        if (ref) {
          const meta = await options.store.readSessionMeta(ref);
          sessionMeta = meta;
          approvalMode = meta.approvalMode ?? "auto";
          metadataFresh = true;
        }
        return approvalMode;
      },
      setApprovalMode: async (mode) => {
        if (!metadataFresh) throw new Error("Query /mode to reload Session metadata first");
        if (ref) {
          try {
            sessionMeta = await options.store.setApprovalMode(ref, mode);
          } catch (error) {
            metadataFresh = false;
            try {
              sessionMeta = await options.store.readSessionMeta(ref);
              approvalMode = sessionMeta.approvalMode ?? "auto";
              metadataFresh = true;
            } catch {
              // An uncertain save blocks Runs until a metadata query succeeds.
            }
            throw error;
          }
        }
        approvalMode = mode;
      },
      readHistory: async () => {
        if (!ref || !sessionMeta) return null;
        if (!recordsFresh) await resyncRecords();
        if (!ref || !sessionMeta) return null;
        return {
          meta: sessionMeta,
          records: records.slice(),
          warnings: sessionWarnings,
          fromRecordSeq: 1,
        };
      },
      listSessions: async () => {
        const sessions = await options.store.listSessions(workspaceId);
        const entries = [];
        for (const meta of sessions) {
          const history = await options.store.readHistory({
            workspaceId: meta.workspaceId,
            sessionId: meta.sessionId,
          });
          for (const warning of history.warnings) options.onWarning?.(warning);
          if (!history.records.length && !history.warnings.length) continue;
          const prompts = history.records.filter((record) => record.type === "user_prompt");
          const started = new Set<string>();
          const prompted = new Set<string>();
          let promptsWithoutRunId = 0;
          for (const record of history.records) {
            if (record.type === "run_started") started.add(record.runId);
            else if (record.type === "user_prompt") {
              if (record.runId) prompted.add(record.runId);
              else promptsWithoutRunId += 1;
            }
          }
          // 启动快照与 Prompt 任一落盘即算已开始的 Run：run_started 追加失败或尾行撕裂只吃掉两条独立写入中的后一条。
          const runCount = Math.max(started.size, prompted.size + promptsWithoutRunId);
          entries.push({
            title: titleOf(history.records),
            preview: prompts.at(-1) ? displayPromptText(prompts.at(-1)!) : "",
            lastActiveAt: history.records.at(-1)?.ts ?? meta.createdAt,
            occupied: await options.store.isSessionOccupied({ workspaceId, sessionId: meta.sessionId }),
            ...meta,
            runCount,
          });
        }
        return entries.sort(
          (a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.sessionId.localeCompare(b.sessionId),
        );
      },
      newSession: async () => {
        await closePendingShells();
        if (ref) await options.store.releaseSession(ref);
        adoptSession(null, [], null, [], await loadRootAgentsMd(options.workspaceRoot));
        invalidateContextTokens();
        await refreshContextTokens();
      },
      resumeSession: async (source) => {
        if (source.workspaceId !== workspaceId) throw new Error("Cannot resume a different workspace");
        if (ref?.sessionId === source.sessionId) throw new Error("当前会话已打开");
        const restored = await resumeSession(options.store, source);
        try {
          await closePendingShells();
          if (ref) await options.store.releaseSession(ref);
        } catch (error) {
          await options.store.releaseSession(source);
          throw error;
        }
        adoptSession(
          { ...source },
          restored.records,
          restored.meta,
          restored.warnings,
          await loadRootAgentsMd(options.workspaceRoot),
        );
        invalidateContextTokens();
        await refreshContextTokens();
      },
      switchModel: options.modelConfigPath
        ? async (providerId, modelId) => {
            writeCurrentModel(options.modelConfigPath!, providerId, modelId);
            modelConfig = loadModelConfig(options.modelConfigPath!);
          }
        : undefined,
      setReasoningEffort: options.modelConfigPath
        ? async (effort) => {
            const selected = currentModel();
            writeReasoningEffort(options.modelConfigPath!, selected.providerId, selected.id, effort);
            modelConfig = loadModelConfig(options.modelConfigPath!);
          }
        : undefined,
    },
    createId: (prefix) => `${prefix}-${randomUUID()}`,
    hooks: {
      captureRunInput: () => {
        runApprovalMode = approvalMode;
        runModel = structuredClone(currentModel());
        runSettings = parseSettings(options.getSettings());
      },
      getSessionView: () => ({
        approvalMode,
        ref: ref ? { ...ref } : null,
        title: sessionTitle,
        model: modelConfig?.status === "empty" ? null : displayModel(currentModel()),
        models: (modelConfig?.status === "ok"
          ? modelConfig.models
          : modelConfig?.status === "empty"
            ? []
            : [options.getModel()]
        ).map(displayModel),
        runModel: runModel ? displayModel(runModel) : null,
        contextTokens: contextTokensKnown ? contextTokens : null,
        contextEstimated,
      }),
      closeSession: async () => {
        await closePendingShells();
        if (ref) await options.store.releaseSession(ref);
      },
      assertCanStartRun: () => {
        if (!metadataFresh)
          throw new Error("Query /mode to reload Session metadata before starting a Run");
        if (shellBlocked) throw new Error("Shell termination is not confirmed. Cannot start a new Run.");
        gate.assertCanStartRun();
      },
      persistRunStart: async (runId, prompt, skill) => {
        if (!recordsFresh) await resyncRecords();
        const prior = records.slice();
        const snapshot = createModelSnapshot(runModel);
        const initialRecords: NewSessionRecord[] = [
          { type: "user_prompt", runId, text: prompt, ...(skill ? { skill } : {}) },
          {
            type: "run_started",
            runId,
            model: { ...snapshot, input: [...snapshot.input] },
            settings: { ...runSettings } as unknown as JsonObject,
            agentsMd: toAgentsMdReference(sessionAgentsMd),
          },
        ];
        if (ref) {
          for (const record of initialRecords) await append(record);
        } else {
          const meta = await options.store.createSession({
            workspaceId,
            initialRecords,
            approvalMode,
          });
          ref = { workspaceId, sessionId: meta.sessionId };
          sessionMeta = meta;
          try {
            const loaded = await options.store.loadSession(ref);
            records = loaded.records;
            sessionMeta = loaded.meta;
            sessionWarnings = loaded.warnings;
            recordsFresh = true;
            recordsEpoch += 1;
          } catch (error) {
            recordsFresh = false;
            throw error;
          }
        }
        sessionTitle = titleOf(records);
        built = await buildContext({
          records: prior,
          currentPrompt: prompt,
          currentSkill: skill,
          workspacePath: options.workspaceRoot,
          agentsMd: sessionAgentsMd,
          systemPrompt: options.systemPrompt,
          environment: options.environment,
          imageInput: runModel.input.includes("image"),
        });
        // Run 发出即有值：覆盖"发出即取消"（尚无 assistant，状态栏不得显 0）。
        built.context.tools = toolDefinitions(
          options.executorOptions?.platform,
          runSettings,
          runModel.input.includes("image"),
        );
        const computed = await computeContextTokens(built.context, runModel, runSettings);
        setContextTokens(computed.tokens, computed.estimated);
        for (const warning of built.warnings) options.onWarning?.(warning);
      },
      persistRunFinished: async ({ runId, outcome, elapsedMs }) => {
        await append({ type: "run_finished", runId, outcome, elapsedMs, persisted: true });
        // Run 收尾（含取消）全量刷新：aborted partial 的零占位 usage 不可信，无锚点落入估算。
        await refreshContextTokensKeepingKnown();
      },
    },
  });

  await refreshContextTokens();

  return { controller, acknowledgeUnknownSideEffects: () => gate.acknowledge() };
}
