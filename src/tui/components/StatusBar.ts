import path from "node:path";
import { theme } from "../theme.js";
import { sanitizeDisplayText, type TuiState } from "../store.js";
import type { Component } from "../framework/index.js";
import { truncateToWidth, visibleWidth, sliceByColumn } from "../framework/index.js";
import type {
  AssistantMessageRecord,
  RunFinishedRecord,
  RunStartedRecord,
  SessionRecord,
} from "../../sessions/records.js";
import { findLatestCheckpoint } from "../../sessions/recovery.js";

export interface SessionContextMetrics {
  contextTokens: number | null;
  contextWindow: number | null;
  cacheHitRate: number | null;
  speedTokPerSec: number | null;
  /** contextTokens 为压后估算而非 Provider 实测（显示加 ~ 前缀）。 */
  contextEstimated: boolean;
}

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(
  record: AssistantMessageRecord,
): { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown } | undefined {
  return record.message?.usage as
    { input?: unknown; output?: unknown; cacheRead?: unknown; totalTokens?: unknown } | undefined;
}

export interface ContextMetricsFallback {
  contextTokens: number | null;
  contextWindow: number | null;
}

export function sessionContextMetrics(
  records: readonly SessionRecord[],
  fallback?: ContextMetricsFallback,
  activeRunId: string | null = null,
  contextEstimate: number | null = null,
): SessionContextMetrics {
  const finished = records.filter((record): record is RunFinishedRecord => record.type === "run_finished");
  const assistants = records.filter(
    (record): record is AssistantMessageRecord => record.type === "assistant_message",
  );
  const lastFinished =
    finished.length === 0
      ? null
      : finished.reduce((latest, record) => (record.recordSeq >= latest.recordSeq ? record : latest));
  const activeHasAssistant =
    activeRunId !== null && assistants.some((record) => record.runId === activeRunId);
  const measuredRunId: string | null = activeHasAssistant ? activeRunId : (lastFinished?.runId ?? null);

  // 最新 checkpoint 的 coveredUpTo 只服务于 Context：被覆盖的实测是压缩前旧值，改用压后估算。
  // checkpoint 损坏时无法判定覆盖范围，保持实测显示，状态栏不因坏记录崩溃。
  let coveredUpTo: number | null = null;
  try {
    coveredUpTo = findLatestCheckpoint(records)?.coveredUpTo ?? null;
  } catch {
    coveredUpTo = null;
  }

  let contextTokens: number | null;
  let contextWindow: number | null;
  let latestSeq = -1;
  if (measuredRunId === null) {
    contextWindow = finiteToken(fallback?.contextWindow);
    if (contextWindow === null)
      return {
        contextTokens: null,
        contextWindow: null,
        cacheHitRate: null,
        speedTokPerSec: null,
        contextEstimated: false,
      };
    contextTokens = finiteToken(fallback?.contextTokens);
  } else {
    contextTokens = null;
    for (const record of assistants) {
      if (record.runId !== measuredRunId) continue;
      if (record.recordSeq < latestSeq) continue;
      latestSeq = record.recordSeq;
      contextTokens = finiteToken(usageOf(record)?.totalTokens);
    }
    const started = records.find(
      (record): record is RunStartedRecord => record.type === "run_started" && record.runId === measuredRunId,
    );
    contextWindow = finiteToken(started?.model?.contextWindow);
  }

  // 最新 checkpoint 覆盖了被测量的 assistant（或该 Run 尚无 assistant）：实测是压缩前旧值，
  // 改用压后估算，与模型实际所见同构；新实测落盘后 recordSeq 超出覆盖范围，自动切回。
  // checkpoint 损坏时 coveredUpTo 为 null，保持实测显示。
  let contextEstimated = false;
  if (contextEstimate !== null && measuredRunId !== null) {
    if (coveredUpTo !== null && (latestSeq < 0 || coveredUpTo >= latestSeq)) {
      contextTokens = contextEstimate;
      contextEstimated = true;
    }
  }

  const countedRunIds = new Set(finished.map((record) => record.runId));
  if (activeRunId !== null) countedRunIds.add(activeRunId);

  // Cache/Speed 是整段对话的累计口径：跨 Run、跨压缩都持续累加，压缩不重置。
  // 摘要请求本身也是真实请求，其用量随 checkpoint 落盘并计入同一累计（重启 / /resume 后仍完整）。
  let inputSum = 0;
  let cacheReadSum = 0;
  let cacheComplete = true;
  let outputSum = 0;
  let durationMsSum = 0;
  for (const record of assistants) {
    if (!countedRunIds.has(record.runId)) continue;
    const usage = usageOf(record);
    const input = finiteToken(usage?.input);
    const cacheRead = finiteToken(usage?.cacheRead);
    if (input === null || cacheRead === null) {
      cacheComplete = false;
    } else {
      inputSum += input;
      cacheReadSum += cacheRead;
    }
    const output = finiteToken(usage?.output);
    const durationMs = record.message.durationMs;
    if (output !== null && typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
      outputSum += output;
      durationMsSum += durationMs;
    }
  }
  for (const record of records) {
    if (record.type !== "checkpoint") continue;
    // 旧 checkpoint 无 usage（记录层可选）。字段非法时整条忽略（不补零、不部分采信），状态栏不崩。
    const usage = record.usage;
    const input = finiteToken(usage?.input);
    const cacheRead = finiteToken(usage?.cacheRead);
    const output = finiteToken(usage?.output);
    if (input === null || cacheRead === null || output === null) continue;
    const durationMs = usage?.durationMs;
    const durationValid =
      durationMs === undefined ||
      (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0);
    if (!durationValid) continue;
    inputSum += input;
    cacheReadSum += cacheRead;
    // 摘要请求耗时缺省（Provider 未报告）或为 0 时只计 token、不计速度。
    if (durationMs !== undefined && durationMs > 0) {
      outputSum += output;
      durationMsSum += durationMs;
    }
  }

  const denominator = inputSum + cacheReadSum;
  return {
    contextTokens,
    contextWindow,
    cacheHitRate: cacheComplete && denominator > 0 ? cacheReadSum / denominator : null,
    speedTokPerSec: durationMsSum > 0 ? outputSum / (durationMsSum / 1000) : null,
    contextEstimated,
  };
}

function formatTokens(value: number | null, forceDecimal: boolean): string {
  if (value === null) return "0";
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  if (forceDecimal || !Number.isInteger(thousands)) return `${thousands.toFixed(1)}k`;
  return `${thousands}k`;
}

export function contextSegment(metrics: SessionContextMetrics): string {
  const current = `${metrics.contextEstimated ? "~" : ""}${formatTokens(metrics.contextTokens, true)}`;
  const window = formatTokens(metrics.contextWindow, false);
  return `Context: ${current} / ${window}`;
}

export const FOOTER_ROWS = 2;
export function formatWorkspacePath(workspace: string, home: string, width: number, redact: (text: string) => string = (text) => text): string {
  const paths = /^[A-Za-z]:[\\/]|^\\\\/.test(workspace) ? path.win32 : path.posix;
  let value = paths.normalize(workspace);
  const relative = paths.relative(home, value);
  if (home && (relative === "" || (relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative))))
    value = relative ? `~${paths.sep}${relative}` : "~";
  value = sanitizeDisplayText(redact(sanitizeDisplayText(value))).replaceAll("\n", " ");
  if (visibleWidth(value) <= width) return value;
  const root = value.startsWith("~") ? "~" + paths.sep : paths.parse(value).root;
  const parts = value.slice(root.length).split(paths.sep);
  for (let i = 1; i < parts.length; i++) {
    const candidate = root + "…" + paths.sep + parts.slice(i).join(paths.sep);
    if (visibleWidth(candidate) <= width) return candidate;
  }
  const last = parts.at(-1) ?? value;
  const prefix = root + "…" + paths.sep;
  const budget = Math.max(0, width - visibleWidth(prefix));
  return budget > 0
    ? prefix + sliceByColumn(last, Math.max(0, visibleWidth(last) - budget), budget, true)
    : truncateToWidth(prefix, width, "…");
}

export class StatusBar implements Component {
  private state: TuiState;
  private history: TuiState["history"] | undefined;
  private activeRunId: string | null = null;
  private metricsKey = "";
  private refreshKey = "";
  private metrics: SessionContextMetrics = {
    contextTokens: null,
    contextWindow: null,
    cacheHitRate: null,
    speedTokPerSec: null,
    contextEstimated: false,
  };
  constructor(state: TuiState, private readonly display: { workspacePath: string; homeDirectory: string; redact?: (text: string) => string } = { workspacePath: "", homeDirectory: "" }) {
    this.state = state;
    this.update(state);
  }
  update(state: TuiState): void {
    this.state = state;
    const activeRunId = state.core.status.kind === "running" ? state.core.status.runId : null;
    if (this.history !== state.history || this.activeRunId !== activeRunId) {
      this.history = state.history;
      this.activeRunId = activeRunId;
      const seq =
        state.history?.records.reduce(
          (latest, record) =>
            (activeRunId
              ? record.type === "assistant_message" && record.runId === activeRunId
              : record.type === "run_finished") && record.recordSeq > latest
              ? record.recordSeq
              : latest,
          -1,
        ) ?? -1;
      // checkpoint 追加会改变 Cache/Speed 口径，但既有 seq（assistant/run_finished）可能不变，
      // 必须把 checkpoint 维度计入键，否则压缩后不会重算。
      const checkpointSeq =
        state.history?.records.reduce(
          (latest, record) =>
            record.type === "checkpoint" && record.recordSeq > latest ? record.recordSeq : latest,
          -1,
        ) ?? -1;
      this.refreshKey = `${state.history?.meta.sessionId ?? ""}:${activeRunId ?? "idle"}:${seq}:${checkpointSeq}`;
    }
    const contextWindow = (state.core.session.runModel ?? state.core.session.model)?.contextWindow ?? null;
    const contextTokens = state.core.session.contextBaselineTokens;
    const contextEstimate = state.core.session.contextEstimateTokens;
    const key = JSON.stringify([this.refreshKey, contextWindow, contextTokens, contextEstimate]);
    if (key !== this.metricsKey) {
      this.metricsKey = key;
      this.metrics = sessionContextMetrics(
        state.history?.records ?? [],
        contextWindow === null ? undefined : { contextWindow, contextTokens },
        activeRunId,
        contextEstimate,
      );
    }
  }
  invalidate(): void {}
  render(width: number): string[] {
    const state = this.state;
    const decision = state.core.session.autoDecision;
    const reason = !decision.enabled ? "" : decision.availability === "invalid" ? "config error"
      : decision.availability === "missing" ? "not configured"
      : decision.availability === "unavailable" ? "unavailable" : "";
    const automatic = decision.enabled && !reason;
    const label = theme.muted("Decision: ") + (automatic ? theme.cyan("auto") : theme.muted("manual"))
      + (reason ? (reason === "config error" ? theme.error : theme.warning)(` (${reason})`) : "");
    const metrics = this.metrics;
    const prefix = `${state.core.status.kind !== "idle" ? theme.muted("Draft · ") : ""}${label}`;
    const base = `${prefix}${theme.muted(` · ${contextSegment(metrics)}`)}`;
    const tail = theme.muted(` · Cache: ${metrics.cacheHitRate === null ? "0.0" : (metrics.cacheHitRate * 100).toFixed(1)}%`);
    const withSpeed = `${base}${theme.muted(` · ${metrics.speedTokPerSec === null ? "Speed: —" : `Speed: ${Math.round(metrics.speedTokPerSec)} tok/s`}`)}`;
    const line = visibleWidth(withSpeed + tail) <= width ? withSpeed + tail
      : visibleWidth(base + tail) <= width ? base + tail : base;
    return [theme.muted(formatWorkspacePath(this.display.workspacePath, this.display.homeDirectory, width, this.display.redact)), truncateToWidth(line, width)];
  }
}
