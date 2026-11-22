import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PathTargetChangedError, type PathPolicy } from "./path-policy.js";
import type { ApprovalMode } from "./permissions.js";

const run = promisify(execFile);
const maxIndexBytes = 16 * 1024 * 1024;
type GitVerdict =
  | { decision: "ask" }
  | { decision: "allow"; revalidate: () => Promise<void>; readPaths: string[]; writePaths: string[] };

// Skip cache entries by their on-disk boundaries so a tracked filename containing
// "link" cannot be mistaken for the split-index extension.
function sharedIndexName(body: Buffer, hashSize: number): string | undefined {
  const version = body.readUInt32BE(4);
  let at = 12;
  for (let i = 0; i < body.readUInt32BE(8); i++) {
    const start = at;
    at += 40 + hashSize;
    const flags = body.readUInt16BE(at);
    at += flags & 0x4000 ? 4 : 2;
    if (version === 4) {
      // v4 encodes the removed prefix length as a variable-width integer.
      while (body.readUInt8(at++) & 0x80) {
        /* consume continuation bytes */
      }
    }
    const end = body.indexOf(0, at);
    if (end < 0) throw new PathTargetChangedError();
    at = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
  }
  let shared: string | undefined;
  while (at < body.length) {
    const signature = body.toString("latin1", at, at + 4);
    const length = body.readUInt32BE(at + 4);
    at += 8;
    if (at + length > body.length) throw new PathTargetChangedError();
    if (signature === "link") {
      if (shared || length < hashSize) throw new PathTargetChangedError();
      shared = "sharedindex." + body.subarray(at, at + hashSize).toString("hex");
    } else if (!/^[A-Z]/.test(signature)) {
      throw new PathTargetChangedError();
    }
    at += length;
  }
  if (at !== body.length) throw new PathTargetChangedError();
  return shared;
}

function knownEnvironment() {
  const index = process.env.GIT_INDEX_FILE;
  if (index !== undefined) {
    // MSYS may translate POSIX absolute paths in environment variables before
    // starting native Git. An unresolved parent after a link is ambiguous too.
    if (!index || index.split(/[\\/]/).includes("..")) return false;
    if (process.platform === "win32" && (/^[\\/]/.test(index) || /^[a-z]:(?![\\/])/i.test(index)))
      return false;
  }
  return Object.keys(process.env).every((key) => {
    if (!/^GIT_/i.test(key)) return true;
    if (["GIT_INDEX_FILE", "GIT_PAGER", "GIT_CONFIG_COUNT"].includes(key)) return true;
    const pair = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/.exec(key);
    return pair !== null && process.env[`GIT_CONFIG_KEY_${pair[1]}`] === "safe.directory";
  });
}

async function defaultGit() {
  if (process.platform !== "win32") return "/usr/bin/git";
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, "git.exe");
    if (
      await fs.stat(candidate).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return candidate;
  }
  throw new PathTargetChangedError();
}

export async function analyzeGitQuery(
  args: string[],
  cwd: string,
  policy: PathPolicy,
  mode: ApprovalMode,
  executable?: string,
): Promise<GitVerdict> {
  const indexQuery = args.length === 2 && args[0] === "ls-files" && args[1] === "--cached";
  const rootQuery = args.length === 2 && args[0] === "rev-parse" && args[1] === "--show-toplevel";
  if (!indexQuery && !rootQuery) return { decision: "ask" };

  async function snapshot(effects?: { readPaths: string[]; writePaths: string[] }) {
    if (!knownEnvironment() || process.platform !== policy.platform) throw new PathTargetChangedError();
    if (!path.isAbsolute(cwd) || !policy.isInside(await fs.realpath(cwd))) throw new PathTargetChangedError();
    const git = executable ?? (await defaultGit());
    if (!path.isAbsolute(git) || policy.isInside(await fs.realpath(git))) throw new PathTargetChangedError();
    const options = {
      cwd,
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 65536,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TRACE2: "0",
        GIT_TRACE2_PERF: "0",
        GIT_TRACE2_EVENT: "0",
      },
    };
    // rev-parse path queries do not load the index; --shared-index-path would refresh its mtime.
    const probe = await run(
      git,
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "--git-path",
        "index",
        "--show-object-format",
      ],
      options,
    );
    const fields = probe.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
    if (fields.length !== 5) throw new PathTargetChangedError();
    const [worktree, gitdir, common, index, format] = fields as [string, string, string, string, string];
    const checked: string[] = [];
    async function check(raw: string, type: "directory" | "file" | "index") {
      if (!path.isAbsolute(raw) || raw.split(path.sep === "/" ? "/" : /[\\/]/).includes(".."))
        throw new PathTargetChangedError();
      const target = policy.resolve(raw);
      if (!target.insideWorkspace || target.danglingSymlink) throw new PathTargetChangedError();
      effects?.readPaths.push(target.realPath);
      checked.push(target.realPath, String(target.exists));
      if (!target.exists && type === "index") return target;
      const stat = await fs.stat(target.realPath);
      if (type === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new PathTargetChangedError();
      return target;
    }
    await check(worktree, "directory");
    await check(gitdir, "directory");
    await check(common, "directory");
    // These settings can run a helper, redirect diagnostics or cause a lazy object fetch.
    const config = await run(git, ["config", "--null", "--list", "--name-only"], options);
    if (
      config.stdout
        .split("\0")
        .some((k) =>
          /^(trace2\.|core\.(fsmonitor|sparsecheckout)$|extensions\.(partialclone|sparseindex)$|remote\..*\.promisor$)/i.test(
            k,
          ),
        )
    )
      throw new PathTargetChangedError();
    if (!indexQuery) return JSON.stringify(checked);
    const target = await check(index, "index");
    if (target.exists) {
      if (format !== "sha1" && format !== "sha256") throw new PathTargetChangedError();
      const hashSize = format === "sha1" ? 20 : 32;
      const handle = await fs.open(target.realPath, "r");
      try {
        const { size } = await handle.stat();
        if (size < 12 + hashSize || size > maxIndexBytes) throw new PathTargetChangedError();
        const bytes = Buffer.alloc(size);
        if (
          (await handle.read(bytes)).bytesRead !== size ||
          bytes.toString("ascii", 0, 4) !== "DIRC" ||
          ![2, 3, 4].includes(bytes.readUInt32BE(4))
        )
          throw new PathTargetChangedError();
        const body = bytes.subarray(0, -hashSize);
        const hash = createHash(format).update(body).digest();
        if (!hash.equals(bytes.subarray(-hashSize))) throw new PathTargetChangedError();
        checked.push(hash.toString("hex"));
        const name = sharedIndexName(body, hashSize);
        if (name) {
          if (mode !== "auto") throw new PathTargetChangedError();
          const shared = await check(path.join(gitdir, name), "file");
          effects?.writePaths.push(shared.realPath);
          if ((await fs.stat(shared.realPath)).nlink !== 1) throw new PathTargetChangedError();
        }
      } finally {
        await handle.close();
      }
    }
    return JSON.stringify(checked);
  }
  try {
    const effects = { readPaths: [] as string[], writePaths: [] as string[] };
    const original = await snapshot(effects);
    return {
      decision: "allow",
      ...effects,
      async revalidate() {
        if ((await snapshot().catch(() => undefined)) !== original) throw new PathTargetChangedError();
      },
    };
  } catch {
    return { decision: "ask" };
  }
}
