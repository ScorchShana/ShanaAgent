import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnostics } from "../src/diagnostics.js";

const tmpDirs: string[] = [];

function makeLogsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-diag-test-"));
  tmpDirs.push(dir);
  return dir;
}

function readLog(logsDir: string): string {
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith(".log"));
  return files.map((f) => fs.readFileSync(path.join(logsDir, f), "utf8")).join("\n");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("diagnostics", () => {
  it("级别过滤生效：min=info 时 debug 不落盘", () => {
    const logsDir = makeLogsDir();
    const diag = createDiagnostics({ logsDir, minLevel: "info", redact: (t) => t });
    diag.debug("hidden debug");
    diag.info("visible info");
    const content = readLog(logsDir);
    expect(content).toContain("visible info");
    expect(content).not.toContain("hidden debug");
  });

  it("输出前经脱敏：完整 Key 与回显片段都被掩码", () => {
    const logsDir = makeLogsDir();
    const key = "sk-diag-secret-0000tail9z";
    const diag = createDiagnostics({ logsDir, minLevel: "debug", redact: (t) => t.split(key).join("[REDACTED]").split("il9z").join("[REDACTED]") });
    diag.error(`request failed with key ${key}; provider said: ...il9z`);
    const content = readLog(logsDir);
    expect(content).not.toContain(key);
    expect(content).not.toContain("il9z");
    expect(content).toContain("[REDACTED]");
  });

  it("日志只写入 logsDir", () => {
    const logsDir = makeLogsDir();
    const diag = createDiagnostics({ logsDir, minLevel: "debug", redact: (t) => t });
    diag.info("hello");
    expect(fs.readdirSync(logsDir).filter((f) => f.startsWith("shana-"))).toHaveLength(1);
  });
});
