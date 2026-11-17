import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WORKSPACE_HASH_LENGTH = 12;
const SLUG_MAX_LENGTH = 24;

export interface WorkspaceIdentity {
  id: string;
  path: string;
  slug: string;
  hash: string;
}

function normalizeWindowsPath(p: string): string {
  let normalized = p.replace(/\\/g, "/").toLowerCase();
  normalized = normalized.replace(/\/+/g, "/");
  if (/^[a-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function normalizePosixPath(p: string): string {
  if (p === "/") return p;
  return p.replace(/\/+$/, "");
}

export function normalizeWorkspacePath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathModule.resolve(rawPath);
  let real = resolved;
  if (platform === process.platform) {
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      // 路径不存在（如纯字符串规范化测试）时退回 resolved
    }
  }
  return platform === "win32" ? normalizeWindowsPath(real) : normalizePosixPath(real);
}

export function slugifyWorkspacePath(normalizedPath: string): string {
  const base = normalizedPath.split("/").filter((segment) => segment.length > 0).pop() ?? "";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "workspace";
}

export function deriveWorkspaceIdentity(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): WorkspaceIdentity {
  const normalized = normalizeWorkspacePath(rawPath, platform);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, WORKSPACE_HASH_LENGTH);
  const slug = slugifyWorkspacePath(normalized);
  return { id: `${slug}-${hash}`, path: normalized, slug, hash };
}
