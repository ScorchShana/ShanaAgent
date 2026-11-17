import type { ReasoningEffort } from "../llm/model-config-store.js";
import type { CompactionOutcome } from "../sessions/compaction-store.js";
import type { SessionRef, SessionHistory } from "../sessions/session-store.js";
import { EventBus, type EventListener } from "./event-bus.js";
import type { CompactionFinishedEvent, FormalEvent } from "./events.js";
import {
  BusyError,
  InvalidStateError,
  NotImplementedCommandError,
  type ApprovalDecision,
  type ApprovalSummary,
  type ControllerSnapshot,
  type ControllerStatus,
  type LastRunInfo,
  type PendingApproval,
  type RunOutcome,
  type RunTiming,
  type RunPhase,
  type StreamingAttempt,
  type SessionView,
  type AutoDecisionStatus,
  type SessionListEntry,
} from "./state.js";

export interface ApprovalRequest {
  summary?: ApprovalSummary;
  toolCallId: string;
  toolName: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly prompt: string;
  reportPhase(phase: RunPhase): void;
  beginAttempt(turn: number, attempt: number): void;
  finishAttempt(status: "completed" | "failed" | "cancelled"): void;
  streamText(delta: string): void;
  streamThinking(delta: string): void;
  streamToolOutput(toolCallId: string, output: string): void;
  notifyToolStarted(toolCallId: string, toolName: string): void;
  notifyToolCompleted(toolCallId: string): Promise<void>;
  notifyCompactionStarted(): void;
  notifyCompactionFinished(result: Omit<CompactionFinishedEvent, "type" | "runId">): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export type LoopEnd =
  { outcome: "completed" } | { outcome: "turn_limit" } | { outcome: "failed"; error: unknown };

export interface AgentLoopDriver {
  execute(handle: RunHandle, signal: AbortSignal): Promise<LoopEnd>;
}

export interface CompactionDriver {
  // estimatedContextTokens：压后上下文纯估算，仅供状态栏即时显示，可选。
  execute(signal: AbortSignal): Promise<CompactionOutcome & { estimatedContextTokens?: number }>;
}

export interface ControllerCommands {
  getAutoDecisionStatus?(): Promise<AutoDecisionStatus>;
  setAutoDecisionEnabled?(enabled: boolean): Promise<void>;
  switchModel?(providerId: string, modelId: string): Promise<void>;
  setReasoningEffort?(effort: ReasoningEffort): Promise<void>;
  newSession?(): Promise<void>;
  resumeSession?(source: SessionRef): Promise<void>;
  listSessions?(): Promise<SessionListEntry[]>;
  readHistory?(): Promise<SessionHistory | null>;
}

export interface ControllerHooks {
  getSessionView?(): SessionView;
  captureRunInput?(): void;
  closeSession?(): Promise<void>;
  assertCanStartRun?(): void;
  persistRunStart?(runId: string, prompt: string): Promise<void>;
  persistToolCompleted?(toolCallId: string): Promise<void>;
  persistRunFinished?(info: { runId: string; outcome: RunOutcome; elapsedMs: number }): Promise<void>;
}

export interface SessionControllerOptions {
  now?: () => number;
  driver: AgentLoopDriver;
  commands?: ControllerCommands;
  bus?: EventBus;
  compactor?: CompactionDriver;
  hooks?: ControllerHooks;
  createId?: (prefix: string) => string;
}

interface RunContext {
  startedAt: number;
  elapsedMs: number | null;
  prompt: string;
  id: string;
  abortController: AbortController;
  cancellationAccepted: boolean;
  finished: boolean;
  finalOutcome: RunOutcome | null;
}

interface CompactionContext {
  abortController: AbortController;
  cancelled: boolean;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionController {
  private readonly now: () => number;
  private readonly bus: EventBus;
  private readonly driver: AgentLoopDriver;
  private readonly compactor: CompactionDriver | undefined;
  private readonly hooks: ControllerHooks;
  private readonly createId: (prefix: string) => string;

  private readonly commands: ControllerCommands;
  private commandPending = false;
  private commandPromise: Promise<unknown> | null = null;
  private closing = false;
  private exitPromise: Promise<void> | null = null;
  private status: ControllerStatus = { kind: "idle" };
  private pendingApproval: PendingApproval | null = null;
  private approvalResolve: ((decision: ApprovalDecision) => void) | null = null;
  private streamingFlush: NodeJS.Immediate | null = null;
  private streamingAttempts: StreamingAttempt[] = [];
  private attemptTextBase = "";
  private attemptThinkingBase = "";
  private accumulatedText = "";
  private accumulatedThinking = "";
  private lastRun: LastRunInfo | null = null;
  private currentRun: RunContext | null = null;
  private activeRunPromise: Promise<RunOutcome> | null = null;
  private activeCompactionPromise: Promise<CompactionOutcome> | null = null;
  private compaction: CompactionContext | null = null;
  // 最近一次成功压缩的压后估算；状态栏在实测被 checkpoint 覆盖时改用此值，/new、/resume 清空。
  private contextEstimateTokens: number | null = null;

  constructor(options: SessionControllerOptions) {
    this.now = options.now ?? (() => performance.now());
    this.bus = options.bus ?? new EventBus();
    this.driver = options.driver;
    this.commands = options.commands ?? {};
    this.compactor = options.compactor;
    this.hooks = options.hooks ?? {};
    const counters = new Map<string, number>();
    this.createId =
      options.createId ??
      ((prefix) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}-${next}`;
      });
  }

  get eventBus(): EventBus {
    return this.bus;
  }

  submitPrompt(text: string): Promise<RunOutcome> {
    if (this.closing) throw new InvalidStateError("Session is closed");
    if (this.commandPending) throw new BusyError("Session operation in progress");
    this.hooks.assertCanStartRun?.();
    const run = this.beginRun("submitPrompt");
    run.prompt = text;
    return this.driveRun(run);
  }

  cancel(): void | "已进入收尾" {
    if (this.status.kind === "running" && this.currentRun) {
      const run = this.currentRun;
      if (run.finalOutcome !== null) return "已进入收尾";
      if (run.finished || run.cancellationAccepted) return;
      run.cancellationAccepted = true;
      this.resolvePendingApproval("cancelled");
      run.abortController.abort();
      this.setPhase("cancelling");
      return;
    }
    if (this.status.kind === "compacting" && this.compaction) {
      this.compaction.cancelled = true;
      this.compaction.abortController.abort();
      return;
    }
    throw new InvalidStateError("cancel: 当前没有运行中的 Run 或压缩操作");
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    if (!this.pendingApproval || this.pendingApproval.id !== approvalId) {
      throw new InvalidStateError("approval.resolve: 没有匹配的待决审批");
    }
    this.resolvePendingApproval(decision);
  }

  compact(): Promise<CompactionOutcome> {
    if (this.commandPending) throw new BusyError("Session operation in progress");
    if (this.closing) throw new InvalidStateError("Session is closed");
    if (this.status.kind === "running") {
      throw new BusyError("compact: Run 进行中，压缩需等待其结束");
    }
    if (this.status.kind === "compacting") {
      throw new BusyError("compact: 已有压缩操作在进行");
    }
    const compactor = this.compactor;
    if (!compactor) throw new NotImplementedCommandError("/compact");
    this.status = { kind: "compacting" };
    const context: CompactionContext = { abortController: new AbortController(), cancelled: false };
    this.compaction = context;
    this.bus.publish({ type: "compaction.started" } satisfies FormalEvent);
    const operation = (async (): Promise<CompactionOutcome> => {
      try {
        const outcome = await compactor.execute(context.abortController.signal);
        const estimate = outcome.estimatedContextTokens;
        const validEstimate =
          typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
        if (validEstimate !== null) this.contextEstimateTokens = validEstimate;
        this.bus.publish({
          type: "compaction.finished",
          status: outcome.status,
          ...(outcome.status === "completed" && outcome.coveredUpTo !== null
            ? { path: outcome.path, coveredUpTo: outcome.coveredUpTo }
            : {}),
          ...(validEstimate !== null ? { contextTokens: validEstimate } : {}),
        } satisfies FormalEvent);
        return outcome;
      } catch (error) {
        this.bus.publish({
          type: "compaction.finished",
          status: "failed",
          error: toErrorMessage(error),
        } satisfies FormalEvent);
        throw error;
      } finally {
        this.compaction = null;
        if (this.status.kind === "compacting") {
          this.status = { kind: "idle" };
        }
      }
    })();
    const completion = operation.finally(() => {
      if (this.activeCompactionPromise === completion) {
        this.activeCompactionPromise = null;
      }
    });
    this.activeCompactionPromise = completion;
    return completion;
  }

  switchModel(providerId?: string, modelId?: string): Promise<void> {
    return this.command(
      "/model",
      this.commands.switchModel &&
        (() => {
          if (!providerId || !modelId) throw new InvalidStateError("Model reference is required");
          return this.commands.switchModel!(providerId, modelId);
        }),
    );
  }

  setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    return this.command(
      "reasoningEffort",
      this.commands.setReasoningEffort && (() => this.commands.setReasoningEffort!(effort)),
      true,
    );
  }

  newSession(): Promise<void> {
    return this.command(
      "/new",
      this.commands.newSession &&
        (async () => {
          await this.commands.newSession!();
          this.clearRunDisplay();
        }),
    );
  }

  resumeSession(source?: SessionRef): Promise<void> {
    return this.command(
      "/resume",
      this.commands.resumeSession &&
        (() => {
          if (!source) throw new InvalidStateError("Source Session is required");
          return this.commands.resumeSession!(source).then(() => {
            this.clearRunDisplay();
          });
        }),
    );
  }

  getAutoDecisionStatus(): Promise<AutoDecisionStatus> {
    return this.command("/autodecision", this.commands.getAutoDecisionStatus);
  }

  setAutoDecisionEnabled(enabled: boolean): Promise<void> {
    return this.command(
      "/autodecision",
      this.commands.setAutoDecisionEnabled && (() => this.commands.setAutoDecisionEnabled!(enabled)),
    );
  }

  listSessions(): Promise<SessionListEntry[]> {
    return this.command("listSessions", this.commands.listSessions);
  }

  readHistory(): Promise<SessionHistory | null> {
    if (this.closing) throw new InvalidStateError("Session is closed");
    if (!this.commands.readHistory) throw new NotImplementedCommandError("readHistory");
    return this.commands.readHistory();
  }

  private command<T>(name: string, action: (() => Promise<T>) | undefined, duringRun = false): Promise<T> {
    if (this.closing) throw new InvalidStateError("Session is closed");
    if (this.commandPending) throw new BusyError("Session operation in progress");
    if (!duringRun || this.status.kind === "compacting") this.assertNoActiveOperation(name);
    if (!action) throw new NotImplementedCommandError(name);
    this.commandPending = true;
    const operation = Promise.resolve().then(action);
    const completion = operation.finally(() => {
      this.commandPending = false;
      if (this.commandPromise === completion) this.commandPromise = null;
    });
    this.commandPromise = completion;
    return completion;
  }

  exit(): Promise<void> {
    if (this.exitPromise) return this.exitPromise;
    this.closing = true;
    this.exitPromise = Promise.resolve().then(async () => {
      try {
        if (this.status.kind === "running" || this.status.kind === "compacting") this.cancel();
        if (this.activeRunPromise) await this.activeRunPromise;
        // 压缩失败已报告给 compact() 调用方；exit 只等待收尾，不因此拒绝。
        if (this.activeCompactionPromise) await this.activeCompactionPromise.catch(() => {});
        if (this.commandPromise) await this.commandPromise;
      } finally {
        try {
          await this.hooks.closeSession?.();
        } finally {
          if (this.streamingFlush) clearImmediate(this.streamingFlush);
          this.streamingFlush = null;
        }
      }
    });
    return this.exitPromise;
  }

  getRunTiming(): RunTiming | null {
    const run = this.currentRun;
    if (!run || run.finished) return null;
    return { runId: run.id, elapsedMs: run.elapsedMs ?? this.measureRun(run) };
  }

  private measureRun(run: RunContext): number {
    return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(this.now() - run.startedAt)));
  }

  getSnapshot(): ControllerSnapshot {
    const session = this.hooks.getSessionView?.() ?? {
      ref: null,
      title: null,
      model: null,
      models: [],
      runModel: null,
      contextBaselineTokens: null,
      autoDecision: { enabled: true, availability: "missing" as const },
    };
    return structuredClone({
      runTiming: this.getRunTiming(),
      sessionOperation: this.commandPending,
      session: {
        ...session,
        contextEstimateTokens: this.contextEstimateTokens,
        runModel: this.status.kind === "running" ? session.runModel : null,
      },
      status: this.status,
      pendingApproval: this.pendingApproval,
      streamingAttempts: this.streamingAttempts,
      accumulatedText: this.accumulatedText,
      accumulatedThinking: this.accumulatedThinking,
      lastRun: this.lastRun,
    });
  }

  subscribe(listener: EventListener): { snapshot: ControllerSnapshot; unsubscribe: () => void } {
    const snapshot = this.getSnapshot();
    const unsubscribe = this.bus.subscribe(listener);
    return { snapshot, unsubscribe };
  }

  private clearRunDisplay(): void {
    this.streamingAttempts = [];
    this.accumulatedText = "";
    this.accumulatedThinking = "";
    this.lastRun = null;
    this.contextEstimateTokens = null;
  }

  private beginRun(command: string): RunContext {
    if (this.status.kind === "running") {
      throw new BusyError(`${command}: 已有 Run 进行中`);
    }
    if (this.status.kind === "compacting") {
      throw new InvalidStateError(`${command}: 压缩进行中，禁止提交 Prompt`);
    }
    const run: RunContext = {
      startedAt: this.now(),
      elapsedMs: null,
      prompt: "",
      id: this.createId("run"),
      abortController: new AbortController(),
      cancellationAccepted: false,
      finished: false,
      finalOutcome: null,
    };
    this.currentRun = run;
    this.pendingApproval = null;
    this.approvalResolve = null;
    this.streamingAttempts = [];
    this.attemptTextBase = "";
    this.attemptThinkingBase = "";
    this.accumulatedText = "";
    this.accumulatedThinking = "";
    this.status = { kind: "running", runId: run.id, phase: "preparing" };
    return run;
  }

  private async driveRun(run: RunContext): Promise<RunOutcome> {
    const drive = (async (): Promise<RunOutcome> => {
      try {
        this.hooks.captureRunInput?.();
      } catch (error) {
        return this.finalizeRun(run, "failed", { persisted: false, error });
      }
      this.bus.publish({ type: "run.started", runId: run.id } satisfies FormalEvent);
      try {
        await this.hooks.persistRunStart?.(run.id, run.prompt);
      } catch (error) {
        return this.finalizeRun(run, "failed", { persisted: false, error });
      }
      let end: LoopEnd;
      try {
        end = await this.driver.execute(this.makeHandle(run), run.abortController.signal);
      } catch (error) {
        end = { outcome: "failed", error };
      }
      const outcome: RunOutcome = run.cancellationAccepted
        ? "cancelled"
        : end.outcome === "failed"
          ? "failed"
          : end.outcome;
      run.finalOutcome = outcome;
      run.elapsedMs = this.measureRun(run);
      this.setPhase("finalizing");
      try {
        await this.hooks.persistRunFinished?.({ runId: run.id, outcome, elapsedMs: run.elapsedMs });
      } catch (error) {
        return this.finalizeRun(run, "failed", { persisted: false, error });
      }
      return this.finalizeRun(run, outcome, {
        persisted: true,
        error: end.outcome === "failed" ? end.error : undefined,
      });
    })();
    this.activeRunPromise = drive;
    try {
      return await drive;
    } finally {
      if (this.activeRunPromise === drive) {
        this.activeRunPromise = null;
      }
      if (this.currentRun === run) {
        this.currentRun = null;
      }
    }
  }

  private finalizeRun(
    run: RunContext,
    outcome: RunOutcome,
    options: { persisted: boolean; error?: unknown },
  ): RunOutcome {
    if (run.finished) {
      return run.finalOutcome ?? "failed";
    }
    run.finished = true;
    run.finalOutcome = outcome;
    this.lastRun = {
      runId: run.id,
      outcome,
      persisted: options.persisted,
      elapsedMs: run.elapsedMs ?? this.measureRun(run),
    };
    this.pendingApproval = null;
    this.approvalResolve = null;
    this.status = { kind: "idle" };
    this.bus.publish({
      type: "run.finished",
      runId: run.id,
      outcome,
      persisted: options.persisted,
      ...(options.error !== undefined ? { error: toErrorMessage(options.error) } : {}),
    } satisfies FormalEvent);
    return outcome;
  }

  private setPhase(phase: RunPhase): void {
    if (this.status.kind !== "running") return;
    this.status = { kind: "running", runId: this.status.runId, phase };
    this.bus.publish({ type: "run.state_changed", runId: this.status.runId, phase } satisfies FormalEvent);
  }

  private resolvePendingApproval(decision: ApprovalDecision): void {
    const approval = this.pendingApproval;
    const resolve = this.approvalResolve;
    this.pendingApproval = null;
    this.approvalResolve = null;
    resolve?.(decision);
    if (approval) this.bus.publish({ type: "permission.resolved", approvalId: approval.id, decision });
  }

  private assertNoActiveOperation(command: string): void {
    if (this.status.kind === "running") {
      throw new BusyError(`${command}: 活动 Run 期间不执行普通命令`);
    }
    if (this.status.kind === "compacting") {
      throw new InvalidStateError(`${command}: 压缩进行中`);
    }
  }

  private scheduleStreamingFlush(): void {
    if (this.streamingFlush) return;
    this.streamingFlush = setImmediate(() => {
      this.streamingFlush = null;
      this.bus.flushDeltas();
    });
  }

  private makeHandle(run: RunContext): RunHandle {
    return {
      runId: run.id,
      prompt: run.prompt,
      reportPhase: (phase) => {
        if (run.finished || run.cancellationAccepted) return;
        this.setPhase(phase);
      },
      beginAttempt: (turn, attempt) => {
        if (run.finished || run.cancellationAccepted) return;
        const last = this.streamingAttempts.at(-1);
        // 溢出补救后的同 Turn 重发从 attempt 1 重计，已失败的 attempt 不去重。
        if (last?.turn === turn && last.attempt === attempt && last.status === "streaming") return;
        this.bus.flushDeltas();
        if (run.finished || run.cancellationAccepted) return;
        this.attemptTextBase = this.accumulatedText;
        this.attemptThinkingBase = this.accumulatedThinking;
        this.streamingAttempts.push({ turn, attempt, status: "streaming", text: "", thinking: "" });
        this.setPhase("streaming");
      },
      finishAttempt: (status) => {
        const current = this.streamingAttempts.at(-1);
        if (run.finished || !current || current.status !== "streaming") return;
        this.bus.flushDeltas();
        current.status = status;
        if (status === "failed") {
          this.accumulatedText = this.attemptTextBase;
          this.accumulatedThinking = this.attemptThinkingBase;
        }
        if (!run.cancellationAccepted) this.setPhase("streaming");
      },
      streamText: (delta) => {
        if (run.finished || run.cancellationAccepted) return;
        this.accumulatedText += delta;
        const attempt = this.streamingAttempts.at(-1);
        if (attempt?.status === "streaming") attempt.text += delta;
        this.bus.offerDelta({ type: "llm.text.delta", runId: run.id, delta });
        this.scheduleStreamingFlush();
      },
      streamThinking: (delta) => {
        if (run.finished || run.cancellationAccepted) return;
        this.accumulatedThinking += delta;
        const attempt = this.streamingAttempts.at(-1);
        if (attempt?.status === "streaming") attempt.thinking += delta;
        this.bus.offerDelta({ type: "llm.thinking.delta", runId: run.id, delta });
        this.scheduleStreamingFlush();
      },
      streamToolOutput: (toolCallId, output) => {
        if (run.finished || run.cancellationAccepted) return;
        this.bus.publishStreaming({ type: "tool.output.delta", runId: run.id, toolCallId, delta: output });
      },
      notifyToolStarted: (toolCallId, toolName) => {
        if (run.finished) return;
        this.bus.publish({ type: "tool.started", runId: run.id, toolCallId, toolName } satisfies FormalEvent);
      },
      notifyToolCompleted: async (toolCallId) => {
        if (run.finished) return;
        await this.hooks.persistToolCompleted?.(toolCallId);
        this.bus.publish({ type: "tool.completed", runId: run.id, toolCallId } satisfies FormalEvent);
      },
      notifyCompactionStarted: () => {
        if (run.finished) return;
        this.bus.publish({ type: "compaction.started", runId: run.id } satisfies FormalEvent);
      },
      notifyCompactionFinished: (result) => {
        if (run.finished) return;
        const estimate = result.contextTokens;
        if (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0)
          this.contextEstimateTokens = estimate;
        this.bus.publish({
          type: "compaction.finished",
          runId: run.id,
          ...result,
        } satisfies FormalEvent);
      },
      requestApproval: (request) => {
        if (run.finished || run.cancellationAccepted) {
          return Promise.resolve("cancelled");
        }
        const approval: PendingApproval = {
          id: this.createId("approval"),
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          ...(request.summary ? { summary: structuredClone(request.summary) } : {}),
        };
        const pending = new Promise<ApprovalDecision>((resolve) => {
          this.approvalResolve = resolve;
        });
        this.pendingApproval = approval;
        this.setPhase("awaiting_approval");
        if (this.pendingApproval !== approval || run.cancellationAccepted) return pending;
        this.bus.publish({
          type: "permission.requested",
          approvalId: approval.id,
          runId: run.id,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          ...(request.summary ? { summary: structuredClone(request.summary) } : {}),
        } satisfies FormalEvent);
        return pending;
      },
    };
  }
}
