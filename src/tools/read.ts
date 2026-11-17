import fs from "node:fs";
import { formatSuccessPath, fileOperationError } from "./write.js";
import { PathTargetChangedError, type ResolvedToolPath } from "../security/path-policy.js";
import { reportToolDiagnostic, type ToolContext, type ToolOutcome } from "./registry.js";

export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LIMIT = 5000;
export const READ_MAX_LINE_CHARS = 2000;
export const READ_MAX_OUTPUT_CHARS = 24_000;

export interface ReadArguments {
  path: string;
  offset: number;
  limit: number;
}

function error(content: string, category: ToolOutcome["category"] = "io"): ToolOutcome {
  return { status: "error", category, content: `Error: ${content}` };
}

function ioError(cause: unknown): ToolOutcome {
  if (cause instanceof PathTargetChangedError) return fileOperationError(cause);
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return error("File not found.");
  if (code === "EACCES" || code === "EPERM") return error("Permission denied.");
  if (code === "EISDIR") return error("Path is a directory.");
  if (code === "EINVAL" || code === "ENAMETOOLONG" || code === "ENOTDIR") return error("Invalid path.");
  return error("File operation failed.");
}

function displayPath(value: string): string {
  return formatSuccessPath(value).replace(
    /[<>]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function validateReadPathBudget(args: ReadArguments): string | undefined {
  const last = args.offset + args.limit - 1;
  const next = args.offset + args.limit;
  const status = `(Showing lines ${args.offset}-${last}; char limit reached. Use offset=${next} to continue. ${args.limit} ${args.limit === 1 ? "line" : "lines"} truncated.)`;
  const wrapper = [`<path>${displayPath(args.path)}</path>`, "<content>", "</content>", status].join("\n");
  return Array.from(wrapper).length > READ_MAX_OUTPUT_CHARS ? "path is too long. Not executed." : undefined;
}

async function* fileLines(stream: fs.ReadStream): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 10) continue;
      pending.push(buffer.subarray(start, i));
      const line = Buffer.concat(pending);
      yield line.at(-1) === 13 ? line.subarray(0, -1) : line;
      pending = [];
      start = i + 1;
    }
    if (start < buffer.length) pending.push(buffer.subarray(start));
  }
  if (pending.length > 0) yield Buffer.concat(pending);
}

export async function readFileRange(
  args: ReadArguments,
  target: ResolvedToolPath,
  context?: Pick<ToolContext, "signal" | "assertPathTarget" | "onDiagnostic">,
): Promise<ToolOutcome> {
  const pathError = validateReadPathBudget(args);
  if (pathError) return error(pathError, "path");
  if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
  if (target.danglingSymlink) return error("Broken symbolic link.");
  if (!target.exists) return error("File not found.");
  try {
    await context?.assertPathTarget?.();
    const stats = await fs.promises.stat(target.realPath);
    if (stats.isDirectory()) return error("Path is a directory.");
    if (!stats.isFile()) return error("Not a regular file.");
  } catch (cause) {
    reportToolDiagnostic(context?.onDiagnostic, "read.stat", cause);
    return ioError(cause);
  }

  await context?.assertPathTarget?.();
  const stream = fs.createReadStream(target.realPath, { signal: context?.signal });
  const selected: { number: number; text: string; truncated: boolean }[] = [];
  let number = 0;
  let stop: "line" | "char" | undefined;
  const wrap = (status: string): string =>
    [
      `<path>${displayPath(args.path)}</path>`,
      "<content>",
      ...selected.map((line) => `${line.number}:${line.text.length > 0 ? ` ${line.text}` : ""}`),
      "</content>",
      status,
    ].join("\n");
  const status = (kind: "line" | "char" | "eof"): string => {
    const last = selected.at(-1)?.number ?? args.offset - 1;
    const count = selected.filter((line) => line.truncated).length;
    const suffix = count === 0 ? "" : ` ${count} ${count === 1 ? "line" : "lines"} truncated.`;
    const ending =
      kind === "eof" ? "end of file." : `${kind} limit reached. Use offset=${last + 1} to continue.`;
    return `(Showing lines ${args.offset}-${last}; ${ending}${suffix})`;
  };
  try {
    for await (const bytes of fileLines(stream)) {
      if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
      number += 1;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (cause) {
        reportToolDiagnostic(context?.onDiagnostic, "read.decode", cause);
        return error("File is not supported text; expected UTF-8 without NUL.");
      }
      if (text.includes("\0")) return error("File is not supported text; expected UTF-8 without NUL.");
      if (number < args.offset) continue;
      const points = Array.from(text);
      const line = {
        number,
        text:
          points.slice(0, READ_MAX_LINE_CHARS).join("") +
          (points.length > READ_MAX_LINE_CHARS ? "…[truncated]" : ""),
        truncated: points.length > READ_MAX_LINE_CHARS,
      };
      selected.push(line);
      const fits = Array.from(wrap(status("eof"))).length <= READ_MAX_OUTPUT_CHARS;
      if (selected.length > args.limit || !fits) {
        selected.pop();
        stop = !fits ? "char" : "line";
        while (selected.length > 0 && Array.from(wrap(status(stop))).length > READ_MAX_OUTPUT_CHARS) {
          selected.pop();
          stop = "char";
        }
        break;
      }
    }
  } catch (cause) {
    reportToolDiagnostic(context?.onDiagnostic, "read.stream", cause);
    if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
    return ioError(cause);
  } finally {
    stream.destroy();
  }
  if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
  if (stop) return { status: "success", content: wrap(status(stop)) };
  if (number === 0) return { status: "success", content: wrap("(Empty file.)") };
  if (selected.length === 0)
    return { status: "success", content: wrap(`(No line ${args.offset}; file has ${number} lines.)`) };
  return { status: "success", content: wrap(status("eof")) };
}
