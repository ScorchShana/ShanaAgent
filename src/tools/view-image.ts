import fs from "node:fs";
import path from "node:path";
import { DEFAULT_VIEW_IMAGE_MAX_BYTES } from "../llm/settings-store.js";
import type { ResolvedToolPath } from "../security/path-policy.js";
import { parseImageHeader } from "./image-header.js";
import { displayPath, ioError } from "./read.js";
import { reportToolDiagnostic, type ToolContext, type ToolOutcome } from "./registry.js";
import { readFileUpTo } from "./write.js";

export interface ViewImageArguments {
  path: string;
}

export const VIEW_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"] as const;

function error(content: string, category: ToolOutcome["category"] = "io"): ToolOutcome {
  return { status: "error", category, content: `Error: ${content}` };
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

export async function viewImageFile(
  args: ViewImageArguments,
  target: ResolvedToolPath,
  context?: Pick<ToolContext, "signal" | "assertPathTarget" | "onDiagnostic" | "viewImageMaxBytes">,
): Promise<ToolOutcome> {
  if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
  if (!(VIEW_IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(args.path).toLowerCase())) {
    return error("Unsupported image format. Supported: png, jpg, jpeg, webp.");
  }
  if (target.danglingSymlink) return error("Broken symbolic link.");
  if (!target.exists) return error("File not found.");
  const maxBytes = context?.viewImageMaxBytes ?? DEFAULT_VIEW_IMAGE_MAX_BYTES;
  const sizeError = (bytes: number): ToolOutcome =>
    error(`Image exceeds the size limit (${bytes} bytes; max ${maxBytes} bytes).`);
  try {
    await context?.assertPathTarget?.();
    const stats = await fs.promises.stat(target.realPath);
    if (stats.isDirectory()) return error("Path is a directory.");
    if (!stats.isFile()) return error("Not a regular file.");
    if (stats.size > maxBytes) return sizeError(stats.size);
  } catch (cause) {
    reportToolDiagnostic(context?.onDiagnostic, "view_image.stat", cause);
    return ioError(cause);
  }

  let bytes: Buffer;
  try {
    await context?.assertPathTarget?.();
    // 限量读 max+1 防 stat 后竞态增长；读后仍超限按已读字节数报告。
    bytes = await readFileUpTo(target.realPath, maxBytes + 1);
  } catch (cause) {
    reportToolDiagnostic(context?.onDiagnostic, "view_image.read", cause);
    if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
    return ioError(cause);
  }
  if (bytes.length > maxBytes) return sizeError(bytes.length);
  const header = parseImageHeader(bytes);
  if (!header) return error("File content does not match a supported image format.");
  // 只读无副作用；readFileUpTo 无 signal 参数，取消在读取前后边界检查即可。
  if (context?.signal?.aborted) return error("Cancelled by user.", "cancelled");
  return {
    status: "success",
    content: [
      `<path>${displayPath(args.path)}</path>`,
      `(Image attached: ${header.mimeType}, ${header.width}x${header.height}, ${sizeText(bytes.length)}.)`,
    ].join("\n"),
    images: [
      {
        data: bytes.toString("base64"),
        mimeType: header.mimeType,
        width: header.width,
        height: header.height,
      },
    ],
  };
}