import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSettings,
  loadSettings,
  collectSettingsWarnings,
  SettingsError,
} from "../../src/llm/settings-store.js";

const tmpDirs: string[] = [];

function tempSettingsPath(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-settings-test-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, "settings.json");
  if (content !== undefined) fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("settings-store", () => {
  it("缺失文件时返回默认值 maxRetries=10、logLevel=info、工具数值默认值", () => {
    const settings = loadSettings(tempSettingsPath());
    expect(settings).toEqual({
      maxRetries: 10,
      ctrlCExitWindowMs: 3000,
      decisionTimeoutMs: 30000,
      maxTurns: 200,
      diffFoldLines: 200,
      diffFoldChars: 10000,
      thinkingPreviewLines: 5,
      toolResultPreviewLines: 5,
      promptVisibleRows: 3,
      promptMaxRows: 5,
      runTimerRefreshMs: 1000,
      streamRefreshMs: 32,
      mouseScrollLines: 3,
      escapeTimeoutMs: 30,
      logLevel: "info",
      editMaxFileBytes: 16777216,
      globTimeoutMs: 30000,
      grepStderrMaxChars: 4000,
      compactionThresholdRatio: 0.8,
      compactionSummaryTargetTokens: 4096,
      compactionRetainedContextRatio: 0.2,
      compactionRetainedContextMaxTokens: 20000,
      compactionToolResultMaxChars: 4000,
      compactionMaxRetries: 2,
      tokenEstimate: { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5 },
    });
  });

  it("合法文件按内容加载", () => {
    const filePath = tempSettingsPath(
      JSON.stringify({
        maxRetries: 3,
        logLevel: "debug",
        editMaxFileBytes: 1024,
        globTimeoutMs: 5000,
        grepStderrMaxChars: 64,
      }),
    );
    expect(loadSettings(filePath)).toEqual({
      ctrlCExitWindowMs: 3000,
      decisionTimeoutMs: 30000,
      maxTurns: 200,
      diffFoldLines: 200,
      diffFoldChars: 10000,
      thinkingPreviewLines: 5,
      toolResultPreviewLines: 5,
      promptVisibleRows: 3,
      promptMaxRows: 5,
      runTimerRefreshMs: 1000,
      streamRefreshMs: 32,
      mouseScrollLines: 3,
      escapeTimeoutMs: 30,
      maxRetries: 3,
      logLevel: "debug",
      editMaxFileBytes: 1024,
      globTimeoutMs: 5000,
      grepStderrMaxChars: 64,
      compactionThresholdRatio: 0.8,
      compactionSummaryTargetTokens: 4096,
      compactionRetainedContextRatio: 0.2,
      compactionRetainedContextMaxTokens: 20000,
      compactionToolResultMaxChars: 4000,
      compactionMaxRetries: 2,
      tokenEstimate: { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5 },
    });
  });

  it("损坏 JSON 明确报错且不改动原文件", () => {
    const filePath = tempSettingsPath("{ not json");
    const before = fs.readFileSync(filePath, "utf8");
    expect(() => loadSettings(filePath)).toThrow(SettingsError);
    expect(() => loadSettings(filePath)).toThrow(/JSON 解析失败/);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("非法 maxRetries 报错", () => {
    for (const bad of [-1, 1.5, "3", null]) {
      const filePath = tempSettingsPath(JSON.stringify({ maxRetries: bad }));
      expect(() => loadSettings(filePath)).toThrow(SettingsError);
    }
  });

  it("非法 logLevel 报错", () => {
    const filePath = tempSettingsPath(JSON.stringify({ logLevel: "verbose" }));
    expect(() => loadSettings(filePath)).toThrow(/logLevel/);
  });

  it("旧 shellTimeoutMs 字段拒绝", () => {
    for (const bad of [-1, 0, 1.5, "30000", null]) {
      const filePath = tempSettingsPath(JSON.stringify({ shellTimeoutMs: bad }));
      expect(() => loadSettings(filePath)).toThrow(SettingsError);
    }
  });

  it("工具数值配置边界严格校验且不修改原文件", () => {
    for (const [key, minimum, maximum] of [
      ["editMaxFileBytes", 1, 16777216],
      ["globTimeoutMs", 1000, 120000],
      ["grepStderrMaxChars", 64, 65536],
      ["mouseScrollLines", 1, 100],
      ["escapeTimeoutMs", 1, 100],
    ] as const) {
      for (const value of [minimum, maximum]) {
        expect(loadSettings(tempSettingsPath(JSON.stringify({ [key]: value })))[key]).toBe(value);
      }
      for (const value of [minimum - 1, maximum + 1, 1.5, "4000", null]) {
        const text = JSON.stringify({ [key]: value });
        const file = tempSettingsPath(text);
        expect(() => loadSettings(file)).toThrow(SettingsError);
        expect(fs.readFileSync(file, "utf8")).toBe(text);
      }
    }
  });

  it("未知字段（含 version 与旧扁平估算字段）严格拒绝", () => {
    for (const bad of [
      { version: 1 },
      { compactionCjkCharsPerToken: 1.6 },
      { compactionOtherCharsPerToken: 4 },
      { tokenEstimate: { cjkCharsPerToken: 1.6, otherCharsPerToken: 4 } },
    ]) {
      const filePath = tempSettingsPath(JSON.stringify(bad));
      expect(() => loadSettings(filePath)).toThrow(SettingsError);
    }
  });
});

it("maxTurns accepts positive integers and rejects invalid values", () => {
  expect(loadSettings(tempSettingsPath('{"maxTurns":1}')).maxTurns).toBe(1);
  for (const value of [0, -1, 1.5, "40", null]) {
    expect(() => loadSettings(tempSettingsPath(JSON.stringify({ maxTurns: value })))).toThrow(SettingsError);
  }
});

it("accepts positive display limits and rejects invalid values", () => {
  for (const field of [
    "diffFoldLines",
    "diffFoldChars",
    "thinkingPreviewLines",
    "toolResultPreviewLines",
  ] as const) {
    expect(loadSettings(tempSettingsPath(JSON.stringify({ [field]: 1 })))[field]).toBe(1);
    for (const value of [0, -1, 1.5, null, "5"]) {
      expect(() => loadSettings(tempSettingsPath(JSON.stringify({ [field]: value })))).toThrow(SettingsError);
    }
  }
});

it("bounds Header refresh to integer 250?1000ms", () => {
  for (const runTimerRefreshMs of [250, 1000])
    expect(loadSettings(tempSettingsPath(JSON.stringify({ runTimerRefreshMs }))).runTimerRefreshMs).toBe(
      runTimerRefreshMs,
    );
  for (const runTimerRefreshMs of [249, 1001, 500.5])
    expect(() => loadSettings(tempSettingsPath(JSON.stringify({ runTimerRefreshMs })))).toThrow(
      SettingsError,
    );
});

it("bounds stream refresh to integer 16-200ms and defaults to 32", () => {
  expect(parseSettings({}).streamRefreshMs).toBe(32);
  for (const streamRefreshMs of [16, 32, 200])
    expect(parseSettings({ streamRefreshMs }).streamRefreshMs).toBe(streamRefreshMs);
  for (const streamRefreshMs of [15, 201, 32.5, "32", null])
    expect(() => parseSettings({ streamRefreshMs })).toThrow(SettingsError);
});

it("validates configurable prompt visible rows", () => {
  expect(parseSettings({}).promptVisibleRows).toBe(3);
  expect(parseSettings({ promptVisibleRows: 5 }).promptVisibleRows).toBe(5);
  for (const value of [0, -1, 1.5, "3", null])
    expect(() => parseSettings({ promptVisibleRows: value })).toThrow();
});

it("validates prompt max rows and its relation to promptVisibleRows", () => {
  expect(parseSettings({}).promptMaxRows).toBe(5);
  expect(parseSettings({ promptMaxRows: 7 }).promptMaxRows).toBe(7);
  expect(parseSettings({ promptVisibleRows: 4, promptMaxRows: 4 }).promptMaxRows).toBe(4);
  for (const value of [0, -1, 1.5, "5", null])
    expect(() => parseSettings({ promptMaxRows: value })).toThrow(SettingsError);
  expect(() => parseSettings({ promptMaxRows: 2 })).toThrow(SettingsError);
  expect(() => parseSettings({ promptVisibleRows: 6 })).toThrow(SettingsError);
  expect(() => parseSettings({ promptVisibleRows: 6, promptMaxRows: 5 })).toThrow(SettingsError);
});

describe("压缩配置", () => {
  it("七项压缩配置均可覆盖", () => {
    const settings = parseSettings({
      compactionThresholdRatio: 0.5,
      compactionSummaryTargetTokens: 512,
      compactionRetainedContextRatio: 0.3,
      compactionRetainedContextMaxTokens: 8000,
      compactionToolResultMaxChars: 1000,
      compactionMaxRetries: 0,
      tokenEstimate: { asciiCharsPerToken: 3, nonAsciiCharsPerToken: 2 },
    });
    expect(settings).toMatchObject({
      compactionThresholdRatio: 0.5,
      compactionSummaryTargetTokens: 512,
      compactionRetainedContextRatio: 0.3,
      compactionRetainedContextMaxTokens: 8000,
      compactionToolResultMaxChars: 1000,
      compactionMaxRetries: 0,
      tokenEstimate: { asciiCharsPerToken: 3, nonAsciiCharsPerToken: 2 },
    });
  });

  it("compactionThresholdRatio 必须是 0 < x <= 1 的有限数字", () => {
    for (const value of [0.1, 0.8, 1]) {
      expect(parseSettings({ compactionThresholdRatio: value }).compactionThresholdRatio).toBe(value);
    }
    for (const value of [0, -0.1, 1.01, NaN, Infinity, -Infinity, "0.8", null]) {
      expect(() => parseSettings({ compactionThresholdRatio: value })).toThrow(SettingsError);
    }
  });

  it("compactionRetainedContextRatio 必须是 0 < x <= 1 的有限数字", () => {
    for (const value of [0.1, 0.2, 1]) {
      expect(parseSettings({ compactionRetainedContextRatio: value }).compactionRetainedContextRatio).toBe(
        value,
      );
    }
    for (const value of [0, -0.1, 1.01, NaN, Infinity, -Infinity, "0.2", null]) {
      expect(() => parseSettings({ compactionRetainedContextRatio: value })).toThrow(SettingsError);
    }
  });

  it("compactionRetainedContextMaxTokens 必须是 >= 1000 的整数", () => {
    for (const value of [1000, 20000, 100000]) {
      expect(
        parseSettings({ compactionRetainedContextMaxTokens: value }).compactionRetainedContextMaxTokens,
      ).toBe(value);
    }
    for (const value of [999, 0, -1, 1000.5, NaN, Infinity, "20000", null]) {
      expect(() => parseSettings({ compactionRetainedContextMaxTokens: value })).toThrow(SettingsError);
    }
  });

  it("compactionSummaryTargetTokens 与 compactionToolResultMaxChars 必须是正整数", () => {
    for (const field of ["compactionSummaryTargetTokens", "compactionToolResultMaxChars"] as const) {
      expect(parseSettings({ [field]: 1 })[field]).toBe(1);
      for (const value of [0, -1, 1.5, NaN, Infinity, "2000", null]) {
        expect(() => parseSettings({ [field]: value })).toThrow(SettingsError);
      }
    }
  });

  it("compactionMaxRetries 必须是非负整数", () => {
    expect(parseSettings({ compactionMaxRetries: 0 }).compactionMaxRetries).toBe(0);
    expect(parseSettings({ compactionMaxRetries: 5 }).compactionMaxRetries).toBe(5);
    for (const value of [-1, 1.5, NaN, Infinity, "2", null]) {
      expect(() => parseSettings({ compactionMaxRetries: value })).toThrow(SettingsError);
    }
  });

  it("tokenEstimate 缺字段、非有限正数或未知字段均拒绝", () => {
    for (const value of [
      { asciiCharsPerToken: 4 },
      { nonAsciiCharsPerToken: 1.5 },
      { asciiCharsPerToken: 0, nonAsciiCharsPerToken: 1.5 },
      { asciiCharsPerToken: -1, nonAsciiCharsPerToken: 1.5 },
      { asciiCharsPerToken: NaN, nonAsciiCharsPerToken: 1.5 },
      { asciiCharsPerToken: 4, nonAsciiCharsPerToken: Infinity },
      { asciiCharsPerToken: "4", nonAsciiCharsPerToken: 1.5 },
      { asciiCharsPerToken: 4, nonAsciiCharsPerToken: 1.5, extra: 1 },
      null,
    ]) {
      expect(() => parseSettings({ tokenEstimate: value })).toThrow(SettingsError);
    }
  });

  it("CONTEXT_SAFETY_MARGIN_TOKENS 不是 settings 字段", () => {
    expect(() => parseSettings({ CONTEXT_SAFETY_MARGIN_TOKENS: 2048 })).toThrow(SettingsError);
  });

  it("collectSettingsWarnings：retainedContextRatio >= thresholdRatio 时告警但仍加载", () => {
    const warn = parseSettings({ compactionRetainedContextRatio: 0.9 });
    expect(warn.compactionRetainedContextRatio).toBe(0.9);
    const warnings = collectSettingsWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/compactionRetainedContextRatio/);
  });

  it("collectSettingsWarnings：默认配置（0.2 < 0.8）无告警", () => {
    expect(collectSettingsWarnings(parseSettings({}))).toEqual([]);
  });
});

it("decision timeout accepts only safe positive timer integers", () => {
  expect(parseSettings({}).decisionTimeoutMs).toBe(30000);
  for (const value of [1, 2147483647])
    expect(parseSettings({ decisionTimeoutMs: value }).decisionTimeoutMs).toBe(value);
  for (const value of [0, -1, 1.5, 2147483648, "30000", null])
    expect(() => parseSettings({ decisionTimeoutMs: value })).toThrow(/decisionTimeoutMs/);
});

it("validates the Ctrl+C exit window", () => {
  expect(parseSettings({}).ctrlCExitWindowMs).toBe(3000);
  for (const value of [1, 2147483647]) expect(parseSettings({ctrlCExitWindowMs:value}).ctrlCExitWindowMs).toBe(value);
  for (const value of [0, -1, 1.5, 2147483648, "3000", null]) expect(() => parseSettings({ctrlCExitWindowMs:value})).toThrow();
});
