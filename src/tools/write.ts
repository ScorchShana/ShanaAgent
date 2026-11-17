import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PathTargetChangedError, type ResolvedToolPath } from "../security/path-policy.js";
import type { ToolOutcome } from "./registry.js";

export const WRITE_MAX_CONTENT_CHARACTERS = 400_000;
export const WRITE_MAX_EXISTING_FILE_BYTES = 16_777_216;

export interface WriteArguments {
  path: string;
  content: string;
}
export interface FileOperationContext {
  assertPathTarget?: () => Promise<void>;
  signal?: AbortSignal;
  onDiagnostic?: (event: { stage: string; code?: string; temporaryPath?: string }) => void;
  onCleanupWarning?: (temporaryPath: string) => void;
}

export class Utf8DecodeError extends Error {
  constructor() {
    super("File is not supported text; expected UTF-8 without NUL.");
    this.name = "Utf8DecodeError";
  }
}

export function fileOperationError(error: unknown): ToolOutcome {
  if (error instanceof PathTargetChangedError) return failure(error.message, "path");
  if (error instanceof Utf8DecodeError) return failure(error.message);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const reasons: Record<string, string> = {
    EACCES: "Permission denied.",
    EPERM: "Permission denied.",
    ENOSPC: "No space left on device.",
    EROFS: "Read-only file system.",
    ENOENT: "Path not found.",
    ENOTDIR: "Path not found.",
    EISDIR: "Path is a directory.",
    EINVAL: "Invalid path.",
    ENAMETOOLONG: "Invalid path.",
  };
  return failure(
    code ? (reasons[code] ?? "File operation failed.") : "Internal error. Stop and ask user.",
    code ? "io" : "internal",
  );
}

export function failure(
  reason: string,
  category: "io" | "path" | "internal" | "cancelled" = "io",
): ToolOutcome {
  return { status: "error", category, content: `Error: ${reason}` };
}

export function formatSuccessPath(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === "\\") result += "\\\\";
    else if (character === "\n") result += "\\n";
    else if (character === "\r") result += "\\r";
    else if (character === "\t") result += "\\t";
    else if (
      code < 32 ||
      (code >= 127 && code <= 159) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += character;
  }
  return result;
}

export function validateTextArgument(name: string, value: string, limit: number): ToolOutcome | undefined {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
    return failure(`${name} contains invalid Unicode.`);
  if (value.includes("\0")) return failure(`${name} contains NUL characters.`);
  if (Array.from(value).length > limit)
    return failure(`${name} exceeds the ${limit === 100_000 ? "100,000" : limit}-character limit.`);
  return undefined;
}

export function decodeUtf8Strict(buffer: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Utf8DecodeError();
  }
  if (text.includes("\0")) throw new Utf8DecodeError();
  return text;
}

export async function readFileUpTo(realPath: string, maxBytes: number): Promise<Buffer> {
  const stream = fs.createReadStream(realPath, { start: 0, end: maxBytes - 1 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function diagnose(
  context: FileOperationContext,
  stage: string,
  error: unknown,
  temporaryPath?: string,
): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  context.onDiagnostic?.({
    stage,
    ...(typeof code === "string" ? { code } : {}),
    ...(temporaryPath ? { temporaryPath } : {}),
  });
}

class EditCancelledError extends Error {}

export async function writeFileAtomically(
  destination: string,
  content: string,
  existingMode?: number,
  context: FileOperationContext = {},
): Promise<void> {
  const tempPath = path.join(
    path.dirname(destination),
    `.shana-write-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  let handle: fs.promises.FileHandle | undefined;
  let created = false;
  let committed = false;
  let stage = "create";
  try {
    if (context.signal?.aborted) throw new EditCancelledError();
    await context.assertPathTarget?.();
    handle = await fs.promises.open(tempPath, "wx", 0o600);
    created = true;
    await context.assertPathTarget?.();
    stage = "write";
    await handle.writeFile(content, "utf8");
    if (process.platform !== "win32" && existingMode !== undefined) {
      stage = "permissions";
      const mode = existingMode & 0o7777;
      await handle.chmod(mode);
      if (((await handle.stat()).mode & 0o7777) !== mode) throw Object.assign(new Error(), { code: "EPERM" });
    }
    stage = "sync";
    await handle.sync();
    stage = "close";
    await handle.close();
    handle = undefined;
    if (context.signal?.aborted) throw new EditCancelledError();
    stage = "rename";
    await context.assertPathTarget?.();
    await fs.promises.rename(tempPath, destination);
    committed = true;
  } catch (error) {
    if (!(error instanceof EditCancelledError)) diagnose(context, stage, error, tempPath);
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        diagnose(context, "cleanup-close", error, tempPath);
        context.onCleanupWarning?.(tempPath);
      }
    }
    if (created && !committed) {
      try {
        await context.assertPathTarget?.();
        await fs.promises.unlink(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          diagnose(context, "cleanup-unlink", error, tempPath);
          context.onCleanupWarning?.(tempPath);
        }
      }
    }
  }
}

export function isEditCancelled(error: unknown): boolean {
  return error instanceof EditCancelledError;
}

export async function writeFileContent(
  args: WriteArguments,
  target: ResolvedToolPath,
  context: FileOperationContext = {},
): Promise<ToolOutcome> {
  const invalid = validateTextArgument("content", args.content, WRITE_MAX_CONTENT_CHARACTERS);
  if (invalid) return invalid;
  if (context.signal?.aborted) return failure("Cancelled by user.", "cancelled");
  if (target.danglingSymlink) return failure("Broken symbolic link.");
  let priorContent: string | undefined;
  try {
    await context.assertPathTarget?.();
    let parent;
    try {
      parent = await fs.promises.stat(path.dirname(target.realPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return failure("Parent directory not found.");
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
        return failure("Parent path is not a directory.");
      throw error;
    }
    if (!parent.isDirectory()) return failure("Parent path is not a directory.");
    if (target.exists) {
      const stats = await fs.promises.stat(target.realPath);
      if (stats.isDirectory()) return failure("Path is a directory.");
      if (!stats.isFile()) return failure("Not a regular file.");
      if (stats.size > WRITE_MAX_EXISTING_FILE_BYTES)
        return failure(`Existing file exceeds the ${WRITE_MAX_EXISTING_FILE_BYTES}-byte limit.`);
      await context.assertPathTarget?.();
      const bytes = await readFileUpTo(target.realPath, WRITE_MAX_EXISTING_FILE_BYTES + 1);
      if (bytes.length > WRITE_MAX_EXISTING_FILE_BYTES)
        return failure(`Existing file exceeds the ${WRITE_MAX_EXISTING_FILE_BYTES}-byte limit.`);
      priorContent = decodeUtf8Strict(bytes);
    }
  } catch (error) {
    diagnose(context, "read", error);
    return fileOperationError(error);
  }
  if (context.signal?.aborted) return failure("Cancelled by user.", "cancelled");
  let handle: fs.promises.FileHandle | undefined;
  let writeStarted = false;
  let outcome: ToolOutcome | undefined;
  try {
    await context.assertPathTarget?.();
    handle = await fs.promises.open(target.realPath, "w");
    writeStarted = true;
    await context.assertPathTarget?.();
    await handle.writeFile(args.content, "utf8");
  } catch (error) {
    diagnose(context, writeStarted ? "overwrite" : "open", error);
    outcome = fileOperationError(error);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        diagnose(context, "close", error);
        outcome ??= fileOperationError(error);
      }
    }
  }
  if (outcome) {
    if (writeStarted && !outcome.content.endsWith("Stop and ask user."))
      outcome.content += " Stop and ask user.";
    return outcome;
  }
  return {
    status: "success",
    content: `Successfully wrote ${formatSuccessPath(args.path)}.`,
    ...(priorContent !== undefined ? { priorContent } : {}),
  };
}
