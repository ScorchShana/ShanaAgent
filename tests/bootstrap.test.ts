import { loadPrompts } from "../src/tools/prompts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "../src/bootstrap.js";

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-boot-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bootstrap", () => {
  it("首次启动创建 ~/.shana 结构且重复启动幂等", () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const first = bootstrap({ homeDir: home, cwd });
    expect(first.shanaDir).toBe(path.join(home, ".shana"));
    expect(fs.existsSync(path.join(home, ".shana", "logs"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".shana", "sessions"))).toBe(true);
    const second = bootstrap({ homeDir: home, cwd });
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(second.settings).toEqual(first.settings);
  });

  it("POSIX 目录权限 0700", () => {
    if (process.platform === "win32") return;
    const home = makeTempDir();
    bootstrap({ homeDir: home, cwd: makeTempDir() });
    const mode = fs.statSync(path.join(home, ".shana")).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("缺少 model.json 正常启动并给出提示", () => {
    const home = makeTempDir();
    const result = bootstrap({ homeDir: home, cwd: makeTempDir() });
    expect(result.modelConfig.status).toBe("empty");
    if (result.modelConfig.status === "empty") {
      expect(result.modelConfig.message).toContain("model.json");
    }
    expect(fs.existsSync(path.join(home, ".shana", "model.json"))).toBe(false);
  });

  it("settings.json 损坏时明确报错且不覆盖", () => {
    const home = makeTempDir();
    const settingsPath = path.join(home, ".shana", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ broken");
    expect(() => bootstrap({ homeDir: home, cwd: makeTempDir() })).toThrow(/settings\.json/);
    expect(fs.readFileSync(settingsPath, "utf8")).toBe("{ broken");
  });

  it("两个并发 bootstrap 同工作区互不阻塞", async () => {
    const home = makeTempDir();
    const cwd = makeTempDir();
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => bootstrap({ homeDir: home, cwd })),
      Promise.resolve().then(() => bootstrap({ homeDir: home, cwd })),
    ]);
    expect(a.workspace.id).toBe(b.workspace.id);
    expect(fs.readdirSync(path.join(home, ".shana")).filter((f) => f.endsWith(".lock"))).toHaveLength(0);
  });

  it("诊断日志写入 logs/ 且 Key 不落盘", () => {
    const home = makeTempDir();
    const key = "sk-boot-secret-9876543210qwx";
    fs.writeFileSync(
      path.join(home, ".shana-model.json"),
      JSON.stringify({
        providers: {
          p: {
            api: "openai-completions",
            baseUrl: "https://x",
            apiKey: key,
            models: [{ id: "m", contextWindow: 1, maxTokens: 1 }],
          },
        },
      }),
    );
    fs.mkdirSync(path.join(home, ".shana"), { recursive: true });
    fs.renameSync(path.join(home, ".shana-model.json"), path.join(home, ".shana", "model.json"));
    const result = bootstrap({ homeDir: home, cwd: makeTempDir() });
    result.diagnostics.error(`simulated provider echo of key tail ...10qwx and full ${key}`);
    const logs = fs.readdirSync(result.logsDir).filter((f) => f.endsWith(".log"));
    const content = logs.map((f) => fs.readFileSync(path.join(result.logsDir, f), "utf8")).join("\n");
    expect(content).not.toContain(key);
    expect(content).not.toContain("10qwx");
  });
});

describe("启动提示词", () => {
  it("启动结果带有系统提示词及六工具的实际声明", () => {
    const result = bootstrap({ homeDir: makeTempDir(), cwd: makeTempDir() });
    expect(result.prompts.system).toContain("<agent>");
    expect(result.prompts.system).toContain("<core_rules>");
    expect(result.toolRegistry.names()).toEqual(["read", "glob", "grep", "write", "edit", "bash"]);
    expect(result.toolRegistry.get("bash")?.parameters.properties.timeout).toMatchObject({
      default: 120,
      minimum: 1,
      maximum: 1200,
    });
    expect(result.toolRegistry.get("edit")?.description).toContain("CRLF and standalone CR");
  });

  it("任一提示词为空或编码损坏时拒载", () => {
    for (const content of [Buffer.from(" "), Buffer.from([0xc3, 0x28]), Buffer.from("a\0b")]) {
      const read = vi.spyOn(fs, "readFileSync").mockReturnValueOnce(content);
      try {
        expect(() => loadPrompts()).toThrow();
      } finally {
        read.mockRestore();
      }
    }
  });

  it("工具Description缺失时拒载", () => {
    const read = vi.spyOn(fs, "readFileSync");
    read.mockImplementationOnce(() => Buffer.from("valid system prompt"));
    read.mockImplementationOnce(() => {
      throw Object.assign(new Error("missing prompt"), { code: "ENOENT" });
    });
    try {
      expect(() => loadPrompts()).toThrow("missing prompt");
    } finally {
      read.mockRestore();
    }
  });
});

it("loads decision configuration at startup and redacts its key", () => {
  const home = makeTempDir();
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(home, ".shana"));
  const target = path.join(home, ".shana", "decision-model.json");
  fs.writeFileSync(
    target,
    JSON.stringify({ base_url: "http://localhost:8081", apiKey: "decision-secret-12345678" }),
  );
  const result = bootstrap({ homeDir: home, cwd });
  expect(result.decisionConfig.status).toBe("ok");
  expect(result.decisionPrompt.status).toBe("ok");
  fs.writeFileSync(target, "{}");
  expect(result.decisionConfig.status).toBe("ok");
  result.diagnostics.error("decision-secret-12345678");
  const text = fs
    .readdirSync(result.logsDir)
    .map((name) => fs.readFileSync(path.join(result.logsDir, name), "utf8"))
    .join("");
  expect(text).not.toContain("decision-secret-12345678");
  expect(text).not.toContain("5678");
});

it("decision prompt failures are isolated and controlled", async () => {
  const { loadDecisionPrompt } = await import("../src/tools/prompts.js");
  expect(loadDecisionPrompt().status).toBe("ok");
  for (const content of [Buffer.from(" "), Buffer.from([0xc3, 0x28]), Buffer.from("a\0b")]) {
    const read = vi.spyOn(fs, "readFileSync").mockReturnValueOnce(content);
    try {
      expect(loadDecisionPrompt()).toEqual({ status: "invalid", message: expect.any(String) });
    } finally {
      read.mockRestore();
    }
  }
  const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
    throw new Error("sensitive");
  });
  try {
    expect(loadDecisionPrompt()).toEqual({
      status: "invalid",
      message: expect.not.stringContaining("sensitive"),
    });
  } finally {
    read.mockRestore();
  }
});
