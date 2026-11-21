import fs from "node:fs";

export const SETTINGS_FILE_NAME = "settings.json";
export const DEFAULT_CTRL_C_EXIT_WINDOW_MS = 3000;
export const DEFAULT_RUN_TIMER_REFRESH_MS = 1000;
export const DEFAULT_STREAM_REFRESH_MS = 32;
export const DEFAULT_MAX_RETRIES = 10;
export const DEFAULT_MAX_TURNS = 200;
export const DEFAULT_DIFF_FOLD_LINES = 200;
export const DEFAULT_DIFF_FOLD_CHARS = 10_000;
export const DEFAULT_THINKING_PREVIEW_LINES = 5;
export const DEFAULT_TOOL_RESULT_PREVIEW_LINES = 5;
export const DEFAULT_PROMPT_VISIBLE_ROWS = 3;
export const DEFAULT_PROMPT_MAX_ROWS = 5;
export const DEFAULT_MOUSE_SCROLL_LINES = 3;
export const DEFAULT_ESCAPE_TIMEOUT_MS = 30;
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_EDIT_MAX_FILE_BYTES = 16_777_216;
export const DEFAULT_VIEW_IMAGE_MAX_BYTES = 5_242_880;
export const DEFAULT_GLOB_TIMEOUT_MS = 30_000;
export const DEFAULT_GREP_STDERR_MAX_CHARS = 4_000;
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;
export const DEFAULT_COMPACTION_SUMMARY_TARGET_TOKENS = 4096;
export const DEFAULT_COMPACTION_RETAINED_CONTEXT_RATIO = 0.2;
export const DEFAULT_COMPACTION_RETAINED_CONTEXT_MAX_TOKENS = 20_000;
export const COMPACTION_RETAINED_CONTEXT_MIN_TOKENS = 1000;
export const DEFAULT_COMPACTION_TOOL_RESULT_MAX_CHARS = 4000;
export const DEFAULT_COMPACTION_MAX_RETRIES = 2;
export const DEFAULT_TOKEN_ESTIMATE = { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5 } as const;
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export interface TokenEstimateSettings {
  asciiCharsPerToken: number;
  nonAsciiCharsPerToken: number;
}

export interface Settings {
  ctrlCExitWindowMs: number;
  promptVisibleRows: number;
  promptMaxRows: number;
  runTimerRefreshMs: number;
  streamRefreshMs: number;
  maxRetries: number;
  maxTurns: number;
  diffFoldLines: number;
  diffFoldChars: number;
  thinkingPreviewLines: number;
  toolResultPreviewLines: number;
  mouseScrollLines: number;
  escapeTimeoutMs: number;
  logLevel: LogLevel;
  editMaxFileBytes: number;
  viewImageMaxBytes: number;
  globTimeoutMs: number;
  grepStderrMaxChars: number;
  compactionThresholdRatio: number;
  compactionSummaryTargetTokens: number;
  compactionRetainedContextRatio: number;
  compactionRetainedContextMaxTokens: number;
  compactionToolResultMaxChars: number;
  compactionMaxRetries: number;
  tokenEstimate: TokenEstimateSettings;
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSettings(raw: unknown): Settings {
  if (raw === undefined) return parseSettings({});
  if (!isPlainObject(raw)) {
    throw new SettingsError("settings.json: 顶层必须是对象");
  }
  for (const key of Object.keys(raw)) {
    if (
      key !== "ctrlCExitWindowMs" &&
      key !== "runTimerRefreshMs" &&
      key !== "streamRefreshMs" &&
      key !== "maxRetries" &&
      key !== "maxTurns" &&
      key !== "diffFoldLines" &&
      key !== "diffFoldChars" &&
      key !== "thinkingPreviewLines" &&
      key !== "toolResultPreviewLines" &&
      key !== "promptVisibleRows" &&
      key !== "promptMaxRows" &&
      key !== "mouseScrollLines" &&
      key !== "escapeTimeoutMs" &&
      key !== "logLevel" &&
      key !== "editMaxFileBytes" &&
      key !== "viewImageMaxBytes" &&
      key !== "globTimeoutMs" &&
      key !== "grepStderrMaxChars" &&
      key !== "compactionThresholdRatio" &&
      key !== "compactionSummaryTargetTokens" &&
      key !== "compactionRetainedContextRatio" &&
      key !== "compactionRetainedContextMaxTokens" &&
      key !== "compactionToolResultMaxChars" &&
      key !== "compactionMaxRetries" &&
      key !== "tokenEstimate"
    ) {
      throw new SettingsError(`settings.json: 未知字段 "${key}"`);
    }
  }
  for (const field of [
    "diffFoldLines",
    "diffFoldChars",
    "thinkingPreviewLines",
    "toolResultPreviewLines",
    "promptVisibleRows",
    "promptMaxRows",
    "compactionSummaryTargetTokens",
    "compactionToolResultMaxChars",
  ] as const) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      throw new SettingsError(`settings.json: "${field}" 必须是正整数`);
    }
  }
  const promptVisibleRows = (raw.promptVisibleRows as number | undefined) ?? DEFAULT_PROMPT_VISIBLE_ROWS;
  const promptMaxRows = (raw.promptMaxRows as number | undefined) ?? DEFAULT_PROMPT_MAX_ROWS;
  if (promptMaxRows < promptVisibleRows) {
    throw new SettingsError('settings.json: "promptMaxRows" 必须不小于 "promptVisibleRows"');
  }
  const { maxRetries, logLevel, maxTurns, compactionMaxRetries, compactionThresholdRatio } = raw;
  if (
    maxTurns !== undefined &&
    (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)
  ) {
    throw new SettingsError('settings.json: "maxTurns" 必须是正整数');
  }
  if (maxRetries !== undefined) {
    if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new SettingsError('settings.json: "maxRetries" 必须是非负整数');
    }
  }
  if (
    compactionMaxRetries !== undefined &&
    (typeof compactionMaxRetries !== "number" ||
      !Number.isInteger(compactionMaxRetries) ||
      compactionMaxRetries < 0)
  ) {
    throw new SettingsError('settings.json: "compactionMaxRetries" 必须是非负整数');
  }
  if (
    compactionThresholdRatio !== undefined &&
    (typeof compactionThresholdRatio !== "number" ||
      !Number.isFinite(compactionThresholdRatio) ||
      compactionThresholdRatio <= 0 ||
      compactionThresholdRatio > 1)
  ) {
    throw new SettingsError('settings.json: "compactionThresholdRatio" 必须是 0 < x <= 1 的有限数字');
  }
  if (
    raw.compactionRetainedContextRatio !== undefined &&
    (typeof raw.compactionRetainedContextRatio !== "number" ||
      !Number.isFinite(raw.compactionRetainedContextRatio) ||
      raw.compactionRetainedContextRatio <= 0 ||
      raw.compactionRetainedContextRatio > 1)
  ) {
    throw new SettingsError('settings.json: "compactionRetainedContextRatio" 必须是 0 < x <= 1 的有限数字');
  }
  if (
    raw.compactionRetainedContextMaxTokens !== undefined &&
    (typeof raw.compactionRetainedContextMaxTokens !== "number" ||
      !Number.isInteger(raw.compactionRetainedContextMaxTokens) ||
      raw.compactionRetainedContextMaxTokens < COMPACTION_RETAINED_CONTEXT_MIN_TOKENS)
  ) {
    throw new SettingsError(
      `settings.json: "compactionRetainedContextMaxTokens" 必须是 >= ${COMPACTION_RETAINED_CONTEXT_MIN_TOKENS} 的整数`,
    );
  }
  if (logLevel !== undefined) {
    if (typeof logLevel !== "string" || !(LOG_LEVELS as readonly string[]).includes(logLevel)) {
      throw new SettingsError(`settings.json: "logLevel" 必须是 ${LOG_LEVELS.join(" | ")} 之一`);
    }
  }
  for (const [key, minimum, maximum] of [
    ["ctrlCExitWindowMs", 1, 2_147_483_647],
    ["editMaxFileBytes", 1, 16_777_216],
    ["viewImageMaxBytes", 1024, 16_777_216],
    ["globTimeoutMs", 1000, 120_000],
    ["grepStderrMaxChars", 64, 65_536],
    ["mouseScrollLines", 1, 100],
    ["escapeTimeoutMs", 1, 100],
    ["runTimerRefreshMs", 250, 1000],
    ["streamRefreshMs", 16, 200],
  ] as const) {
    const value = raw[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    ) {
      throw new SettingsError(`settings.json: "${key}" 必须是 ${minimum}–${maximum} 的整数`);
    }
  }
  let tokenEstimate: TokenEstimateSettings = { ...DEFAULT_TOKEN_ESTIMATE };
  if (raw.tokenEstimate !== undefined) {
    const value = raw.tokenEstimate;
    if (!isPlainObject(value)) {
      throw new SettingsError('settings.json: "tokenEstimate" 必须是对象');
    }
    for (const key of Object.keys(value)) {
      if (key !== "asciiCharsPerToken" && key !== "nonAsciiCharsPerToken") {
        throw new SettingsError(`settings.json: "tokenEstimate" 未知字段 "${key}"`);
      }
    }
    for (const field of ["asciiCharsPerToken", "nonAsciiCharsPerToken"] as const) {
      const item = value[field];
      if (item === undefined) {
        throw new SettingsError(`settings.json: "tokenEstimate.${field}" 缺失`);
      }
      if (typeof item !== "number" || !Number.isFinite(item) || item <= 0) {
        throw new SettingsError(`settings.json: "tokenEstimate.${field}" 必须是有限正数`);
      }
    }
    tokenEstimate = {
      asciiCharsPerToken: value.asciiCharsPerToken as number,
      nonAsciiCharsPerToken: value.nonAsciiCharsPerToken as number,
    };
  }
  return {
    ctrlCExitWindowMs: (raw.ctrlCExitWindowMs as number | undefined) ?? DEFAULT_CTRL_C_EXIT_WINDOW_MS,
    promptVisibleRows,
    promptMaxRows,
    runTimerRefreshMs: (raw.runTimerRefreshMs as number | undefined) ?? DEFAULT_RUN_TIMER_REFRESH_MS,
    streamRefreshMs: (raw.streamRefreshMs as number | undefined) ?? DEFAULT_STREAM_REFRESH_MS,
    maxRetries: maxRetries ?? DEFAULT_MAX_RETRIES,
    maxTurns: (maxTurns as number | undefined) ?? DEFAULT_MAX_TURNS,
    diffFoldLines: (raw.diffFoldLines as number | undefined) ?? DEFAULT_DIFF_FOLD_LINES,
    diffFoldChars: (raw.diffFoldChars as number | undefined) ?? DEFAULT_DIFF_FOLD_CHARS,
    thinkingPreviewLines: (raw.thinkingPreviewLines as number | undefined) ?? DEFAULT_THINKING_PREVIEW_LINES,
    toolResultPreviewLines:
      (raw.toolResultPreviewLines as number | undefined) ?? DEFAULT_TOOL_RESULT_PREVIEW_LINES,
    mouseScrollLines: (raw.mouseScrollLines as number | undefined) ?? DEFAULT_MOUSE_SCROLL_LINES,
    escapeTimeoutMs: (raw.escapeTimeoutMs as number | undefined) ?? DEFAULT_ESCAPE_TIMEOUT_MS,
    logLevel: (logLevel as LogLevel | undefined) ?? DEFAULT_LOG_LEVEL,
    editMaxFileBytes: (raw.editMaxFileBytes as number | undefined) ?? DEFAULT_EDIT_MAX_FILE_BYTES,
    viewImageMaxBytes: (raw.viewImageMaxBytes as number | undefined) ?? DEFAULT_VIEW_IMAGE_MAX_BYTES,
    globTimeoutMs: (raw.globTimeoutMs as number | undefined) ?? DEFAULT_GLOB_TIMEOUT_MS,
    grepStderrMaxChars: (raw.grepStderrMaxChars as number | undefined) ?? DEFAULT_GREP_STDERR_MAX_CHARS,
    compactionThresholdRatio:
      (compactionThresholdRatio as number | undefined) ?? DEFAULT_COMPACTION_THRESHOLD_RATIO,
    compactionSummaryTargetTokens:
      (raw.compactionSummaryTargetTokens as number | undefined) ?? DEFAULT_COMPACTION_SUMMARY_TARGET_TOKENS,
    compactionRetainedContextRatio:
      (raw.compactionRetainedContextRatio as number | undefined) ?? DEFAULT_COMPACTION_RETAINED_CONTEXT_RATIO,
    compactionRetainedContextMaxTokens:
      (raw.compactionRetainedContextMaxTokens as number | undefined) ??
      DEFAULT_COMPACTION_RETAINED_CONTEXT_MAX_TOKENS,
    compactionToolResultMaxChars:
      (raw.compactionToolResultMaxChars as number | undefined) ?? DEFAULT_COMPACTION_TOOL_RESULT_MAX_CHARS,
    compactionMaxRetries: (compactionMaxRetries as number | undefined) ?? DEFAULT_COMPACTION_MAX_RETRIES,
    tokenEstimate,
  };
}

export function loadSettings(settingsPath: string): Settings {
  if (!fs.existsSync(settingsPath)) {
    return parseSettings(undefined);
  }
  let rawText: string;
  try {
    rawText = fs.readFileSync(settingsPath, "utf8");
  } catch (error) {
    throw new SettingsError(`settings.json: 读取失败 (${(error as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new SettingsError("settings.json: JSON 解析失败，文件已损坏；请手动修复，程序不会覆盖它");
  }
  return parseSettings(parsed);
}

export function collectSettingsWarnings(settings: Settings): string[] {
  const warnings: string[] = [];
  if (settings.compactionRetainedContextRatio >= settings.compactionThresholdRatio) {
    warnings.push(
      `settings.json: "compactionRetainedContextRatio" (${settings.compactionRetainedContextRatio}) >= "compactionThresholdRatio" (${settings.compactionThresholdRatio})，尾部保留 cap 松于压缩阈值、几乎不生效`,
    );
  }
  return warnings;
}
