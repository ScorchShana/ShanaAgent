import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
  ToolExecutor,
  type ToolCallRequest,
  type ToolExecutorOptions,
  type ToolPermissionDecision,
  type ToolPermissionGate,
  type ToolPermissionRequest,
} from "../../src/tools/executor.js";
import type { KillOutcome, SpawnProcess, TerminateProcessTree } from "../../src/tools/shell.js";

const tmpDirs: string[] = [];

export function tempDir(prefix = "shana-tools-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function makeWorkspace(): string {
  return tempDir("shana-ws-");
}

export function writeFileAt(root: string, relative: string, content: string | Buffer): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

export function readFileAt(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

export function makeExecutor(
  workspaceRoot: string,
  options: Partial<ToolExecutorOptions> = {},
): ToolExecutor {
  return new ToolExecutor({ workspaceRoot, ...options });
}

export function call(id: string, name: string, args: Record<string, unknown>): ToolCallRequest {
  return {
    type: "toolCall",
    id,
    name,
    rawArguments: JSON.stringify(args),
    parse: { status: "parsed", arguments: args as JsonObject },
  };
}

export interface RecordingGate {
  gate: ToolPermissionGate;
  requests: ToolPermissionRequest[];
}

export function gateDecision(short: "allow" | "deny"): ToolPermissionDecision {
  return short === "allow" ? { decision: "allow" } : { decision: "deny", reason: "denied_by_user" };
}

export function recordingGate(decision: "allow" | "deny" = "allow"): RecordingGate {
  const requests: ToolPermissionRequest[] = [];
  const gate: ToolPermissionGate = async (request) => {
    requests.push(request);
    return gateDecision(decision);
  };
  return { gate, requests };
}

export function createDirLink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export function supportsDirectoryLinks(): boolean {
  const base = tempDir("shana-link-probe-");
  const target = path.join(base, "target");
  fs.mkdirSync(target);
  try {
    createDirLink(target, path.join(base, "link"));
    return true;
  } catch {
    return false;
  }
}

export function supportsFileSymlinks(): boolean {
  const base = tempDir("shana-file-link-probe-");
  const target = path.join(base, "target.txt");
  fs.writeFileSync(target, "x");
  try {
    fs.symlinkSync(target, path.join(base, "link.txt"), "file");
    return true;
  } catch {
    return false;
  }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
}

export function fakeChild(options: { stdout?: string; stderr?: string; pid?: number } = {}): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild;
  Object.assign(child, {
    pid: options.pid ?? 4321,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  if (options.stdout !== undefined) child.stdout.write(options.stdout);
  if (options.stderr !== undefined) child.stderr.write(options.stderr);
  return child;
}

export type KillBehavior = KillOutcome | "throw";

export interface FakeShellRun {
  child: FakeChild;
  spawnProcess: SpawnProcess;
  terminateTree: TerminateProcessTree;
  spawnCalls: Array<{ executable: string; args: readonly string[] }>;
  terminationCalls: Array<{ platform: NodeJS.Platform; confirmTimeoutMs: number }>;
}

export function fakeShellRun(
  options: { stdout?: string; stderr?: string; kill?: KillBehavior } = {},
): FakeShellRun {
  const child = fakeChild(options);
  const spawnCalls: FakeShellRun["spawnCalls"] = [];
  const terminationCalls: FakeShellRun["terminationCalls"] = [];
  const spawnProcess = ((executable: string, args: string[]) => {
    spawnCalls.push({ executable, args });
    return child;
  }) as unknown as SpawnProcess;
  const terminateTree: TerminateProcessTree = async (_child, opts) => {
    terminationCalls.push(opts);
    const behavior = options.kill ?? "terminated";
    if (behavior === "throw") throw new Error("injected termination failure");
    if (behavior === "terminated") child.emit("close", null);
    return behavior;
  };
  return { child, spawnProcess, terminateTree, spawnCalls, terminationCalls };
}
