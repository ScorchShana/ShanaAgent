import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rgPath as defaultRipgrepPath } from "@vscode/ripgrep";
import { DEFAULT_GREP_STDERR_MAX_CHARS } from "../llm/settings-store.js";
import type { ResolvedToolPath } from "../security/path-policy.js";
import { reportToolDiagnostic, type ToolContext, type ToolOutcome } from "./registry.js";

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_MATCHES = 500;
export const GREP_MAX_LINE_CHARS = 500;
export const GREP_MAX_OUTPUT_CHARS = 24_000;

export interface GrepArguments {
  pattern: string;
  path?: string;
  glob?: string;
  limit?: number;
}

function escapedTokens(text: string): string[] {
  return Array.from(text, (character) => {
    const point = character.codePointAt(0)!;
    if (character === "\\") return "\\\\";
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (
      point < 32 ||
      (point >= 127 && point <= 159) ||
      point === 0x2028 ||
      point === 0x2029 ||
      (point >= 0xd800 && point <= 0xdfff)
    )
      return `\\u${point.toString(16).padStart(4, "0")}`;
    return character;
  });
}

function takeTokens(tokens: string[], budget: number, tail = false): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const token of tail ? [...tokens].reverse() : tokens) {
    const size = Array.from(token).length;
    if (used + size > budget) break;
    kept.push(token);
    used += size;
  }
  return tail ? kept.reverse() : kept;
}

function error(reason: string, category: ToolOutcome["category"] = "io"): ToolOutcome {
  return { status: "error", category, content: `Error: ${reason}` };
}

function decodeField(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("invalid field");
  const field = value as Record<string, unknown>;
  if (typeof field.text === "string") {
    if (/[\ud800-\udfff]/u.test(field.text)) throw new Error("invalid Unicode");
    return field.text;
  }
  if (
    typeof field.bytes !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(field.bytes)
  )
    throw new Error("invalid bytes");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.from(field.bytes, "base64"),
  );
}

function renderBody(text: string, firstByte: number): string {
  const body = text.replace(/\r?\n$/, "");
  if (body.includes("\0")) throw new Error("binary content");
  const tokens = escapedTokens(body);
  if (Array.from(tokens.join("")).length <= GREP_MAX_LINE_CHARS) return tokens.join("");
  const prefix = Buffer.from(text).subarray(0, firstByte);
  const before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prefix);
  const matchIndex = Array.from(before).length;
  const marker = "…[truncated]";
  const tokenSize = (values: string[]): number => Array.from(values.join("")).length;
  const left = takeTokens(
    tokens.slice(0, matchIndex),
    Math.floor((GREP_MAX_LINE_CHARS - 2 * marker.length) / 2),
    true,
  );
  let start = matchIndex - left.length;
  let kept = takeTokens(
    tokens.slice(start),
    GREP_MAX_LINE_CHARS - (start > 0 ? marker.length : 0) - marker.length,
  );
  let end = start + kept.length;
  if (end === tokens.length) {
    kept = takeTokens(tokens, GREP_MAX_LINE_CHARS - marker.length, true);
    start = tokens.length - kept.length;
    end = tokens.length;
  } else if (start === 0 && tokenSize(kept) < GREP_MAX_LINE_CHARS - marker.length) {
    kept = takeTokens(tokens, GREP_MAX_LINE_CHARS - marker.length);
    end = kept.length;
  }
  return `${start > 0 ? marker : ""}${kept.join("")}${end < tokens.length ? marker : ""}`;
}

export async function searchFiles(
  args: GrepArguments,
  target: ResolvedToolPath,
  context: ToolContext,
): Promise<ToolOutcome> {
  if (context.signal?.aborted) return error("Cancelled by user.", "cancelled");
  if (target.danglingSymlink) return error("Broken symbolic link.");
  if (!target.exists) return error("Path not found.");
  await context.assertPathTarget?.();
  try {
    const stats = await fs.promises.stat(target.realPath);
    if (!stats.isFile() && !stats.isDirectory()) return error("Not a regular file or directory.");
  } catch (cause) {
    reportToolDiagnostic(context.onDiagnostic, "grep.stat", cause);
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return error("Path not found.");
    if (code === "EACCES" || code === "EPERM") return error("Permission denied.");
    return error("File operation failed.");
  }
  const searchPath = target.insideWorkspace
    ? path.relative(context.workspaceRoot, target.realPath) || "."
    : target.realPath;
  await context.assertPathTarget?.();
  let child;
  try {
    child = spawn(
      context.ripgrepPath ?? defaultRipgrepPath,
      [
        "--json",
        "--no-config",
        ...(args.glob === undefined ? [] : ["--glob", args.glob]),
        "--",
        args.pattern,
        searchPath,
      ],
      { cwd: context.workspaceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (cause) {
    reportToolDiagnostic(context.onDiagnostic, "grep.spawn", cause);
    return error("Search is unavailable.");
  }
  let spawnFailed = false;
  let aborted = false;
  let parseFailed = false;
  let limited: "count" | "char" | undefined;
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (cause) => {
      reportToolDiagnostic(context.onDiagnostic, "grep.process", cause);
      spawnFailed = true;
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const abort = (): void => {
    aborted = true;
    child.kill();
  };
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();

  const stderrBudget = context.grepStderrMaxChars ?? DEFAULT_GREP_STDERR_MAX_CHARS;
  const stderrDecoder = new TextDecoder("utf-8");
  const marker = "…[stderr truncated]…";
  const available = stderrBudget - 2 - marker.length;
  const headBudget = Math.floor((available * 3) / 5);
  const tailBudget = available - headBudget;
  let stderrFull: string[] = [];
  let stderrHead: string[] = [];
  let stderrTail: string[] = [];
  let stderrSize = 0;
  let stderrTruncated = false;
  const consumeStderr = (text: string): void => {
    const tokens = escapedTokens(text).map((part) => (part === '"' ? '\\"' : part));
    if (stderrTruncated) {
      stderrTail = takeTokens([...stderrTail, ...tokens], tailBudget, true);
      return;
    }
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      stderrSize += Array.from(token).length;
      stderrFull.push(token);
      if (stderrSize <= stderrBudget - 2) continue;
      stderrTruncated = true;
      stderrHead = takeTokens(stderrFull, headBudget);
      stderrTail = takeTokens([...stderrFull, ...tokens.slice(index + 1)], tailBudget, true);
      stderrFull = [];
      break;
    }
  };
  child.stderr.on("data", (chunk: Buffer) => consumeStderr(stderrDecoder.decode(chunk, { stream: true })));
  child.stderr.on("end", () => consumeStderr(stderrDecoder.decode()));
  child.stderr.on("error", (cause) => {
    reportToolDiagnostic(context.onDiagnostic, "grep.stderr", cause);
    parseFailed = true;
    child.kill();
  });

  const matches: string[] = [];
  const countNotice = (): string => `[Results truncated: showing first ${matches.length} matches.]`;
  const charNotice = "[Results truncated: 24000 character limit reached.]";
  const size = (text: string): number => Array.from(text).length;
  const fitNotice = (): void => {
    while (
      matches.length > 0 &&
      size([...matches, limited === "char" ? charNotice : countNotice()].join("\n")) > GREP_MAX_OUTPUT_CHARS
    ) {
      matches.pop();
      limited = "char";
    }
  };
  interface PendingFile {
    matches: string[];
    size: number;
    limited?: "count" | "char";
    ended: boolean;
    binary: boolean;
    failed: boolean;
  }
  const pendingFiles = new Map<string, PendingFile>();
  const fileState = (file: string): PendingFile => {
    let state = pendingFiles.get(file);
    if (!state) {
      state = { matches: [], size: 0, ended: false, binary: false, failed: false };
      pendingFiles.set(file, state);
    }
    return state;
  };
  const commit = (rendered: string): void => {
    if (limited) return;
    if (matches.length >= (args.limit ?? GREP_DEFAULT_LIMIT)) limited = "count";
    else if (size([...matches, rendered].join("\n")) > GREP_MAX_OUTPUT_CHARS) limited = "char";
    else {
      matches.push(rendered);
      return;
    }
    fitNotice();
    child.kill();
  };
  const flushFiles = (): void => {
    for (const [file, state] of pendingFiles) {
      if (!state.ended) break;
      pendingFiles.delete(file);
      if (state.binary) continue;
      if (state.failed) {
        parseFailed = true;
        child.kill();
        continue;
      }
      for (const rendered of state.matches) commit(rendered);
      if (!limited && state.limited) {
        limited = state.limited;
        fitNotice();
        child.kill();
      }
    }
  };
  const consumeEvent = (line: string): void => {
    if (!line) return;
    try {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== "object" || !("type" in event) || typeof event.type !== "string")
        throw new Error("invalid event");
      if (!["begin", "match", "end"].includes(event.type)) return;
      const data = (event as unknown as { data: Record<string, unknown> }).data;
      const file = decodeField(data.path);
      const state = fileState(file);
      if (event.type === "begin") return;
      if (event.type === "end") {
        if (
          data.binary_offset !== null &&
          (!Number.isSafeInteger(data.binary_offset) || (data.binary_offset as number) < 0)
        )
          throw new Error("invalid binary offset");
        state.ended = true;
        state.binary = data.binary_offset !== null;
        flushFiles();
        return;
      }
      try {
        const body = decodeField(data.lines);
        const number = data.line_number;
        if (
          !Number.isSafeInteger(number) ||
          (number as number) < 1 ||
          !Array.isArray(data.submatches) ||
          data.submatches.length === 0
        )
          throw new Error("invalid match");
        const start = (data.submatches[0] as { start?: unknown }).start;
        if (
          !Number.isSafeInteger(start) ||
          (start as number) < 0 ||
          (start as number) > Buffer.byteLength(body)
        )
          throw new Error("invalid offset");
        const absolute = path.isAbsolute(file) ? file : path.resolve(context.workspaceRoot, file);
        const display = context.pathPolicy.isInside(absolute)
          ? path.relative(context.workspaceRoot, absolute)
          : absolute;
        const rendered = `${escapedTokens(display.split(path.sep).join("/")).join("")}:${number as number}: ${renderBody(body, start as number)}`;
        if (limited || state.limited) return;
        if (state.matches.length >= (args.limit ?? GREP_DEFAULT_LIMIT)) state.limited = "count";
        else if (state.size + size(rendered) + (state.matches.length > 0 ? 1 : 0) > GREP_MAX_OUTPUT_CHARS)
          state.limited = "char";
        else {
          state.size += size(rendered) + (state.matches.length > 0 ? 1 : 0);
          state.matches.push(rendered);
        }
      } catch (cause) {
        reportToolDiagnostic(context.onDiagnostic, "grep.event", cause);
        state.failed = true;
      }
    } catch (cause) {
      reportToolDiagnostic(context.onDiagnostic, "grep.parse", cause);
      parseFailed = true;
      child.kill();
    }
  };
  let pending = "";
  const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of child.stdout) {
      pending += stdoutDecoder.decode(chunk as Buffer, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        consumeEvent(line);
      }
    }
    pending += stdoutDecoder.decode();
    if (pending.length > 0 && !limited && !aborted) consumeEvent(pending);
  } catch (cause) {
    reportToolDiagnostic(context.onDiagnostic, "grep.stream", cause);
    parseFailed = true;
    child.kill();
  }
  const finished = await completion;
  if (pendingFiles.size > 0 && !limited && !aborted) parseFailed = true;
  context.signal?.removeEventListener("abort", abort);
  if (aborted) return error("Cancelled by user.", "cancelled");
  if (spawnFailed) return error("Search is unavailable.");
  const diagnostic = stderrTruncated
    ? stderrHead.join("") + marker + stderrTail.join("")
    : stderrFull.join("");
  if (parseFailed) return error("Search incomplete: could not decode search output.");
  if (finished.code === 2 || (!limited && finished.code !== 0 && finished.code !== 1)) {
    const raw = diagnostic;
    if (finished.code === 2 && raw.includes("regex parse error"))
      return error("Invalid pattern: malformed or unsupported regular expression.");
    if (finished.code === 2 && raw.includes("error parsing glob"))
      return error("Invalid glob: malformed glob expression.");
    if (diagnostic.length > 0) return error(`Search incomplete: "${diagnostic}".`);
    if (finished.signal || finished.code === null)
      return error("Search incomplete: process exited unexpectedly.");
    return error("Search incomplete.");
  }
  if (limited)
    return {
      status: "success",
      content: [...matches, limited === "char" ? charNotice : countNotice()].join("\n"),
    };
  return { status: "success", content: matches.length > 0 ? matches.join("\n") : "No matches found." };
}
