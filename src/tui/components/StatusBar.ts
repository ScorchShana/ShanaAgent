import path from "node:path";
import { theme } from "../theme.js";
import { sanitizeDisplayText, type TuiState } from "../store.js";
import type { Component } from "../framework/index.js";
import { truncateToWidth, visibleWidth, sliceByColumn } from "../framework/index.js";
import type {
  AssistantMessageRecord,
  RunFinishedRecord,
  SessionRecord,
} from "../../sessions/records.js";

export interface SessionContextMetrics {
  contextTokens: number | null;
  contextWindow: number | null;
  cacheHitRate: number | null;
  speedTokPerSec: number | null;
  /** contextTokens 为纯估算（无可信实测锚点），显示加 ~ 前缀。 */
  contextEstimated: boolean;
}

export interface SessionUsageMetrics {
  cacheHitRate: number | null;
  speedTokPerSec: number | null;
}

function finiteToken(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function usageOf(
  record: AssistantMessageRecord,
): { input?: unknown; output?: unknown; cacheRead?: unknown } | undefined {
  return record.message?.usage as
    { input?: unknown; output?: unknown; cacheRead?: unknown } | undefined;
}

// Context 数值由 Core 单一权威值经快照直供（实测锚定优先、无实测全量估算），此处只累计
// Cache/Speed：整段对话口径，跨 Run、跨压缩持续累加，压缩不重置。摘要请求本身也是真实
// 请求，其用量随 checkpoint 落盘并计入同一累计（重启 / /resume 后仍完整）。
export function sessionContextMetrics(
  records: readonly SessionRecord[],
  activeRunId: string | null = null,
): SessionUsageMetrics {
  const finished = records.filter((record): record is RunFinishedRecord => record.type === "run_finished");
  const assistants = records.filter(
    (record): record is AssistantMessageRecord => record.type === "assistant_message",
  );
  const countedRunIds = new Set(finished.map((record) => record.runId));
  if (activeRunId !== null) countedRunIds.add(activeRunId);

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
    cacheHitRate: cacheComplete && denominator > 0 ? cacheReadSum / denominator : null,
    speedTokPerSec: durationMsSum > 0 ? outputSum / (durationMsSum / 1000) : null,
  };
}

function formatTokens(value: number | null, forceDecimal: boolean): string {
  // 未知不能伪装成零。
  if (value === null) return "—";
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
    const { contextTokens, contextEstimated } = state.core.session;
    const key = JSON.stringify([this.refreshKey, contextWindow, contextTokens, contextEstimated]);
    if (key !== this.metricsKey) {
      this.metricsKey = key;
      this.metrics = {
        contextTokens,
        contextWindow,
        contextEstimated,
        ...sessionContextMetrics(state.history?.records ?? [], activeRunId),
      };
    }
  }
  invalidate(): void {}
  render(width: number): string[] {
    const state = this.state;
    const mode = state.core.session.approvalMode;
    // full 是全豁免（含区外写入），用 warning 色做视觉提醒。
    const label = theme.muted("Mode: ") + (mode === "confirm" ? theme.muted("confirm")
      : mode === "auto" ? theme.cyan("auto") : theme.warning("full"));
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
