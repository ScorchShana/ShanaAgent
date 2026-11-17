import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { reportToolDiagnostic, type ToolDiagnostic, type ToolOutcome } from "./registry.js";

export type SpawnProcess = typeof spawn;

export type ShellKind = "bash";

export interface ShellDescriptor {
  kind: ShellKind;
  executable: string;
  argumentsFor(command: string): string[];
}

export type KillOutcome = "terminated" | "unconfirmed" | "failed";

export interface TerminationDetails {
  trigger: "timeout" | "cancelled" | "internal_error";
  kill: KillOutcome;
}

export interface ShellRunResult {
  status: "exited" | "timeout" | "cancelled" | "spawn_failed" | "internal_error";
  started: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  kill?: KillOutcome;
  errorMessage?: string;
  errorReason?: string;
  signal?: string;
}

export type TerminateProcessTree = (
  child: ChildProcess,
  options: {
    platform: NodeJS.Platform;
    confirmTimeoutMs: number;
    shellExecutable?: string;
    onDiagnostic?: (event: ToolDiagnostic) => void;
    sweepTimeoutMs?: number;
    onSnapshot?: (snapshot: MsysSweepSnapshot) => void;
  },
) => Promise<KillOutcome>;

export interface MsysSweepDescendant {
  cygwinPid: string;
  winpid: string;
  imageName: string;
}

export interface MsysSweepSnapshot {
  rootCygwinPid: string;
  descendants: MsysSweepDescendant[];
}

export type PendingShellCleanup = () => Promise<KillOutcome>;

export interface ShellRunOptions {
  onPendingShell?: (cleanup: PendingShellCleanup) => void;
  onDiagnostic?: (event: ToolDiagnostic) => void;
  onOutput?: (snapshot: string) => void;
  cwd: string;
  shell: ShellDescriptor;
  timeoutMs: number;
  signal?: AbortSignal;
  spawnProcess?: SpawnProcess;
  terminateTree?: TerminateProcessTree;
  killConfirmTimeoutMs?: number;
  sweepTimeoutMs?: number;
  platform?: NodeJS.Platform;
}

export const SHELL_STDOUT_MAX_CHARS = 16_000;
export const SHELL_STDERR_MAX_CHARS = 4_000;
export const SHELL_KILL_CONFIRM_TIMEOUT_MS = 2_000;
export const SHELL_SWEEP_TIMEOUT_MS = 5_000;
export const SHELL_LIVE_OUTPUT_MAX_CHARS = 2_000;
export const SHELL_LIVE_OUTPUT_INTERVAL_MS = 1_000;
const SHELL_SWEEP_OUTPUT_MAX_CHARS = 4_000;
const SHELL_STDOUT_HEAD_CHARS = 10_000;
const SHELL_STDERR_HEAD_CHARS = 2_400;

export function detectShell(platform: NodeJS.Platform = process.platform): ShellDescriptor {
  let executable = "bash";
  if (platform === "win32") {
    const candidates: string[] = [];
    for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
      const directory = entry.replace(/^"|"$/g, "");
      if (fs.existsSync(path.join(directory, "git.exe"))) {
        candidates.push(path.resolve(directory, "../bin/bash.exe"));
      }
    }
    for (const base of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ]) {
      if (base) candidates.push(path.join(base, "Git", "bin", "bash.exe"));
    }
    executable =
      candidates.find((candidate) => fs.existsSync(candidate)) ??
      path.win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  }
  return { kind: "bash", executable, argumentsFor: (command) => ["-c", command] };
}

class CappedCollector {
  private readonly decoder = new StringDecoder("utf8");
  private head = "";
  private tail = "";
  private chars = 0;
  truncated = false;

  constructor(
    private readonly headLimit: number,
    private readonly tailLimit: number,
  ) {}

  append(chunk: Buffer | string): void {
    this.collect(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  private collect(text: string): void {
    this.chars += text.length;
    const headRemaining = this.headLimit - this.head.length;
    this.head += text.slice(0, headRemaining);
    this.tail = (this.tail + text.slice(headRemaining)).slice(-this.tailLimit);
    this.truncated = this.chars > this.headLimit + this.tailLimit;
  }

  finish(): string {
    this.collect(this.decoder.end());
    return (
      this.head +
      (this.truncated ? `…[${this.chars - this.headLimit - this.tailLimit} chars truncated]…` : "") +
      this.tail
    );
  }

  preview(): string {
    return this.head + this.tail;
  }
}

function startFailure(error: unknown, cwd: string, executable: string): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return "Cannot start the shell. Permission denied.";
  if (code === "ENOENT" || code === "ENOTDIR") {
    try {
      if (!fs.statSync(cwd).isDirectory()) return "Working path is not a directory.";
    } catch (cwdError) {
      if ((cwdError as NodeJS.ErrnoException).code === "ENOENT") return "Working directory not found.";
      if ((cwdError as NodeJS.ErrnoException).code === "ENOTDIR") return "Working path is not a directory.";
      return "Cannot start the shell. Stop and ask user.";
    }
    if (code === "ENOENT") {
      const candidates = path.isAbsolute(executable)
        ? [executable]
        : (process.env.PATH ?? "").split(path.delimiter).map((entry) => path.join(entry, executable));
      if (!candidates.some((candidate) => fs.existsSync(candidate)))
        return "Shell is unavailable. Stop and ask user.";
    }
  }
  return "Cannot start the shell. Stop and ask user.";
}

const observedClosed = new WeakSet<ChildProcess>();

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (observedClosed.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = (): void => {
      observedClosed.add(child);
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", onClose);
  });
}

function runTaskkill(pid: number, timeoutMs: number): Promise<"ok" | "error" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      taskkill.kill();
      resolve("timeout");
    }, timeoutMs);
    taskkill.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("error");
    });
    taskkill.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? "ok" : "error");
    });
  });
}

const MSYS_SNAPSHOT_SCRIPT = `export MSYS2_ARG_CONV_EXCL='*'\ntable=$(awk -v self="$$" '\n  {\n    pid=FILENAME; sub(/^\\/proc\\//,"",pid); sub(/\\/ppid$/,"",pid)\n    if (pid == self) next\n    pp=$0\n    f=FILENAME; sub(/ppid$/,"winpid",f); w=""; if ((getline w < f) <= 0) next\n    f=FILENAME; sub(/ppid$/,"exename",f); e=""; getline e < f\n    gsub("\\\\\\\\","/",e); n=split(e,parts,"/"); e=parts[n]\n    print pid, pp, w, e\n  }' /proc/[0-9]*/ppid 2>/dev/null)\nroot=$(printf '%s\\n' "$table" | awk -v w="$1" '$3==w{print $1; exit}')\n[ -z "$root" ] && { echo "E root_not_found"; exit 0; }\necho "R $root"\ndesc=$root\nwhile :; do\n  added=$(printf '%s\\n' "$table" | awk -v d="$desc" 'BEGIN{n=split(d,a," "); for(i=1;i<=n;i++)s[a[i]]=1} s[$2] && !s[$1]{print $1}')\n  [ -z "$added" ] && break\n  desc="$desc $added"\ndone\nfor p in $desc; do\n  printf '%s\\n' "$table" | awk -v p="$p" '$1==p{printf "D %s %s %s\\n", $1, $3, $4; exit}'\ndone\n`;

const MSYS_ORPHAN_SCRIPT = `export MSYS2_ARG_CONV_EXCL='*'\nsnap() {\n  awk -v self="$$" '\n    {\n      pid=FILENAME; sub(/^\\/proc\\//,"",pid); sub(/\\/ppid$/,"",pid)\n      if (pid == self) next\n      pp=$0\n      f=FILENAME; sub(/ppid$/,"winpid",f); w=""; if ((getline w < f) <= 0) next\n      f=FILENAME; sub(/ppid$/,"exename",f); e=""; getline e < f\n      gsub("\\\\\\\\","/",e); n=split(e,parts,"/"); e=parts[n]\n      print pid, pp, w, e\n    }' /proc/[0-9]*/ppid 2>/dev/null\n}\ntable=$(snap)\nseeds=""\nverified=""\nfor t in "$@"; do\n  p=\${t%%:*}; rest=\${t#*:}; w=\${rest%%:*}; img=\${rest#*:}\n  line=$(printf '%s\\n' "$table" | awk -v p="$p" '$1==p{print; exit}')\n  cw=$(printf '%s' "$line" | awk '{print $3}')\n  ce=$(printf '%s' "$line" | awk '{print $4}')\n  if [ "$cw" = "$w" ] && [ "$ce" = "$img" ]; then\n    seeds="$seeds $p"\n    verified="$verified $p:$w"\n  else\n    echo "V $p mismatch"\n  fi\ndone\n[ -z "$seeds" ] && { echo "E verify_none"; exit 0; }\ndesc=$seeds\nwhile :; do\n  added=$(printf '%s\\n' "$table" | awk -v d="$desc" 'BEGIN{n=split(d,a," "); for(i=1;i<=n;i++)s[a[i]]=1} s[$2] && !s[$1]{print $1}')\n  [ -z "$added" ] && break\n  desc="$desc $added"\ndone\nkilled=0\nfailed=0\nfor p in $desc; do\n  w=$(printf '%s\\n' "$table" | awk -v p="$p" '$1==p{print $3; exit}')\n  [ -z "$w" ] && continue\n  taskkill /PID "$w" /T /F >/dev/null 2>&1\n  rc=$?\n  echo "K $w $rc"\n  if [ "$rc" = 0 ]; then killed=$((killed+1)); elif [ "$rc" != 128 ]; then failed=$((failed+1)); fi\ndone\nkill -9 $desc 2>/dev/null\ntable=$(snap)\nalive=0\nfor v in $verified; do\n  p=\${v%%:*}; w=\${v#*:}\n  cw=$(printf '%s\\n' "$table" | awk -v p="$p" '$1==p{print $3; exit}')\n  if [ "$cw" = "$w" ]; then\n    echo "A $p alive"\n    alive=$((alive+1))\n  fi\ndone\necho "S $killed $failed $alive"\n`;

interface SweepOptions {
  shellExecutable?: string;
  onDiagnostic?: (event: ToolDiagnostic) => void;
  sweepTimeoutMs?: number;
}

function emitKillDiagnostic(
  sink: ((event: ToolDiagnostic) => void) | undefined,
  stage: string,
  code: string,
): void {
  try {
    sink?.({ stage, code });
  } catch {
    // Diagnostic delivery must not replace the tool result.
  }
}

// bin/bash.exe 是原生启动器，不在 MSYS2 /proc；re-exec 的 usr/bin/bash 才是 cygwin 树根。
function findReexecBashWinpid(rootWinpid: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootWinpid}" | Select-Object ProcessId,Name | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      resolve(null);
      return;
    }
    let output = "";
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => done(null));
    child.once("close", (code) => {
      if (code !== 0) {
        done(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const bash = rows.find(
          (row) =>
            typeof (row as { Name?: unknown })?.Name === "string" &&
            /bash/i.test((row as { Name: string }).Name),
        );
        done(bash ? String((bash as { ProcessId: unknown }).ProcessId) : null);
      } catch {
        done(null);
      }
    });
  });
}

function runSweepScript(
  script: string,
  args: string[],
  options: SweepOptions,
): Promise<{ outcome: "ok" | "spawn_error" | "timeout"; output: string }> {
  return new Promise((resolve) => {
    const executable = options.shellExecutable ?? detectShell("win32").executable;
    let child: ChildProcess;
    try {
      child = spawn(executable, ["-s", ...args], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" },
      });
    } catch {
      resolve({ outcome: "spawn_error", output: "" });
      return;
    }
    const collector = new CappedCollector(SHELL_SWEEP_OUTPUT_MAX_CHARS, 0);
    let settled = false;
    const finish = (outcome: "ok" | "spawn_error" | "timeout"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome, output: collector.finish() });
    };
    const budget = options.sweepTimeoutMs ?? SHELL_SWEEP_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (child.pid !== undefined) void runTaskkill(child.pid, budget);
      finish("timeout");
    }, budget);
    child.stdout?.on("data", (chunk: Buffer) => collector.append(chunk));
    child.once("error", () => finish("spawn_error"));
    // 脚本协议用输出行表达结果，退出码不参与判定。
    child.once("close", () => finish("ok"));
    child.stdin?.on("error", () => {});
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

async function snapshotMsysTree(
  rootWinpid: number,
  options: SweepOptions,
): Promise<{ snapshot: MsysSweepSnapshot | null; reason: string }> {
  const budget = options.sweepTimeoutMs ?? SHELL_SWEEP_TIMEOUT_MS;
  const reexecWinpid = await findReexecBashWinpid(rootWinpid, budget);
  if (reexecWinpid === null) return { snapshot: null, reason: "cim_unavailable" };
  const run = await runSweepScript(MSYS_SNAPSHOT_SCRIPT, [reexecWinpid], options);
  if (run.outcome !== "ok") return { snapshot: null, reason: run.outcome };
  let rootCygwinPid: string | null = null;
  const descendants: MsysSweepDescendant[] = [];
  for (const line of run.output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "R" && parts.length === 2) rootCygwinPid = parts[1]!;
    else if (parts[0] === "D" && parts.length === 4)
      descendants.push({ cygwinPid: parts[1]!, winpid: parts[2]!, imageName: parts[3]! });
    else if (parts[0] === "E") return { snapshot: null, reason: parts[1] ?? "error" };
  }
  if (rootCygwinPid === null) return { snapshot: null, reason: "root_not_found" };
  const root = rootCygwinPid;
  return {
    snapshot: { rootCygwinPid: root, descendants: descendants.filter((d) => d.cygwinPid !== root) },
    reason: "ok",
  };
}

async function sweepMsysOrphans(snapshot: MsysSweepSnapshot, options: SweepOptions): Promise<string> {
  const triples = snapshot.descendants.map((d) => `${d.cygwinPid}:${d.winpid}:${d.imageName}`);
  if (triples.length === 0) return "verify_none";
  const run = await runSweepScript(MSYS_ORPHAN_SCRIPT, triples, options);
  if (run.outcome !== "ok") return run.outcome;
  let failed = 0;
  let alive = 0;
  let sawSummary = false;
  let verifyNone = false;
  for (const line of run.output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "S" && parts.length === 4) {
      sawSummary = true;
      failed = Number(parts[2]) || 0;
      alive = Number(parts[3]) || 0;
    } else if (parts[0] === "E" && parts[1] === "verify_none") verifyNone = true;
  }
  if (verifyNone) return "verify_none";
  if (!sawSummary || failed > 0 || alive > 0) return "partial";
  return "ok";
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: Parameters<TerminateProcessTree>[1],
): Promise<KillOutcome> {
  const pid = child.pid;
  if (pid === undefined) return "failed";
  if (options.platform === "win32") {
    // An exited parent's PID may already belong to another process.
    if (child.exitCode !== null || child.signalCode !== null || observedClosed.has(child))
      return "unconfirmed";
    const { snapshot, reason } = await snapshotMsysTree(pid, options);
    emitKillDiagnostic(options.onDiagnostic, "bash.terminate.snapshot", reason);
    if (snapshot !== null) options.onSnapshot?.(snapshot);
    const closing = waitForClose(child, options.confirmTimeoutMs);
    const taskkillResult = await runTaskkill(pid, options.confirmTimeoutMs);
    emitKillDiagnostic(options.onDiagnostic, "bash.terminate.taskkill", taskkillResult);
    const closed = await closing;
    emitKillDiagnostic(options.onDiagnostic, "bash.terminate.close", closed ? "observed" : "timeout");
    if (taskkillResult === "ok" && closed) return "terminated";
    if (snapshot !== null) {
      const sweep = await sweepMsysOrphans(snapshot, options);
      emitKillDiagnostic(options.onDiagnostic, "bash.terminate.sweep", sweep);
      const closedAfterSweep = await waitForClose(child, options.confirmTimeoutMs);
      emitKillDiagnostic(
        options.onDiagnostic,
        "bash.terminate.sweep.close",
        closedAfterSweep ? "observed" : "timeout",
      );
      if (closedAfterSweep) return "terminated";
    }
    return taskkillResult === "error" ? "failed" : "unconfirmed";
  }

  const closing = waitForClose(child, options.confirmTimeoutMs);
  let killFailed = false;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    killFailed = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  const closed = await closing;
  if (killFailed) return "failed";
  if (!closed) return "unconfirmed";
  try {
    process.kill(-pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "unconfirmed";
  }
  return "unconfirmed";
}

export async function runShellCommand(command: string, options: ShellRunOptions): Promise<ShellRunResult> {
  const platform = options.platform ?? process.platform;
  const terminateTree = options.terminateTree ?? terminateProcessTree;
  const confirmTimeoutMs = options.killConfirmTimeoutMs ?? SHELL_KILL_CONFIRM_TIMEOUT_MS;
  const stdout = new CappedCollector(
    SHELL_STDOUT_HEAD_CHARS,
    SHELL_STDOUT_MAX_CHARS - SHELL_STDOUT_HEAD_CHARS,
  );
  const stderr = new CappedCollector(
    SHELL_STDERR_HEAD_CHARS,
    SHELL_STDERR_MAX_CHARS - SHELL_STDERR_HEAD_CHARS,
  );
  if (options.signal?.aborted)
    return { status: "cancelled", started: false, exitCode: null, stdout: "", stderr: "", truncated: false };
  let args: string[];
  try {
    args = options.shell.argumentsFor(command);
  } catch (error) {
    reportToolDiagnostic(options.onDiagnostic, "bash.arguments", error);
    return {
      status: "internal_error",
      started: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
    };
  }
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(options.shell.executable, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      detached: platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    reportToolDiagnostic(options.onDiagnostic, "bash.spawn", error);
    return {
      status: "spawn_failed",
      started: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      errorReason: startFailure(error, options.cwd, options.shell.executable),
    };
  }
  let signal: string | undefined;
  let exitCode: number | null = null;
  let errorReason: string | undefined;
  let wake: (reason: ShellRunResult["status"]) => void;
  const event = new Promise<ShellRunResult["status"]>((resolve) => {
    wake = resolve;
  });
  const onAbort = (): void => wake("cancelled");
  const onClose = (code: number | null, receivedSignal: NodeJS.Signals | null): void => {
    observedClosed.add(child);
    exitCode = code;
    signal = receivedSignal ?? undefined;
    wake("exited");
  };
  child.once("close", onClose);
  const onProcessError = (error: Error): void => {
    reportToolDiagnostic(options.onDiagnostic, "bash.process", error);
    errorReason = startFailure(error, options.cwd, options.shell.executable);
    wake(child.pid === undefined ? "spawn_failed" : "internal_error");
  };
  child.once("error", onProcessError);
  const onOutput = options.onOutput;
  const live = onOutput ? new CappedCollector(0, SHELL_LIVE_OUTPUT_MAX_CHARS) : undefined;
  const onStdout = (chunk: Buffer): void => {
    stdout.append(chunk);
    live?.append(chunk);
  };
  const onStderr = (chunk: Buffer): void => {
    stderr.append(chunk);
    live?.append(chunk);
  };
  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  const onStreamError = (error: Error): void => {
    reportToolDiagnostic(options.onDiagnostic, "bash.stream", error);
    wake("internal_error");
  };
  child.stdout?.on("error", onStreamError);
  child.stderr?.on("error", onStreamError);
  let outputTimer: NodeJS.Timeout | undefined;
  if (onOutput && live) {
    let lastSnapshot = "";
    outputTimer = setInterval(() => {
      const snapshot = live.preview();
      if (snapshot.length === 0 || snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      try {
        onOutput(snapshot);
      } catch {
        // Display delivery must not replace the tool result.
      }
    }, SHELL_LIVE_OUTPUT_INTERVAL_MS);
    outputTimer.unref();
  }
  const timer = setTimeout(() => wake("timeout"), options.timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let status = await event;
  clearTimeout(timer);
  if (outputTimer) clearInterval(outputTimer);
  options.signal?.removeEventListener("abort", onAbort);
  const release = (): void => {
    child.removeListener("close", onClose);
    child.removeListener("error", onProcessError);
    child.stdout?.removeListener("data", onStdout);
    child.stderr?.removeListener("data", onStderr);
    child.stdout?.removeListener("error", onStreamError);
    child.stderr?.removeListener("error", onStreamError);
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  let snapshot: MsysSweepSnapshot | undefined;
  const sweepOptions: SweepOptions = {
    shellExecutable: options.shell.executable,
    onDiagnostic: options.onDiagnostic,
    sweepTimeoutMs: options.sweepTimeoutMs,
  };
  const terminate = async (): Promise<KillOutcome> => {
    let result: KillOutcome;
    try {
      result = await terminateTree(child, {
        platform,
        confirmTimeoutMs,
        ...sweepOptions,
        onSnapshot: (captured) => {
          snapshot = captured;
        },
      });
    } catch (error) {
      reportToolDiagnostic(options.onDiagnostic, "bash.terminate", error);
      result = "failed";
    }
    const closed = await waitForClose(child, confirmTimeoutMs);
    const outcome = result === "terminated" && !closed ? "unconfirmed" : result;
    emitKillDiagnostic(options.onDiagnostic, "bash.terminate.result", outcome);
    return outcome;
  };
  let kill: KillOutcome | undefined;
  if (status === "cancelled" && (child.exitCode !== null || child.signalCode !== null)) {
    // 取消生效前进程已退出：按真实退出结果返回，不尝试终止
    status = "exited";
    exitCode = child.exitCode;
    signal = child.signalCode ?? undefined;
  } else if (status === "timeout" || status === "cancelled" || status === "internal_error") {
    kill = await terminate();
  }
  if (kill && kill !== "terminated" && options.onPendingShell) {
    let cleanupPromise: Promise<KillOutcome> | undefined;
    options.onPendingShell(() => {
      cleanupPromise ??= (async (): Promise<KillOutcome> => {
        try {
          if (observedClosed.has(child) || child.exitCode !== null || child.signalCode !== null) {
            if (snapshot !== undefined) {
              const sweep = await sweepMsysOrphans(snapshot, sweepOptions);
              emitKillDiagnostic(options.onDiagnostic, "bash.terminate.cleanup.orphan", sweep);
              return sweep === "ok" ? "terminated" : "unconfirmed";
            }
            emitKillDiagnostic(options.onDiagnostic, "bash.terminate.cleanup.orphan", "no_snapshot");
            return "unconfirmed";
          }
          const outcome = await terminate();
          emitKillDiagnostic(options.onDiagnostic, "bash.terminate.cleanup.alive", outcome);
          return outcome;
        } finally {
          release();
          child.unref?.();
        }
      })();
      return cleanupPromise;
    });
  } else release();
  return {
    status,
    started: child.pid !== undefined,
    exitCode,
    signal,
    kill,
    errorReason,
    stdout: stdout.finish(),
    stderr: stderr.finish(),
    truncated: stdout.truncated || stderr.truncated,
  };
}

function formatShellOutput(result: ShellRunResult): string {
  const stdout = result.stdout.length === 0 ? "(no output)" : result.stdout;
  const stderr = result.stderr.length === 0 ? "(no output)" : result.stderr;
  return `Stdout:\n${stdout}${stdout.endsWith("\n") ? "" : "\n"}Stderr:\n${stderr}`;
}

export function shellResultToOutcome(result: ShellRunResult, timeoutMs: number): ToolOutcome {
  const output = formatShellOutput(result);
  const failure = (message: string): ToolOutcome => ({
    status: "error",
    category: "shell",
    content: `Error: ${message}\n${output}`,
  });
  switch (result.status) {
    case "spawn_failed":
      return failure(result.errorReason ?? "Cannot start the shell. Stop and ask user.");
    case "exited":
      if (result.exitCode !== null)
        return { status: "success", content: `Exit code: ${result.exitCode}\n${output}` };
      return failure(
        result.signal
          ? `Command terminated by signal ${JSON.stringify(result.signal)
              .replace(/\u2028/g, "\\u2028")
              .replace(/\u2029/g, "\\u2029")}.`
          : "Command exited unexpectedly.",
      );
    case "cancelled":
      if (!result.started)
        return { status: "not_executed", category: "cancelled", content: "Error: Cancelled by user." };
      break;
    case "timeout":
    case "internal_error":
      if (!result.started) return failure("Internal error. Stop and ask user.");
      break;
  }
  const kill = result.kill ?? "unconfirmed";
  const category = result.status === "cancelled" ? "cancelled" : "shell";
  const termination: TerminationDetails = { trigger: result.status, kill };
  if (kill !== "terminated")
    return {
      status: "unknown",
      category,
      content: `Error: Process termination could not be confirmed; side effects are unknown.\n${output}`,
      termination,
    };
  if (result.status === "timeout")
    return {
      status: "timeout",
      category,
      content: `Error: Command timed out after ${timeoutMs / 1000}s; process termination confirmed.\n${output}`,
      termination,
    };
  return {
    ...failure(
      result.status === "internal_error"
        ? "Internal error. Stop and ask user."
        : "Cancelled by user; process termination confirmed.",
    ),
    category,
    termination,
  };
}
