import { probeDecisionModel, requestDecision, type DecisionState } from "../llm/decision-service.js";
import type { LoadedDecisionModelConfig } from "../llm/decision-model-config-store.js";
import type { LoadedDecisionPrompt } from "../tools/prompts.js";
import type { AutoDecisionStatus } from "./state.js";
import type { Diagnostics } from "../diagnostics.js";
import type { PendingShellCleanup } from "../tools/shell.js";
import { randomUUID } from "node:crypto";
import { Type, type JsonObject } from "@earendil-works/pi-ai";
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
  toolCallsOfMessage,
  type NewSessionRecord,
  type SessionMeta,
  type SessionRecord,
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

export interface AgentSessionOptions {
  store: SessionStore;
  decisionConfig?: LoadedDecisionModelConfig;
  decisionPrompt?: LoadedDecisionPrompt;
  decisionFetch?: typeof fetch;
  modelConfigPath?: string;
  workspaceId: string;
  ref?: SessionRef;
  workspaceRoot: string;
  getModel(): ResolvedModel;
  getSettings(): Settings;
  modelService: Pick<ModelService, "streamTurn">;
  diagnostics?: Diagnostics;
  environment?: string;
  systemPrompt?: string;
  onWarning?: (
    warning:
      | { kind: "decision_fallback"; category: "http" | "transport" | "response" | "timeout" }
      | { kind: "decision_probe"; category: "unavailable" | "recovered"; message?: string }
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

function toolDefinitions(platform: NodeJS.Platform | undefined, settings: Settings): ToolDefinitions {
  return createToolRegistry(platform, settings)
    .list()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.parameters),
    }));
}

// 与压缩预算的固定开销同源：System Prompt + environment + AGENTS.md + 工具 Schema。
function computeBaselineTokens(
  context: StoredContext,
  settings: Settings,
  platform?: NodeJS.Platform,
): number {
  return estimateContextTokens(
    { ...context, messages: [], tools: toolDefinitions(platform, settings) },
    settings.tokenEstimate,
  );
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
  let sessionMeta: SessionMeta | null = initial?.meta ?? null;
  let sessionWarnings: SessionLoadWarning[] = initial?.warnings ?? [];
  let autoDecisionEnabled = sessionMeta?.autoDecisionEnabled ?? true;
  let metadataFresh = true;
  let runAutoDecisionEnabled = true;
  let runDecisionUnavailable = false;
  let currentIntent = "";
  const decisionConfig: NonNullable<AgentSessionOptions["decisionConfig"]> = structuredClone(
    options.decisionConfig ?? { status: "missing" },
  );
  const decisionPrompt: NonNullable<AgentSessionOptions["decisionPrompt"]> = structuredClone(
    options.decisionPrompt ?? { status: "invalid", message: "Decision prompt unavailable" },
  );
  let decisionProbe: { reason: "model_mismatch" | "not_decision"; message: string } | null = null;
  let probeGeneration = 0;
  let probeController: AbortController | null = null;
  let probePromise: Promise<void> | null = null;
  const autoDecisionStatus = (): AutoDecisionStatus => {
    const invalid =
      decisionConfig.status === "invalid"
        ? decisionConfig
        : decisionPrompt.status === "invalid"
          ? decisionPrompt
          : null;
    const availability = invalid
      ? "invalid"
      : decisionConfig.status === "missing"
        ? "missing"
        : decisionProbe
          ? "unavailable"
          : "ready";
    const message = invalid ? invalid.message : (decisionProbe?.message ?? undefined);
    return {
      enabled: autoDecisionEnabled,
      availability,
      ...(message !== undefined ? { message } : {}),
    };
  };
  const stopDecisionProbe = (): Promise<void> => {
    probeGeneration += 1;
    probeController?.abort();
    probeController = null;
    const previous = probePromise;
    probePromise = null;
    return previous ?? Promise.resolve();
  };
  const startDecisionProbe = (): void => {
    const previous = stopDecisionProbe();
    const generation = probeGeneration;
    probePromise = (async () => {
      await previous;
      if (generation !== probeGeneration) return;
      if (
        !autoDecisionEnabled ||
        decisionConfig.status !== "ok" ||
        decisionPrompt.status !== "ok"
      )
        return;
      const controller = new AbortController();
      probeController = controller;
      const outcome = await probeDecisionModel({
        config: decisionConfig.config,
        timeoutMs: parseSettings(options.getSettings()).decisionTimeoutMs,
        signal: controller.signal,
        fetch: options.decisionFetch,
      });
      if (generation !== probeGeneration) return;
      options.diagnostics?.debug(
        JSON.stringify({
          event: "decision.probe",
          kind: outcome.kind,
          ...(outcome.kind === "inconclusive" ? { category: outcome.category } : {}),
        }),
      );
      if (outcome.kind === "model_mismatch") {
        const message = `决策模型名称与服务不符（配置：${decisionConfig.config.model}，服务：${outcome.servedModel}）`;
        decisionProbe = { reason: "model_mismatch", message };
        options.onWarning?.({ kind: "decision_probe", category: "unavailable", message });
      } else if (outcome.kind === "not_decision") {
        const message = "服务加载的模型不是决策模型";
        decisionProbe = { reason: "not_decision", message };
        options.onWarning?.({ kind: "decision_probe", category: "unavailable", message });
      } else if (outcome.kind === "ok" && decisionProbe) {
        decisionProbe = null;
        options.onWarning?.({ kind: "decision_probe", category: "recovered" });
      }
    })();
  };
  let recordsFresh = true;
  let recordsEpoch = 0;
  let resyncPromise: Promise<void> | null = null;
  const titleOf = (history: readonly SessionRecord[]): string => {
    const prompt = history.find((record) => record.type === "user_prompt" && record.text.trim());
    return prompt?.type === "user_prompt"
      ? prompt.text
          .split(/\r?\n/)
          .find((line) => line.trim())!
          .trim()
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
  // 不变量：contextTokens === estimateContextTokens(built.context)；built.context 的每处变更必须同步它。
  let contextTokens = 0;
  let contextBaselineTokens: number | null = null;
  // Session 级冻结快照：进程启动、/new、/resume 时读取，Session 内不再重读。
  let sessionAgentsMd: AgentsMdLoad = await loadRootAgentsMd(options.workspaceRoot);
  const applyBaseline = (context: StoredContext, settings: Settings): void => {
    try {
      contextBaselineTokens = computeBaselineTokens(context, settings, options.executorOptions?.platform);
    } catch {
      contextBaselineTokens = null;
    }
  };
  const refreshBaseline = async (): Promise<void> => {
    try {
      const baseline = await buildContext({
        records: [],
        workspacePath: options.workspaceRoot,
        agentsMd: sessionAgentsMd,
        systemPrompt: options.systemPrompt,
        environment: options.environment,
      });
      applyBaseline(baseline.context, parseSettings(options.getSettings()));
    } catch {
      contextBaselineTokens = null;
    }
  };
  const makeManager = () =>
    new ApprovalManager({
      onDecisionError: () => {
        options.diagnostics?.warn(JSON.stringify({ event: "permission.decision", category: "internal" }));
        options.onWarning?.({ kind: "decision_fallback", category: "transport" });
      },
      decider: async (subject, request, signal) => {
        if (
          !runAutoDecisionEnabled ||
          runDecisionUnavailable ||
          decisionConfig.status !== "ok" ||
          decisionPrompt.status !== "ok"
        )
          return { kind: "ask_user" };
        const call = currentCalls.find((entry) => entry.id === subject.toolCallId);
        if (!activeHandle || !call || call.parse.status !== "parsed") return { kind: "ask_user" };
        const args = call.parse.arguments;
        if (!signal) return { kind: "ask_user" };
        const base = {
          user_task: activeHandle.prompt,
          agent_intent: currentIntent,
          project_root: options.workspaceRoot,
        };
        const paths = {
          resolved_paths: [...request.paths],
          touches_outside_workspace: request.touchesOutsideWorkspace,
        };
        let state: DecisionState;
        if (call.name === "bash" && typeof args.command === "string") {
          state = {
            ...base,
            tool: "bash",
            arguments: {
              command: args.command,
              ...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
            },
          };
        } else if ((call.name === "write" || call.name === "edit") && typeof args.path === "string") {
          state = { ...base, ...paths, tool: call.name, arguments: { path: args.path } };
        } else if (call.name === "read" || call.name === "glob" || call.name === "grep") {
          state = { ...base, ...paths, tool: call.name, arguments: { ...args } };
        } else return { kind: "ask_user" };
        const result = await requestDecision({
          config: decisionConfig.config,
          prompt: decisionPrompt.text,
          state,
          timeoutMs: runSettings.decisionTimeoutMs,
          signal,
          fetch: options.decisionFetch,
        });
        options.diagnostics?.debug(
          JSON.stringify({
            toolCallId: subject.toolCallId,
            kind: result.kind,
            ...(result.kind === "fallback" ? { category: result.category } : {}),
          }),
        );
        if (result.kind === "fallback" && !signal?.aborted)
          options.onWarning?.({ kind: "decision_fallback", category: result.category });
        return result;
      },
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
  const compactForRun = async (
    handle: RunHandle,
    signal: AbortSignal,
    keepLatestTurn: boolean,
  ): Promise<CompactionOutcome> => {
    handle.reportPhase("compacting");
    handle.notifyCompactionStarted();
    const tokenEstimate = runSettings.tokenEstimate;
    let outcome: CompactionOutcome;
    try {
      if (!recordsFresh) await resyncRecords();
      // 尾部保留预算不含 Prompt：planCompaction 的 walk-back 已按 Run 归属计入。
      const fixedTokens = estimateContextTokens({ ...built.context, messages: [] }, tokenEstimate);
      const feasibilityBudget =
        runModel.contextWindow -
        CONTEXT_SAFETY_MARGIN_TOKENS -
        runSettings.compactionSummaryTargetTokens -
        fixedTokens;
      // cap 只收紧 keepLatestTurn=true 的 (B)/溢出补救；keepLatestTurn=false 时下游忽略预算。
      const retainedCap = Math.min(
        Math.floor(runModel.contextWindow * runSettings.compactionRetainedContextRatio),
        runSettings.compactionRetainedContextMaxTokens,
      );
      outcome = await compactHistory({
        records,
        context: built.context,
        model: runModel,
        settings: runSettings,
        signal,
        retainedContextBudget: Math.min(feasibilityBudget, retainedCap),
        keepLatestTurn,
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
    handle.notifyCompactionFinished(
      outcome.status === "completed" && outcome.coveredUpTo !== null
        ? { status: "completed", path: outcome.path, coveredUpTo: outcome.coveredUpTo }
        : { status: outcome.status },
    );
    handle.reportPhase("streaming");
    if (outcome.status === "completed") {
      const tools = built.context.tools;
      const hasCurrentRunTurn = records.some(
        (record) => record.type === "assistant_message" && record.runId === handle.runId,
      );
      built = await buildContext({
        records,
        workspacePath: options.workspaceRoot,
        agentsMd: sessionAgentsMd,
        systemPrompt: options.systemPrompt,
        environment: options.environment,
        ...(keepLatestTurn && hasCurrentRunTurn ? {} : { currentPrompt: handle.prompt }),
      });
      // 复用原数组保证与上一次正式请求逐字节一致。
      built.context.tools = tools;
      contextTokens = estimateContextTokens(built.context, tokenEstimate);
      if (!isRequestFeasible(contextTokens, runModel.contextWindow)) {
        throw new Error(
          "Context length still exceeded after compaction. Use /compact or start a new Session.",
        );
      }
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
        permissionGate: (request) => manager.requestPermission(request, { signal }),
        onCleanupWarning: (path) => options.onWarning?.({ kind: "temporary_file_cleanup_failed", path }),
      });
      built.context.tools = executor.registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
      }));
      contextTokens = estimateContextTokens(built.context, runSettings.tokenEstimate);
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
              const outcome = await compactForRun(handle, signal, turn > 1);
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
              outcome = await compactForRun(handle, signal, true);
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
          if (signal.aborted) throw new TurnError("cancelled", response.attempts, "Run cancelled");
          handle.beginAttempt(turn, response.attempts);
          handle.finishAttempt("completed");
          if (signal.aborted) throw new TurnError("cancelled", response.attempts, "Run cancelled");
          currentIntent = response.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
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
              content: [{ type: "text" as const, text: result.content }],
              isError: result.status !== "success",
              timestamp: Date.now(),
            })),
          ];
          built.context.messages.push(...newMessages);
          for (const message of newMessages) {
            contextTokens += estimateMessageTokens(message, runSettings.tokenEstimate);
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
    sessionMeta = nextMeta;
    autoDecisionEnabled = nextMeta?.autoDecisionEnabled ?? true;
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
    decisionProbe = null;
    startDecisionProbe();
  };
  const compactor: CompactionDriver = {
    execute: async (signal) => {
      if (!ref) throw new Error("当前没有打开的 Session，无法压缩。");
      const model = structuredClone(currentModel());
      const settings = parseSettings(options.getSettings());
      if (!recordsFresh) await resyncRecords();
      const fresh = await buildContext({
        records,
        workspacePath: options.workspaceRoot,
        agentsMd: sessionAgentsMd,
        systemPrompt: options.systemPrompt,
        environment: options.environment,
      });
      for (const warning of fresh.warnings) options.onWarning?.(warning);
      const context = {
        ...fresh.context,
        tools: toolDefinitions(options.executorOptions?.platform, settings),
      };
      return compactHistory({
        records,
        context,
        model,
        settings,
        signal,
        retainedContextBudget: 0,
        keepLatestTurn: false,
        modelService: options.modelService,
        appendRecord: append,
      });
    },
  };
  const controller = new SessionController({
    driver,
    compactor,
    commands: {
      getAutoDecisionStatus: async () => {
        if (ref) {
          const meta = await options.store.readSessionMeta(ref);
          sessionMeta = meta;
          autoDecisionEnabled = meta.autoDecisionEnabled ?? true;
          metadataFresh = true;
        }
        return autoDecisionStatus();
      },
      setAutoDecisionEnabled: async (enabled) => {
        if (!metadataFresh) throw new Error("Query /autodecision to reload Session metadata first");
        if (ref) {
          try {
            sessionMeta = await options.store.setAutoDecisionEnabled(ref, enabled);
          } catch (error) {
            metadataFresh = false;
            try {
              sessionMeta = await options.store.readSessionMeta(ref);
              autoDecisionEnabled = sessionMeta.autoDecisionEnabled ?? true;
              metadataFresh = true;
            } catch {
              // An uncertain save blocks Runs until a metadata query succeeds.
            }
            throw error;
          }
        }
        autoDecisionEnabled = enabled;
        if (enabled) startDecisionProbe();
        else await stopDecisionProbe();
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
            preview: prompts.at(-1)?.text ?? "",
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
        await refreshBaseline();
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
        await refreshBaseline();
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
        runAutoDecisionEnabled = autoDecisionEnabled;
        runDecisionUnavailable = decisionProbe !== null;
        currentIntent = "";
        runModel = structuredClone(currentModel());
        runSettings = parseSettings(options.getSettings());
      },
      getSessionView: () => ({
        autoDecision: autoDecisionStatus(),
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
        contextBaselineTokens,
      }),
      closeSession: async () => {
        await stopDecisionProbe();
        await closePendingShells();
        if (ref) await options.store.releaseSession(ref);
      },
      assertCanStartRun: () => {
        if (!metadataFresh)
          throw new Error("Query /autodecision to reload Session metadata before starting a Run");
        if (shellBlocked) throw new Error("Shell termination is not confirmed. Cannot start a new Run.");
        gate.assertCanStartRun();
      },
      persistRunStart: async (runId, prompt) => {
        if (!recordsFresh) await resyncRecords();
        const prior = records.slice();
        const snapshot = createModelSnapshot(runModel);
        const initialRecords: NewSessionRecord[] = [
          { type: "user_prompt", runId, text: prompt },
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
            autoDecisionEnabled,
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
          workspacePath: options.workspaceRoot,
          agentsMd: sessionAgentsMd,
          systemPrompt: options.systemPrompt,
          environment: options.environment,
        });
        applyBaseline(built.context, runSettings);
        for (const warning of built.warnings) options.onWarning?.(warning);
      },
      persistRunFinished: async ({ runId, outcome, elapsedMs }) => {
        await append({ type: "run_finished", runId, outcome, elapsedMs, persisted: true });
      },
    },
  });

  await refreshBaseline();
  startDecisionProbe();

  return { controller, acknowledgeUnknownSideEffects: () => gate.acknowledge() };
}
