import fs from "node:fs";
import path from "node:path";
import type { LogLevel } from "./llm/settings-store.js";

export const DIAGNOSTIC_LEVELS = ["debug", "info", "warn", "error"] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

const LEVEL_ORDER: Record<DiagnosticLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Diagnostics {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DiagnosticsOptions {
  logsDir: string;
  minLevel: LogLevel;
  redact: (text: string) => string;
  now?: () => Date;
}

function fileNameFor(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `shana-${yyyy}-${mm}-${dd}.log`;
}

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const { logsDir, minLevel, redact } = options;
  const minOrder = LEVEL_ORDER[minLevel];

  function write(level: DiagnosticLevel, message: string): void {
    if (LEVEL_ORDER[level] < minOrder) return;
    const date = (options.now ?? (() => new Date()))();
    const line = `${date.toISOString()} ${level.toUpperCase()} ${redact(String(message)).replace(/\r?\n/g, " \\n ")}\n`;
    try {
      fs.appendFileSync(path.join(logsDir, fileNameFor(date)), line, { mode: 0o600 });
    } catch {
      // 诊断日志失败不得影响主流程
    }
  }

  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
