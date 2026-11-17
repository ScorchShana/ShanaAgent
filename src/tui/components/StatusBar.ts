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

export interface SessionContextMetrics {
  contextTokens: number | null;
  contextWindow: number | null;
  cacheHitRate: number | null;
  speedTokPerSec: number | null;
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

  let contextTokens: number | null;
  let contextWindow: number | null;
  let outputSum = 0;
  let durationMsSum = 0;
  if (measuredRunId === null) {
    contextWindow = finiteToken(fallback?.contextWindow);
    if (contextWindow === null)
      return { contextTokens: null, contextWindow: null, cacheHitRate: null, speedTokPerSec: null };
    contextTokens = finiteToken(fallback?.contextTokens);
  } else {
    let latestSeq = -1;
    contextTokens = null;
    for (const record of assistants) {
      if (record.runId !== measuredRunId) continue;
      const output = finiteToken(usageOf(record)?.output);
      const durationMs = record.message.durationMs;
      // 累加必须先于 latestSeq 跳过：Context 只取最大 seq 那条，Speed 要覆盖本 Run 全部 Turn。
      if (
        output !== null &&
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs > 0
      ) {
        outputSum += output;
        durationMsSum += durationMs;
      }
      if (record.recordSeq < latestSeq) continue;
      latestSeq = record.recordSeq;
      contextTokens = finiteToken(usageOf(record)?.totalTokens);
    }
    const started = records.find(
      (record): record is RunStartedRecord => record.type === "run_started" && record.runId === measuredRunId,
    );
    contextWindow = finiteToken(started?.model?.contextWindow);
  }

  const countedRunIds = new Set(finished.map((record) => record.runId));
  if (activeRunId !== null) countedRunIds.add(activeRunId);

  let inputSum = 0;
  let cacheReadSum = 0;
  let cacheComplete = true;
  for (const record of assistants) {
    if (!countedRunIds.has(record.runId)) continue;
    const usage = usageOf(record);
    const input = finiteToken(usage?.input);
    const cacheRead = finiteToken(usage?.cacheRead);
    if (input === null || cacheRead === null) {
      cacheComplete = false;
      continue;
    }
    inputSum += input;
    cacheReadSum += cacheRead;
  }

  const denominator = inputSum + cacheReadSum;
  return {
    contextTokens,
    contextWindow,
    cacheHitRate: cacheComplete && denominator > 0 ? cacheReadSum / denominator : null,
    speedTokPerSec: durationMsSum > 0 ? outputSum / (durationMsSum / 1000) : null,
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
  const current = formatTokens(metrics.contextTokens, true);
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
      this.refreshKey = `${state.history?.meta.sessionId ?? ""}:${activeRunId ?? "idle"}:${seq}`;
    }
    const contextWindow = (state.core.session.runModel ?? state.core.session.model)?.contextWindow ?? null;
    const contextTokens = state.core.session.contextBaselineTokens;
    const key = JSON.stringify([this.refreshKey, contextWindow, contextTokens]);
    if (key !== this.metricsKey) {
      this.metricsKey = key;
      this.metrics = sessionContextMetrics(
        state.history?.records ?? [],
        contextWindow === null ? undefined : { contextWindow, contextTokens },
        activeRunId,
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
