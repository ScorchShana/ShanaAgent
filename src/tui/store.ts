import { visibleWidth } from "./framework/index.js";
import { SessionController } from "../core/session-controller.js";
import type { ApprovalDecision, ControllerSnapshot, SessionListEntry } from "../core/state.js";
import {
  FAILED_REQUEST_ANNOTATION,
  INTERRUPTED_RESPONSE_ANNOTATION,
  PREVIOUS_REQUEST_INTERRUPTED_PREFIX,
  UNKNOWN_RESULT_ANNOTATION,
  planEffectiveContext,
  type EligibleTurn,
} from "../core/context-builder.js";
import { UnknownSideEffectsError } from "../sessions/recovery.js";
import { listSkillNames, splitSkillCommand } from "../core/skills.js";
import type { SessionHistory } from "../sessions/session-store.js";
import type { StoredToolCall, ToolResultRecord } from "../sessions/records.js";
import type { Settings } from "../llm/settings-store.js";
import { REASONING_EFFORTS } from "../llm/model-config-store.js";
import type { Diagnostics } from "../diagnostics.js";

export function formatDuration(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string): string[] =>
  Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
const DISPLAY_TAB_WIDTH = 4;
const ANSI_SEQUENCE = new RegExp(
  `${String.fromCharCode(27)}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|[@-_])`,
  "g",
);
// eslint-disable-next-line no-control-regex -- deliberately matches C0/C1 controls after newline and tab handling
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export function sanitizeDisplayText(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ".repeat(DISPLAY_TAB_WIDTH))
    .replace(CONTROL_CHARACTERS, "");
}
export const cellWidth = visibleWidth;
export const COMMANDS = [
  { name: "/autodecision", description: "查看或切换自动决策" },
  { name: "/model", description: "选择模型" },
  { name: "/effort", description: "调整后续 Run 的思考强度" },
  { name: "/new", description: "回到空白会话" },
  { name: "/resume", description: "选择历史会话并继续" },
  { name: "/compact", description: "压缩上下文" },
  { name: "/skill:", description: "显式调用 skill（/skill:<name> [请求]）" },
  { name: "/cancel", description: "取消当前运行" },
  { name: "/exit", description: "退出并清理 Session" },
  { name: "/quit", description: "退出并清理 Session（同 /exit）" },
] as const;
export interface CommandOption {
  name: string;
  description: string;
  enabled: boolean;
}
export type Modal =
  | { kind: "approval"; selection: number; diffExpanded?: boolean; scroll?: number }
  | { kind: "models"; selection: number; effortOnly: boolean }
  | { kind: "sessions"; selection: number; sessions: SessionListEntry[] }
  | {
      kind: "confirm";
      selection: number;
      purpose: "unknown";
      prompt?: string;
      shellMayBeRunning?: boolean;
    };
export interface ConversationItem {
  runId?: string;
  turn?: number;
  id: string;
  role:
    | "user"
    | "assistant"
    | "tool"
    | "notice"
    | "failure"
    | "attempt"
    | "diff"
    | "duration"
    | "compaction"
    | "skill";
  text: string;
  thinking?: string;
  failed?: boolean;
  cancelled?: boolean;
  dim?: boolean;
  // 缺结果 call 的合成 unknown 占位（与模型所见同构）；真实记录仍缺失，审计细节见提示文案。
  syntheticUnknown?: boolean;
  // compaction 分隔线携带的摘要正文，默认折叠、点击展开。
  summary?: string;
  // skill 块携带的快照正文（Markdown），默认折叠、点击展开；标题在 text（skill:<name>）。
  skillContent?: string;
  call?: StoredToolCall;
  result?: ToolResultRecord;
  activity?: "queued" | "running";
  liveOutput?: string;
  pendingApprovalId?: string;
}
export interface TuiState {
  closing?: boolean;
  core: ControllerSnapshot;
  history: SessionHistory | null;
  draft: string;
  modal: Modal | null;
  expanded: ReadonlySet<string>;
  expandedResults: ReadonlySet<string>;
  expandedDiffs: ReadonlySet<string>;
  // 仅展示层：审批结束后 app 依据 decision 决定追踪下一个工具还是追底。
  lastResolvedApproval: { id: string; decision: ApprovalDecision } | null;
  notice: { id: string; text: string; error: boolean } | null;
  retryPrompt: string | null;
}

export class TuiStore {
  private state: TuiState;
  private readonly listeners = new Set<(immediate: boolean) => void>();
  private immediateRender = false;
  private readonly unsubscribe: () => void;
  private scheduled: NodeJS.Immediate | null = null;
  private historyDirty = true;
  private historyRequest: Promise<void> | null = null;
  private runRequest: Promise<void> | null = null;
  private commandRequest: Promise<void> | null = null;
  private exitRequest: Promise<void> | null = null;
  private interruptDeadline = 0;
  private interruptTimer?: NodeJS.Timeout;
  private interruptNotice?: string;
  private disposed = false;
  private closing = false;
  private readonly exitNotices: string[] = [];
  private noticeId = 0;
  private readonly seenWarnings = new Set<string>();
  // 审批自动展开的卡片；用户手动 toggle 即接管（移出此集合），自动折叠只碰仍带标记的。
  private readonly autoExpanded = new Set<string>();
  private readonly attemptOwners = new Map<string, { runId: string; turn: number }>();
  private readonly executions = new Map<string, { completed: boolean; liveOutput?: string }[]>();
  private executionVersion = 0;
  private compactionSeparators: { id: string; label: string; anchorSeq: number | null }[] = [];
  private compactionVersion = 0;
  private compactionSeparatorId = 0;
  private historyCache: {
    history: TuiState["history"];
    executionVersion: number;
    compactionVersion: number;
    pendingSeq: number | undefined;
    items: ConversationItem[];
  } | null = null;
  private itemsCache: {
    history: TuiState["history"];
    signature: string;
    expanded: TuiState["expanded"];
    expandedResults: TuiState["expandedResults"];
    executionVersion: number;
    compactionVersion: number;
    items: ConversationItem[];
  } | null = null;

  constructor(
    readonly controller: SessionController,
    readonly settings: Settings,
    private readonly options: {
      redact?: (text: string) => string;
      onExit?: (error?: Error) => void;
      workspace?: string;
      diagnostics?: Diagnostics;
      // skills 根可注入（测试用临时目录）；缺省 ~/.shana/skills。
      skillsRoot?: string;
    } = {},
  ) {
    const subscription = controller.subscribe((event) => {
      this.clearInterrupt();
      if (event.type === "permission.requested" || event.type === "permission.resolved") { this.executionVersion++; this.historyDirty = true; }
      if (event.type === "permission.resolved")
        this.update({ lastResolvedApproval: { id: event.approvalId, decision: event.decision } });
      if (event.type === "run.started") {
        this.update({ notice: null });
      }
      if (event.type === "tool.started") {
        this.executionVersion++;
        const key = `${event.runId}:${event.toolCallId}`;
        this.executions.set(key, [...(this.executions.get(key) ?? []), { completed: false }]);
      }
      if (event.type === "tool.completed") {
        this.executionVersion++;
        const execution = this.executions.get(`${event.runId}:${event.toolCallId}`)?.at(-1);
        if (execution) {
          execution.completed = true;
          execution.liveOutput = undefined;
        }
      }
      if (event.type === "tool.output.delta") {
        const execution = this.executions.get(`${event.runId}:${event.toolCallId}`)?.at(-1);
        if (execution && !execution.completed) {
          execution.liveOutput = event.delta;
          this.executionVersion++;
        }
      }
      if (
        event.type === "run.finished" ||
        (event.type === "run.state_changed" && event.phase === "cancelling")
      ) {
        for (const occurrences of this.executions.values())
          for (const execution of occurrences) execution.liveOutput = undefined;
        this.executionVersion++;
      }
      if (event.type === "compaction.started" && controller.getSnapshot().session.ref) {
        this.compactionSeparators.push({
          id: `compaction-live-${++this.compactionSeparatorId}`,
          label: "compacting",
          anchorSeq: null,
        });
        this.compactionVersion++;
      }
      if (event.type === "compaction.finished") {
        const live = this.compactionSeparators.find((separator) => separator.label === "compacting");
        if (live) {
          if (event.status === "completed" || event.status === "noop")
            this.compactionSeparators.splice(this.compactionSeparators.indexOf(live), 1);
          else {
            live.label = event.status === "cancelled" ? "compaction cancelled" : "compaction failed";
            live.anchorSeq = this.state.history ? (this.state.history.records.at(-1)?.recordSeq ?? 0) : null;
          }
        }
        this.compactionVersion++;
        this.historyDirty = true;
      }
      if (event.type === "run.finished") this.rememberAttemptOwners(controller.getSnapshot());
      if (event.type === "run.finished" && event.error) this.notice(event.error, true);
      if (
        event.type === "run.finished" ||
        event.type === "tool.started" ||
        event.type === "tool.completed" ||
        (event.type === "run.state_changed" && event.phase === "streaming")
      )
        this.historyDirty = true;
      if (
        event.type === "llm.text.delta" ||
        event.type === "llm.thinking.delta" ||
        event.type === "tool.output.delta"
      )
        this.schedule(false);
      else this.schedule();
    });
    this.unsubscribe = subscription.unsubscribe;
    this.state = {
      core: subscription.snapshot,
      history: null,
      draft: "",
      modal: null,
      expanded: new Set(),
      expandedResults: new Set(),
      expandedDiffs: new Set(),
      lastResolvedApproval: null,
      notice: null,
      retryPrompt: null,
    };
    this.schedule();
  }
  getRunTiming = () => this.controller.getRunTiming();
  getSnapshot = (): TuiState => this.state;
  subscribe = (listener: (immediate: boolean) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get workspace(): string {
    return this.options.workspace ?? process.cwd();
  }
  redact(text: string): string {
    return this.options.redact?.(text) ?? text;
  }
  private update(patch: Partial<TuiState>): void {
    if (!this.disposed) {
      this.state = { ...this.state, ...patch };
      this.schedule();
    }
  }
  private rememberAttemptOwners(core: ControllerSnapshot): void {
    const runId = core.status.kind === "running" ? core.status.runId : core.lastRun?.runId;
    if (!runId) return;
    for (const attempt of core.streamingAttempts)
      if (attempt.status === "completed")
        this.attemptOwners.set(`attempt-${runId}-${attempt.turn}-${attempt.attempt}`, {
          runId,
          turn: attempt.turn,
        });
  }
  private syncCore(): void {
    const core = this.controller.getSnapshot();
    const previousRef = this.state.core.session.ref;
    if (
      previousRef &&
      (previousRef.sessionId !== core.session.ref?.sessionId ||
        previousRef.workspaceId !== core.session.ref?.workspaceId)
    ) {
      this.attemptOwners.clear();
      this.executions.clear();
      this.autoExpanded.clear();
      this.executionVersion++;
      this.compactionSeparators = [];
      this.compactionVersion++;
      this.state = {
        ...this.state,
        history: null,
        expanded: new Set(),
        expandedResults: new Set(),
        expandedDiffs: new Set(),
        lastResolvedApproval: null,
        retryPrompt: null,
      };
    }
    this.rememberAttemptOwners(core);
    let modal = this.state.modal;
    if (core.pendingApproval && modal?.kind !== "approval") modal = { kind: "approval", selection: 0 };
    if (!core.pendingApproval && modal?.kind === "approval") modal = null;

    this.state = { ...this.state, core, modal };
  }
  private schedule(immediate = true): void {
    this.immediateRender ||= immediate;
    if (this.scheduled || this.disposed) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      if (this.disposed) return;
      this.syncCore();
      const immediate = this.immediateRender;
      this.immediateRender = false;
      for (const listener of this.listeners) listener(immediate);
      if (this.historyDirty && !this.historyRequest) {
        this.historyDirty = false;
        this.historyRequest = this.refreshHistory().finally(() => {
          this.historyRequest = null;
          if (this.historyDirty) this.schedule();
        });
      }
    });
  }
  async refreshHistory(): Promise<void> {
    if (this.closing) return;
    const ref = this.controller.getSnapshot().session.ref;
    if (!ref) return;
    try {
      const history = await this.controller.readHistory();
      if (!history) return;
      const current = this.controller.getSnapshot().session.ref;
      if (this.disposed || current?.sessionId !== ref.sessionId || current.workspaceId !== ref.workspaceId)
        return;
      const changedSession =
        this.state.history !== null && this.state.history.meta.sessionId !== history.meta.sessionId;
      const oldLast = this.state.history?.records.at(-1)?.recordSeq ?? 0;
      const newLast = history.records.at(-1)?.recordSeq ?? 0;
      if (!changedSession && newLast < oldLast) return;
      const expanded = new Set(this.state.expanded);
      this.rememberAttemptOwners(this.controller.getSnapshot());
      if (changedSession) this.attemptOwners.clear();
      for (const [from, attempt] of this.attemptOwners) {
        const owner = history.records.filter(
          (r) => r.type === "assistant_message" && r.runId === attempt.runId,
        )[attempt.turn - 1];
        if (!owner) continue;
        const to = `assistant-${owner.recordSeq}`;
        if (expanded.delete(from)) expanded.add(to);
        this.attemptOwners.delete(from);
      }
      if (changedSession) {
        this.autoExpanded.clear();
        this.update({ expanded: new Set<string>(), retryPrompt: null });
      }
      this.update({
        history,
        expanded,
      });
      for (const warning of history.warnings) {
        const key = `${history.meta.sessionId}:${warning.kind}:${warning.line}:${warning.byteOffset}`;
        if (!this.seenWarnings.has(key)) {
          this.seenWarnings.add(key);
          this.notice(warning.message);
        }
      }
    } catch (error) {
      this.error(error);
    }
  }
  notice(text: string, error = false): void {
    const safe = this.redact(text);
    if (this.closing && !this.exitNotices.includes(safe)) this.exitNotices.push(safe);
    this.update({ notice: { id: `notice-${++this.noticeId}`, text: safe, error } });
  }
  private error(error: unknown): void {
    this.notice(error instanceof Error ? error.message : String(error), true);
  }
  setDraft(draft: string): void {
    this.clearInterrupt();
    const text = sanitizeDisplayText(draft);
    this.update({
      draft: text,
    });
  }
  openModels(effortOnly = false): void {
    if (!effortOnly && this.controller.getSnapshot().status.kind !== "idle") {
      this.notice("运行中不能切换模型。");
      return;
    }
    if (!this.state.core.session.model) {
      this.notice("请手动编辑 model.json 配置模型。");
      return;
    }
    const index = effortOnly
      ? REASONING_EFFORTS.indexOf(
          this.state.core.session.model.reasoningEffort as (typeof REASONING_EFFORTS)[number],
        )
      : this.state.core.session.models.findIndex(
          (m) =>
            m.modelId === this.state.core.session.model?.modelId &&
            m.providerId === this.state.core.session.model?.providerId,
        );
    this.update({ modal: { kind: "models", selection: Math.max(0, index), effortOnly } });
  }
  dismissModal(): void {
    if (this.state.modal?.kind === "approval") {
      const approval = this.controller.getSnapshot().pendingApproval;
      if (approval) this.controller.resolveApproval(approval.id, "cancelled");
    }
    this.update({ modal: null });
  }
  private command(action: () => Promise<void>): Promise<void> {
    if (this.commandRequest || this.closing) return Promise.resolve();
    let operation: Promise<void>;
    try {
      operation = action();
      this.syncCore();
    } catch (error) {
      this.error(error);
      return Promise.resolve();
    }
    const completion = operation
      .then(() => {
        this.syncCore();
        this.historyDirty = true;
        this.schedule();
      })
      .catch((error) => this.error(error))
      .finally(() => {
        if (this.commandRequest === completion) this.commandRequest = null;
      });
    this.commandRequest = completion;
    return completion;
  }
  commandOptions(): CommandOption[] {
    const core = this.controller.getSnapshot();
    const idle = core.status.kind === "idle" && !this.runRequest;
    // / 菜单按需读目录（无缓存）：运行期间新增 skill 立即可补全；缺目录 → 空列表。
    const skillEnabled =
      !this.closing && !core.sessionOperation && !core.pendingApproval && idle;
    const skills = listSkillNames(this.options.skillsRoot)
      .map((name) => ({ name: `/skill:${name}`, description: "显式调用 skill", enabled: skillEnabled }))
      .filter((option) => option.name.startsWith(this.state.draft));
    // /skill: 前缀只列具体 skill（占位项无意义）；其余 / 前缀命令在前、skill 追加在后。
    if (this.state.draft.startsWith("/skill:")) return skills;
    const commands = COMMANDS.filter((option) => option.name.startsWith(this.state.draft)).map((option) => ({
      ...option,
      enabled:
        !this.closing &&
        !core.sessionOperation &&
        !core.pendingApproval &&
        (option.name === "/effort"
          ? core.status.kind !== "compacting" && !!core.session.model
          : option.name === "/cancel"
            ? core.status.kind !== "idle"
            : option.name === "/exit" || option.name === "/quit"
              ? true
              : option.name === "/model"
                ? idle && !!core.session.model
                : idle),
    }));
    return [...commands, ...skills];
  }
  submit(): Promise<void> {
    if (/^\/autodecision(?:\s|$)/.test(this.state.draft.trim()) && !this.closing && !this.state.modal) {
      if (
        this.controller.getSnapshot().status.kind !== "idle" ||
        this.state.core.sessionOperation ||
        this.commandRequest
      ) {
        this.notice("/autodecision: Session operation in progress", true);
        return Promise.resolve();
      }
      return this.submitCommand(this.state.draft.trim());
    }
    if (
      !this.closing &&
      !this.state.modal &&
      !this.controller.getSnapshot().pendingApproval &&
      !this.state.core.sessionOperation &&
      (this.controller.getSnapshot().status.kind !== "compacting" || this.state.draft.trim() !== "/effort") &&
      ["/effort", "/cancel", "/exit", "/quit"].includes(this.state.draft.trim())
    )
      return this.submitCommand(this.state.draft.trim());
    if (
      this.closing ||
      this.runRequest ||
      this.controller.getSnapshot().status.kind !== "idle" ||
      this.state.core.sessionOperation
    )
      return Promise.resolve();
    const prompt = this.state.draft;
    if (!prompt.trim()) {
      if (this.state.retryPrompt) {
        const retry = sanitizeDisplayText(this.state.retryPrompt);
        this.update({
          draft: retry,
          retryPrompt: null,
        });
      }
      return Promise.resolve();
    }
    // /skill: 是 Prompt 而非命令：放行进 submitPrompt（Core 权威解析），其余 / 走命令。
    if (prompt.startsWith("/") && !prompt.startsWith("/skill:"))
      return this.submitCommand(prompt.trim());
    if (!this.controller.getSnapshot().session.model) {
      this.notice("请手动编辑 model.json 配置模型。", true);
      return Promise.resolve();
    }
    let operation: ReturnType<SessionController["submitPrompt"]>;
    try {
      operation = this.controller.submitPrompt(prompt);
    } catch (error) {
      if (error instanceof UnknownSideEffectsError)
        this.update({
          modal: {
            kind: "confirm",
            selection: 1,
            purpose: "unknown",
            prompt,
            shellMayBeRunning: error.unknownResults.some((r) => r.toolName === "bash"),
          },
        });
      else this.error(error);
      return Promise.resolve();
    }
    this.update({
      draft: "",
      retryPrompt: null,
    });
    this.syncCore();
    const completion = operation
      .then(async (outcome) => {
        await this.refreshHistory();
        if (outcome === "failed" || outcome === "cancelled" || outcome === "turn_limit") {
          const runId = this.controller.getSnapshot().lastRun?.runId;
          const runs = this.state.history ? planEffectiveContext(this.state.history.records).runs : [];
          const current = runs.find((r) => r.prompt?.runId === runId);
          this.update({ retryPrompt: current?.turns.length ? "继续完成之前的任务" : prompt });
        }
      })
      .catch((error) => this.error(error))
      .finally(() => {
        if (this.runRequest === completion) this.runRequest = null;
        this.schedule();
      });
    this.runRequest = completion;
    return completion;
  }
  private submitCommand(command: string): Promise<void> {
    this.setDraft("");
    if (/^\/autodecision(?:\s|$)/.test(command)) {
      const parts = command.split(/\s+/);
      if (parts.length > 2 || (parts[1] !== undefined && !["on", "off"].includes(parts[1]))) {
        this.notice("用法：/autodecision [on|off]", true);
        return Promise.resolve();
      }
      return this.command(async () => {
        if (parts[1]) await this.controller.setAutoDecisionEnabled(parts[1] === "on");
        const status = parts[1]
          ? this.controller.getSnapshot().session.autoDecision
          : await this.controller.getAutoDecisionStatus();
        this.notice(
          `Auto Decision: ${status.enabled ? "On" : "Off"} · ${status.availability}${status.message ? ` · ${status.message}` : ""}`,
        );
      });
    }
    const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(command);
    if (compact) {
      // 参数是本次压缩的附加重点：只透传给摘要请求，不落盘。
      const focus = compact[1]?.trim() || undefined;
      return this.command(async () => {
        const outcome = await this.controller.compact(focus);
        if (outcome.status === "completed") this.notice("压缩完成");
        else if (outcome.status === "noop") this.notice("No context to compact");
        else this.notice("压缩已取消");
      });
    }
    switch (command) {
      case "/effort":
        this.openModels(true);
        return Promise.resolve();
      case "/model":
        this.openModels();
        return Promise.resolve();
      case "/new":
        return this.command(async () => {
          await this.controller.newSession();
          this.update({ notice: null });
        });
      case "/resume":
        return this.command(async () => {
          const sessions = await this.controller.listSessions();
          this.update({ modal: { kind: "sessions", selection: 0, sessions } });
        });
      case "/cancel":
        this.cancel();
        return Promise.resolve();
      case "/quit":
      case "/exit":
        if (this.controller.getSnapshot().status.kind === "idle") this.requestExit();
        else this.startExit();
        return Promise.resolve();
      default:
        this.notice(
          "未知命令。可用：/model /effort /new /resume /compact /skill: /autodecision /cancel /exit",
          true,
        );
        return Promise.resolve();
    }
  }
  cancel(): void {
    try {
      const result = this.controller.cancel();
      this.notice(result === "已进入收尾" ? result : "正在取消并等待收尾…");
    } catch (error) {
      this.error(error);
    }
  }
  clearInterrupt(): void {
    this.interruptDeadline = 0;
    clearTimeout(this.interruptTimer);
    this.interruptTimer = undefined;
    if (this.interruptNotice && this.state.notice?.id === this.interruptNotice) this.update({ notice: null });
    this.interruptNotice = undefined;
  }
  interrupt(): void {
    if (this.controller.getSnapshot().status.kind !== "idle") {
      this.clearInterrupt();
      this.cancel();
      return;
    }
    if (Date.now() < this.interruptDeadline) {
      this.requestExit();
      return;
    }
    this.clearInterrupt();
    this.interruptDeadline = Date.now() + this.settings.ctrlCExitWindowMs;
    this.notice(`${this.settings.ctrlCExitWindowMs / 1000} 秒内再次按 Ctrl+C 退出`);
    this.interruptNotice = this.state.notice?.id;
    this.interruptTimer = setTimeout(() => this.clearInterrupt(), this.settings.ctrlCExitWindowMs);
  }
  requestExit(): void {
    this.clearInterrupt();
    this.startExit();
  }
  private startExit(): void {
    this.exitRequest ??= this.dispose()
      .then(() => this.options.onExit?.())
      .catch((error) => this.options.onExit?.(error instanceof Error ? error : new Error(String(error))));
  }
  getExitNotices(): readonly string[] {
    return this.exitNotices;
  }
  moveModal(delta: number): void {
    this.clearInterrupt();
    const modal = this.state.modal;
    if (!modal || (this.commandRequest && modal.kind !== "approval")) return;
    const count =
      modal.kind === "approval"
        ? 3
        : modal.kind === "models"
          ? modal.effortOnly
            ? REASONING_EFFORTS.length
            : this.state.core.session.models.length + 1
          : modal.kind === "sessions"
            ? modal.sessions.length
            : 2;
    if (count) this.update({ modal: { ...modal, selection: (modal.selection + delta + count) % count } });
  }
  confirmModal(): Promise<void> {
    const modal = this.state.modal;
    if (!modal) return Promise.resolve();
    if (modal.kind === "approval") {
      const approval = this.controller.getSnapshot().pendingApproval;
      if (approval)
        this.controller.resolveApproval(
          approval.id,
          (["once", "session", "deny"] as const)[modal.selection]!,
        );
      this.update({ modal: null });
      return Promise.resolve();
    }
    if (modal.kind === "models") {
      if (!modal.effortOnly && modal.selection === this.state.core.session.models.length) {
        this.openModels(true);
        return Promise.resolve();
      }
      return this.command(async () => {
        if (modal.effortOnly) await this.controller.setReasoningEffort(REASONING_EFFORTS[modal.selection]!);
        else {
          const model = this.state.core.session.models[modal.selection];
          if (!model) return;
          await this.controller.switchModel(model.providerId, model.modelId);
        }
        if (this.state.modal === modal) this.update({ modal: null });
      });
    }
    if (modal.kind === "sessions") {
      const selected = modal.sessions[modal.selection];
      if (!selected) return Promise.resolve();
      return this.command(async () => {
        await this.controller.resumeSession({ workspaceId: selected.workspaceId, sessionId: selected.sessionId });
        if (this.state.modal === modal) this.update({ modal: null, notice: null });
      });
    }
    if (modal.selection !== 0) {
      this.dismissModal();
      return Promise.resolve();
    }
    if (modal.purpose === "unknown") return this.acknowledgeAndSubmit();
    return Promise.resolve();
  }
  private acknowledgeUnknown?: () => void;
  setExitHandler(action: (error?: Error) => void): void {
    this.options.onExit = action;
  }
  setUnknownAcknowledgement(action: () => void): void {
    this.acknowledgeUnknown = action;
  }
  acknowledgeAndSubmit(): Promise<void> {
    const modal = this.state.modal;
    if (modal?.kind !== "confirm" || modal.purpose !== "unknown" || modal.selection !== 0)
      return Promise.resolve();
    this.acknowledgeUnknown?.();
    this.update({ modal: null });
    return this.submit();
  }
  toggleResult(id: string): void {
    const expandedResults = new Set(this.state.expandedResults);
    if (!expandedResults.delete(id)) expandedResults.add(id);
    this.update({ expandedResults });
  }
  toggleDiff(id: string): void {
    const expandedDiffs = new Set(this.state.expandedDiffs);
    if (!expandedDiffs.delete(id)) expandedDiffs.add(id);
    this.update({ expandedDiffs });
  }
  // 审批到达时自动展开；已被用户展开的不动也不标记，结束后不折叠它。
  autoExpand(id: string): void {
    if (this.state.expanded.has(id)) return;
    this.autoExpanded.add(id);
    this.update({ expanded: new Set([...this.state.expanded, id]) });
  }
  releaseAutoExpanded(): void {
    if (this.autoExpanded.size === 0) return;
    const expanded = new Set(this.state.expanded);
    for (const id of this.autoExpanded) expanded.delete(id);
    this.autoExpanded.clear();
    this.update({ expanded });
  }
  toggle(id: string): void {
    this.autoExpanded.delete(id);
    const expanded = new Set(this.state.expanded);
    let expandedResults: ReadonlySet<string> = this.state.expandedResults;
    if (expanded.has(id)) {
      expanded.delete(id);
      if (expandedResults.has(id)) {
        const next = new Set(expandedResults);
        next.delete(id);
        expandedResults = next;
      }
    } else expanded.add(id);
    this.update({ expanded, expandedResults });
  }
  private pendingRecordSeq(): number | undefined {
    const status = this.state.core.status;
    if (status.kind !== "running") return undefined;
    const records = this.state.history?.records ?? [];
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (record.type === "assistant_message" && record.runId === status.runId) return record.recordSeq;
    }
    return undefined;
  }
  private persistedItems(): ConversationItem[] {
    const pendingSeq = this.pendingRecordSeq();
    if (
      this.historyCache?.history === this.state.history &&
      this.historyCache.executionVersion === this.executionVersion &&
      this.historyCache.compactionVersion === this.compactionVersion &&
      this.historyCache.pendingSeq === pendingSeq
    )
      return this.withDiffs(this.historyCache.items);
    const records = this.state.history?.records ?? [];
    const plan = planEffectiveContext(records);
    const failed = new Set(plan.runs.flatMap((r) => r.excludedTurns.map((t) => t.assistant.recordSeq)));
    // 在途 Turn（执行中/等待审批）尚无结果，与崩溃窗口在记录层同形；planEffectiveContext
    // 会把它判为缺结果 unknown，展示层按 pendingSeq 豁免合成标记，Run 收尾后自动恢复崩溃窗口语义。
    if (pendingSeq !== undefined) failed.delete(pendingSeq);
    // 零 Turn 失败 Run：Prompt 恒进上下文，展示同构地附失败标注；零 Turn 取消 Run 的中断
    // 信息由下一条 Prompt 前置的 notice 承载（与模型所见的渲染期前缀同构）。
    const interruptedPrompts = new Set(
      plan.runs
        .filter((r) => r.followsCancelledZeroTurn && r.prompt !== null)
        .map((r) => r.prompt!.recordSeq),
    );
    const failedPrompts = new Set(
      plan.runs
        .filter((r) => r.failed && r.turns.length === 0 && r.prompt !== null)
        .map((r) => r.prompt!.recordSeq),
    );
    const eligibleTurns = new Map<number, EligibleTurn>(
      plan.runs.flatMap((r) => r.turns).map((turn) => [turn.assistant.recordSeq, turn]),
    );
    const results = new Map(
      records
        .filter((r): r is ToolResultRecord => r.type === "tool_result")
        .map((result) => [`${result.assistantRecordSeq}:${result.toolCallId}`, result]),
    );
    const items: ConversationItem[] = [];
    const separators: { anchor: number; item: ConversationItem }[] = [];
    for (const record of records)
      if (record.type === "checkpoint")
        separators.push({
          anchor: record.recordSeq,
          item: {
            id: `compaction-${record.recordSeq}`,
            role: "compaction",
            text: "compacted",
            summary: record.summary,
          },
        });
    for (const separator of this.compactionSeparators)
      separators.push({
        anchor: separator.anchorSeq ?? Infinity,
        item: { id: separator.id, role: "compaction", text: separator.label },
      });
    separators.sort((a, b) => a.anchor - b.anchor);
    let separatorIndex = 0;
    const flushSeparators = (before: number): void => {
      while (separatorIndex < separators.length && separators[separatorIndex]!.anchor < before) {
        items.push(separators[separatorIndex]!.item);
        separatorIndex++;
      }
    };
    const callCounts = new Map<string, number>();
    const turns = new Map<string, number>();
    for (const record of records) {
      // Run 收尾行（取消/失败标记、耗时）属于前面的展示块，分隔线不越过它们。
      if (record.type !== "run_finished") flushSeparators(record.recordSeq);
      if (record.type === "user_prompt") {
        // 前缀 notice 在 Prompt 之前：模型所见前缀搭乘本条 Prompt，气泡仍显示记录原文。
        if (interruptedPrompts.has(record.recordSeq))
          items.push({
            id: `interrupted-prompt-${record.recordSeq}`,
            role: "notice",
            text: PREVIOUS_REQUEST_INTERRUPTED_PREFIX.trimEnd(),
          });
        // skill 块在气泡之前（与模型所见顺序同构）；气泡只显示请求原文，命令信息由 skill 块承载。
        const command = record.skill ? splitSkillCommand(record.text) : null;
        if (record.skill && command) {
          items.push({
            id: `skill-${record.recordSeq}`,
            role: "skill",
            text: `skill:${record.skill.name}`,
            skillContent: record.skill.content,
          });
          if (command.request.trim())
            items.push({
              id: `prompt-${record.recordSeq}`,
              role: "user",
              text: command.request,
            });
        } else {
          items.push({
            id: `prompt-${record.recordSeq}`,
            role: "user",
            text: record.text,
          });
        }
        if (failedPrompts.has(record.recordSeq))
          items.push({
            id: `failed-prompt-${record.recordSeq}`,
            role: "notice",
            text: FAILED_REQUEST_ANNOTATION,
          });
      }
      if (record.type === "interruption")
        items.push({
          id: `interruption-${record.recordSeq}`,
          role: "notice",
          text: this.redact(`运行中断：${record.reason}`),
        });
      if (record.type === "run_finished" && record.outcome !== "completed")
        items.push(
          record.outcome === "cancelled"
            ? {
                id: `outcome-${record.recordSeq}`,
                role: "failure",
                text: "✗ 已取消",
                cancelled: true,
              }
            : {
                id: `outcome-${record.recordSeq}`,
                role: "failure",
                text: this.redact(`运行${{ failed: "失败", turn_limit: "达到轮数上限" }[record.outcome]}`),
                failed: true,
              },
        );
      if (record.type === "run_finished" && record.elapsedMs !== undefined)
        items.push({
          id: `duration-${record.runId}`,
          role: "duration",
          text: `Worked for ${formatDuration(record.elapsedMs)}`,
          dim: true,
        });
      if (record.type !== "assistant_message") continue;
      const turn = (turns.get(record.runId) ?? 0) + 1;
      turns.set(record.runId, turn);
      const id = `assistant-${record.recordSeq}`;
      const text = record.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      // aborted 的半截推理与上下文同构不显示（构建上下文时剥离）；旧记录盘上可能仍含 thinking。
      const thinking =
        record.message.stopReason === "aborted"
          ? ""
          : record.message.content
              .filter((b) => b.type === "thinking")
              .map((b) => b.thinking)
              .join("");
      if (text || thinking)
        items.push({
          id,
          runId: record.runId,
          turn,
          role: "assistant",
          text,
          thinking,
          failed: failed.has(record.recordSeq),
          cancelled: record.message.stopReason === "aborted",
        });
      if (failed.has(record.recordSeq))
        items.push({
          id: `failed-${record.recordSeq}`,
          runId: record.runId,
          turn,
          role: "failure",
          text: "此轮未进入有效上下文",
          failed: true,
        });
      const eligible = eligibleTurns.get(record.recordSeq);
      for (const call of record.message.content.filter((b): b is StoredToolCall => b.type === "toolCall")) {
        const matched = results.get(`${record.recordSeq}:${call.id}`);
        const result =
          matched?.runId === record.runId && matched.toolName === call.name ? matched : undefined;
        const key = `${record.runId}:${call.id}`;
        const index = callCounts.get(key) ?? 0;
        const execution =
          record.message.stopReason === "length" ? undefined : this.executions.get(key)?.[index];
        if (record.message.stopReason !== "length") callCounts.set(key, index + 1);
        items.push({
          id: `tool-${record.recordSeq}-${call.id}`,
          runId: record.runId,
          turn,
          role: "tool",
          text: call.name,
          call,
          result,
          failed: failed.has(record.recordSeq),
          syntheticUnknown:
            record.recordSeq !== pendingSeq &&
            (eligible?.missingCalls.some((missing) => missing.toolCallId === call.id) ?? false),
          activity: execution && !execution.completed ? "running" : "queued",
          liveOutput: execution && !execution.completed ? execution.liveOutput : undefined,
          pendingApprovalId: !result && execution && !execution.completed && execution === this.executions.get(key)?.at(-1) && this.state.core.status.kind === "running" && record.runId === this.state.core.status.runId && this.state.core.pendingApproval?.toolCallId === call.id && this.state.core.pendingApproval.toolName === call.name ? this.state.core.pendingApproval.id : undefined,
        });
      }
      // 进入上下文的 aborted/unknown Turn 同构展示标注（被排除的 Turn 不注入上下文，也不标注）。
      if (record.message.stopReason === "aborted" && !failed.has(record.recordSeq))
        items.push({
          id: `interrupted-${record.recordSeq}`,
          runId: record.runId,
          turn,
          role: "notice",
          text: INTERRUPTED_RESPONSE_ANNOTATION,
        });
      if (eligible?.hasUnknown && record.recordSeq !== pendingSeq)
        items.push({
          id: `unknown-${record.recordSeq}`,
          runId: record.runId,
          turn,
          role: "notice",
          text: UNKNOWN_RESULT_ANNOTATION,
        });
    }
    while (separatorIndex < separators.length) {
      items.push(separators[separatorIndex]!.item);
      separatorIndex++;
    }
    this.historyCache = {
      history: this.state.history,
      executionVersion: this.executionVersion,
      compactionVersion: this.compactionVersion,
      pendingSeq,
      items,
    };
    return this.withDiffs(items);
  }
  // expanded 只决定是否在 tool item 后插入 diff item；基础 item 与 expanded 无关，
  // 缓存键不含 expanded，diff item 按 tool item 复用，避免折叠切换重建整段历史。
  private diffItemCache = new WeakMap<ConversationItem, ConversationItem>();
  private withDiffs(baseItems: ConversationItem[]): ConversationItem[] {
    const expanded = this.state.expanded;
    const diffable = (item: ConversationItem): boolean =>
      item.role === "tool" &&
      expanded.has(item.id) &&
      item.result?.status === "success" &&
      (item.call?.name === "write" || item.call?.name === "edit");
    if (!baseItems.some(diffable)) return baseItems;
    const items: ConversationItem[] = [];
    for (const item of baseItems) {
      items.push(item);
      if (!diffable(item)) continue;
      let diff = this.diffItemCache.get(item);
      if (!diff) {
        diff = {
          runId: item.runId,
          turn: item.turn,
          id: `diff-${item.id.slice(5)}`,
          role: "diff",
          text: "Diff",
          call: item.call,
          result: item.result,
          failed: item.failed,
        };
        this.diffItemCache.set(item, diff);
      }
      items.push(diff);
    }
    return items;
  }
  private coreSignature(): string {
    const { status, lastRun, streamingAttempts } = this.state.core;
    return JSON.stringify([
      status,
      lastRun,
      streamingAttempts.map((attempt) => [
        attempt.turn,
        attempt.attempt,
        attempt.status,
        attempt.text,
        attempt.thinking,
      ]),
    ]);
  }
  items(): ConversationItem[] {
    const { history, expanded, expandedResults } = this.state;
    const signature = this.coreSignature();
    if (
      this.itemsCache &&
      this.itemsCache.history === history &&
      this.itemsCache.signature === signature &&
      this.itemsCache.expanded === expanded &&
      this.itemsCache.expandedResults === expandedResults &&
      this.itemsCache.executionVersion === this.executionVersion &&
      this.itemsCache.compactionVersion === this.compactionVersion
    )
      return this.itemsCache.items;
    const records = history?.records ?? [];
    const items = [...this.persistedItems()];
    const runId =
      this.state.core.status.kind === "running"
        ? this.state.core.status.runId
        : this.state.core.lastRun?.runId;
    const committed = records.filter((r) => r.type === "assistant_message" && r.runId === runId).length;
    const idle = this.state.core.status.kind === "idle";
    const outcome = this.state.core.lastRun?.outcome;
    const attempts: ConversationItem[] = [];
    for (const attempt of this.state.core.streamingAttempts) {
      const persisted = attempt.turn <= committed;
      if (attempt.status === "completed" && persisted) continue;
      // cancelled attempt 落盘为 aborted Turn 后由持久化项展示；收尾窗口期内有正文的仍 transient 显示，
      // 半截推理不显示（与上下文同构）。
      if (attempt.status === "cancelled" && (persisted || !attempt.text)) continue;
      attempts.push({
        id: `attempt-${runId}-${attempt.turn}-${attempt.attempt}`,
        runId,
        turn: attempt.turn,
        role: "attempt",
        text: attempt.text,
        thinking: attempt.status === "cancelled" ? "" : attempt.thinking,
        failed:
          attempt.status === "failed" ||
          (idle && outcome !== "completed" && outcome !== "cancelled" && attempt.status !== "cancelled"),
        cancelled: attempt.status === "cancelled",
        dim: attempt.status === "streaming",
      });
    }
    const durationIndex = items.findIndex((item) => item.id === `duration-${runId}`);
    for (const attempt of attempts) {
      const nextTurn = items.findIndex(
        (item) =>
          item.runId === attempt.runId &&
          item.turn !== undefined &&
          item.turn >= attempt.turn! &&
          item.role !== "attempt",
      );
      const duration = items.findIndex((item) => item.id === `duration-${runId}`);
      items.splice(nextTurn >= 0 ? nextTurn : duration >= 0 ? duration : items.length, 0, attempt);
    }
    const last = this.state.core.lastRun;
    if (this.state.core.status.kind === "idle" && last && durationIndex < 0)
      items.push({
        id: `duration-${last.runId}`,
        role: "duration",
        text: `Worked for ${formatDuration(last.elapsedMs)}`,
        dim: true,
      });
    this.itemsCache = {
      history,
      signature,
      expanded,
      expandedResults,
      executionVersion: this.executionVersion,
      compactionVersion: this.compactionVersion,
      items,
    };
    return items;
  }
  dispose(): Promise<void> {
    if (this.exitRequest) return this.exitRequest;
    this.clearInterrupt();
    this.update({ closing: true });
    this.closing = true;
    this.exitRequest = this.controller.exit().finally(() => {
      this.disposed = true;
      this.unsubscribe();
      if (this.scheduled) clearImmediate(this.scheduled);
      this.scheduled = null;
      this.listeners.clear();
    });
    return this.exitRequest;
  }
}
