import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PathPolicyError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PathPolicyError";
  }
}

// skills 只读区根：精确限定 skills/ 子目录，~/.shana 其余（sessions/logs/model.json）无任何放行。
export const DEFAULT_SKILLS_ROOT = path.join(os.homedir(), ".shana", "skills");

export interface ResolvedToolPath {
  requested: string;
  absolutePath: string;
  realPath: string;
  insideWorkspace: boolean;
  insideSkills: boolean;
  exists: boolean;
  isSymlink: boolean;
  danglingSymlink: boolean;
}

export interface PathPolicy {
  workspaceRoot: string;
  skillsRoot: string;
  platform: NodeJS.Platform;
  resolve(rawPath: string): ResolvedToolPath;
  isInside(candidateRealPath: string): boolean;
}

function stripNamespacedPrefix(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

export function isPathInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathImpl = platform === "win32" ? path.win32 : path.posix;
  const relative = pathImpl.relative(
    normalizeForComparison(root, platform),
    normalizeForComparison(candidate, platform),
  );
  if (relative === "") return true;
  if (pathImpl.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${pathImpl.sep}`);
}

function canonicalRealPath(target: string, platform: NodeJS.Platform): string {
  return stripNamespacedPrefix(fs.realpathSync.native(target), platform);
}

function resolveMissingPath(
  absolutePath: string,
  platform: NodeJS.Platform,
): { realPath: string; danglingSymlink: boolean } {
  let current = path.dirname(absolutePath);
  const tail: string[] = [path.basename(absolutePath)];
  while (true) {
    try {
      const ancestorStats = fs.lstatSync(current);
      if (ancestorStats.isSymbolicLink()) {
        try {
          const realAncestor = canonicalRealPath(current, platform);
          return { realPath: path.join(realAncestor, ...tail.reverse()), danglingSymlink: false };
        } catch {
          return { realPath: absolutePath, danglingSymlink: true };
        }
      }
      const realAncestor = canonicalRealPath(current, platform);
      return { realPath: path.join(realAncestor, ...tail.reverse()), danglingSymlink: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PathPolicyError(
          `cannot resolve path "${absolutePath}": ${(error as Error).message}`,
          (error as NodeJS.ErrnoException).code,
        );
      }
      const parent = path.dirname(current);
      if (parent === current) return { realPath: absolutePath, danglingSymlink: false };
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function canonicalRoot(rawRoot: string, platform: NodeJS.Platform): string {
  const absolute = path.resolve(rawRoot);
  try {
    return canonicalRealPath(absolute, platform);
  } catch {
    return absolute;
  }
}

export function createPathPolicy(
  rawWorkspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
  rawSkillsRoot: string = DEFAULT_SKILLS_ROOT,
): PathPolicy {
  const workspaceRoot = canonicalRoot(rawWorkspaceRoot, platform);
  const skillsRoot = canonicalRoot(rawSkillsRoot, platform);

  function inside(candidate: string): boolean {
    return !candidate.includes("\0") && isPathInside(workspaceRoot, candidate, platform);
  }

  function resolve(rawPath: string): ResolvedToolPath {
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      throw new PathPolicyError("path must be a non-empty string");
    }
    if (rawPath.includes("\0")) {
      throw new PathPolicyError("path must not contain NUL bytes");
    }
    const absolutePath = path.resolve(workspaceRoot, rawPath);
    let exists = false;
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(absolutePath).isSymbolicLink();
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PathPolicyError(
          `cannot inspect path "${rawPath}": ${(error as Error).message}`,
          (error as NodeJS.ErrnoException).code,
        );
      }
    }

    let realPath: string;
    let danglingSymlink = false;
    if (exists) {
      try {
        realPath = canonicalRealPath(absolutePath, platform);
      } catch (error) {
        if (isSymlink && (error as NodeJS.ErrnoException).code === "ENOENT") {
          danglingSymlink = true;
          realPath = absolutePath;
        } else {
          throw new PathPolicyError(
            `cannot resolve path "${rawPath}": ${(error as Error).message}`,
            (error as NodeJS.ErrnoException).code,
          );
        }
      }
    } else {
      const missing = resolveMissingPath(absolutePath, platform);
      realPath = missing.realPath;
      danglingSymlink = missing.danglingSymlink;
    }

    return {
      requested: rawPath,
      absolutePath,
      realPath,
      insideWorkspace: !danglingSymlink && inside(realPath),
      insideSkills:
        !danglingSymlink && !realPath.includes("\0") && isPathInside(skillsRoot, realPath, platform),
      exists,
      isSymlink,
      danglingSymlink,
    };
  }

  return { workspaceRoot, skillsRoot, platform, resolve, isInside: inside };
}

export class PathTargetChangedError extends PathPolicyError {
  constructor() {
    super("Path target changed. Stop and ask user.");
    this.name = "PathTargetChangedError";
  }
}

async function resolveCurrentTarget(absolutePath: string, platform: NodeJS.Platform): Promise<string> {
  let current = absolutePath;
  const tail: string[] = [];
  while (true) {
    try {
      const actual = stripNamespacedPrefix(await fs.promises.realpath(current), platform);
      return path.join(actual, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await fs.promises.lstat(current)).isSymbolicLink()) throw new PathTargetChangedError();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

export async function assertPathTargetUnchanged(policy: PathPolicy, target: ResolvedToolPath): Promise<void> {
  if (target.danglingSymlink) return;
  try {
    const requested = await resolveCurrentTarget(target.absolutePath, policy.platform);
    const canonical = await resolveCurrentTarget(target.realPath, policy.platform);
    const expected = normalizeForComparison(target.realPath, policy.platform);
    if (
      normalizeForComparison(requested, policy.platform) !== expected ||
      normalizeForComparison(canonical, policy.platform) !== expected ||
      policy.isInside(canonical) !== target.insideWorkspace
    ) {
      throw new PathTargetChangedError();
    }
  } catch (cause) {
    if (cause instanceof PathPolicyError) throw cause;
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string") throw new PathPolicyError("Path validation failed.", code);
    throw cause;
  }
}
