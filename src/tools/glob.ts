import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { globbyStream } from "globby";
import { DEFAULT_GLOB_TIMEOUT_MS } from "../llm/settings-store.js";
import { PathTargetChangedError, isPathInside, type ResolvedToolPath } from "../security/path-policy.js";
import { formatSuccessPath } from "./write.js";
import type { ToolContext, ToolOutcome } from "./registry.js";

export const GLOB_MAX_RESULTS = 200;
export const GLOB_MAX_OUTPUT_CHARS = 24000;
export interface GlobArguments {
  pattern: string;
  path?: string;
}
export function hasParentSegment(pattern: string): boolean {
  return pattern.split(/[\\/]+/).includes("..");
}
function* expandBraces(pattern: string): Generator<string> {
  const syntax = pattern.replace(/\[[^\]]*\]/g, (characterClass) => " ".repeat(characterClass.length));
  const start = syntax.indexOf("{");
  if (start < 0) {
    yield pattern;
    return;
  }
  let depth = 0;
  let end = -1;
  const commas: number[] = [];
  for (let i = start; i < pattern.length; i++) {
    if (syntax[i] === "{") depth++;
    if (syntax[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    if (syntax[i] === "," && depth === 1) commas.push(i);
  }
  if (end < 0 || commas.length === 0) {
    yield pattern;
    return;
  }
  const boundaries = [start, ...commas, end];
  for (let i = 0; i < boundaries.length - 1; i++) {
    yield* expandBraces(
      pattern.slice(0, start) + pattern.slice(boundaries[i]! + 1, boundaries[i + 1]) + pattern.slice(end + 1),
    );
  }
}

export function validateGlobPattern(pattern: string): string | undefined {
  if (!pattern) return "pattern must not be empty. Not executed.";
  if (pattern.includes("\0")) return "pattern contains NUL characters. Not executed.";
  if (pattern.includes("\\")) return "Invalid pattern: use '/' as the path separator.";
  for (const branch of expandBraces(pattern)) {
    if (path.posix.isAbsolute(branch) || /^[a-z]:/i.test(branch) || hasParentSegment(branch))
      return "Invalid pattern: must be relative and contain no '..' path segments.";
    if (branch.startsWith("!")) return "Invalid pattern: negation patterns are not supported.";
  }
  if (/[?*+@!]\(/.test(pattern) || /\{(?:-?\d+|[a-z])\.\.(?:-?\d+|[a-z])(?:\.\.-?\d+)?\}/i.test(pattern))
    return "Invalid pattern: unsupported glob syntax.";
  return undefined;
}

export async function searchGlob(
  args: GlobArguments,
  scope: ResolvedToolPath,
  context: ToolContext,
): Promise<ToolOutcome> {
  const error = (message: string, category: ToolOutcome["category"] = "io"): ToolOutcome => ({
    status: "error",
    category,
    content: `Error: ${message}`,
  });
  let stopped: "timeout" | "cancelled" | undefined;
  const started = performance.now();
  const timeout = context.globTimeoutMs ?? DEFAULT_GLOB_TIMEOUT_MS;
  const check = (): void => {
    if (context.signal?.aborted) stopped ??= "cancelled";
    if (performance.now() - started >= timeout) stopped ??= "timeout";
    if (stopped) throw Object.assign(new Error(stopped), { code: "ABORT_ERR" });
  };
  const pending = new Set<Promise<void>>();
  const callbackMethods = new Set(["stat", "lstat", "readdir", "readFile", "realpath"]);
  const promiseFs = new Proxy(fs.promises, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        check();
        const operation = Promise.resolve(Reflect.apply(method, target, args));
        const tracked = operation.then(
          () => {},
          () => {},
        );
        pending.add(tracked);
        try {
          return await operation;
        } finally {
          pending.delete(tracked);
        }
      };
    },
  });
  const adapter = new Proxy(fs, {
    get(target, key) {
      if (key === "promises") return promiseFs;
      const method = Reflect.get(target, key);
      if (typeof method !== "function" || !callbackMethods.has(String(key))) return method;
      return (...args: unknown[]) => {
        const callback = args.pop();
        if (typeof callback !== "function") throw new Error("Filesystem callback missing");
        try {
          check();
        } catch (cause) {
          callback(cause);
          return;
        }
        let finish!: () => void;
        const tracked = new Promise<void>((resolve) => {
          finish = resolve;
        });
        pending.add(tracked);
        const done = (...result: unknown[]) => {
          pending.delete(tracked);
          finish();
          callback(...result);
        };
        try {
          Reflect.apply(method, target, [...args, done]);
        } catch (cause) {
          done(cause);
        }
      };
    },
  });
  const cancel = () => {
    stopped ??= "cancelled";
  };
  context.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    stopped ??= "timeout";
  }, timeout);
  let stream: ReturnType<typeof globbyStream> | undefined;
  try {
    check();
    await context.assertPathTarget?.();
    const stats = await promiseFs.stat(scope.realPath);
    if (!stats.isDirectory()) return error("Path is not a directory.");
    const patterns: string[] = [];
    for (const branch of expandBraces(args.pattern)) {
      let candidate = scope.realPath;
      let blocked = false;
      for (const part of branch.split("/")) {
        if (/[*?[\]{}]/.test(part)) break;
        if (!part) continue;
        candidate = path.join(candidate, part);
        try {
          const entry = await promiseFs.lstat(candidate);
          if (entry.isSymbolicLink()) {
            const actual = await promiseFs.realpath(candidate);
            if (
              (!context.pathPolicy.isInside(actual) &&
                !(!scope.insideWorkspace && isPathInside(scope.realPath, actual, context.platform))) ||
              (await promiseFs.stat(actual)).isDirectory()
            ) {
              blocked = true;
              break;
            }
          }
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          break;
        }
      }
      if (!blocked) patterns.push(branch);
    }
    if (!patterns.length) return { status: "success", content: "(No files found)" };
    await context.assertPathTarget?.();
    stream = globbyStream(patterns, {
      cwd: scope.realPath,
      fs: adapter,
      gitignore: true,
      globalGitignore: false,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      expandDirectories: true,
      expandNegationOnlyPatterns: false,
      caseSensitiveMatch: true,
      braceExpansion: true,
      extglob: false,
      unique: true,
      absolute: false,
      suppressErrors: false,
      ignore: ["**/.git", "**/.git/**"],
    });
    const entries: { display: string; mtime: number }[] = [];
    for await (const item of stream) {
      check();
      const absolute = path.resolve(scope.realPath, String(item));
      try {
        const actual = await promiseFs.realpath(absolute);
        if (
          !context.pathPolicy.isInside(actual) &&
          !(!scope.insideWorkspace && isPathInside(scope.realPath, actual, context.platform))
        )
          continue;
        const stat = await promiseFs.stat(actual);
        if (!stat.isFile()) continue;
        const displayed =
          args.path && path.isAbsolute(args.path)
            ? path.resolve(scope.absolutePath, String(item))
            : path.relative(context.workspaceRoot, path.resolve(scope.absolutePath, String(item)));
        entries.push({ display: displayed.split(path.sep).join("/"), mtime: stat.mtimeMs });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    }
    check();
    entries.sort((a, b) => b.mtime - a.mtime || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
    const lines: string[] = [];
    let reason: "count" | "char" | undefined;
    for (const entry of entries) {
      check();
      if (lines.length === GLOB_MAX_RESULTS) {
        reason = "count";
        break;
      }
      const line = formatSuccessPath(entry.display);
      if ([...lines, line].join("\n").length > GLOB_MAX_OUTPUT_CHARS) {
        reason = "char";
        break;
      }
      lines.push(line);
    }
    if (reason) {
      let note =
        reason === "count"
          ? "(Results truncated: showing 200 files; narrow path or pattern.)"
          : "(Results truncated: char limit reached; narrow path or pattern.)";
      if ([...lines, "", note].join("\n").length > GLOB_MAX_OUTPUT_CHARS)
        note = "(Results truncated: char limit reached; narrow path or pattern.)";
      while ([...lines, "", note].join("\n").length > GLOB_MAX_OUTPUT_CHARS) lines.pop();
      return { status: "success", content: [...lines, "", note].join("\n") };
    }
    return { status: "success", content: lines.length ? lines.join("\n") : "(No files found)" };
  } catch (cause) {
    if (cause instanceof PathTargetChangedError) return error(cause.message, "path");
    if (stopped === "cancelled") return error("Cancelled by user.", "cancelled");
    if (stopped === "timeout") return error("Search timed out.");
    const code = (cause as NodeJS.ErrnoException).code;
    context.onDiagnostic?.({ stage: "glob", ...(code ? { code } : {}) });
    if (code === "ENOENT" && !stream) return error("Path not found.");
    if (code === "EACCES" || code === "EPERM") return error("Search incomplete: permission denied.");
    return typeof code === "string"
      ? error("Search incomplete: file operation failed.")
      : error("Internal error. Stop and ask user.", "internal");
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", cancel);
    if (stream instanceof Readable) stream.destroy();
    await Promise.allSettled(pending);
  }
}
