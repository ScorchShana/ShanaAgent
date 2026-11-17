import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadModelConfig,
  ModelConfigError,
  redactSecrets,
  toPiAiModel,
  writeCurrentModel,
  writeReasoningEffort,
  type LoadedModelConfig,
} from "../../src/llm/model-config-store.js";

const tmpDirs: string[] = [];

const VALID_CONFIG = {
  current: { provider: "flash", model: "flash-a" },
  providers: {
    flash: {
      name: "Flash Provider",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-abcdef1234567890robe",
      models: [
        {
          id: "flash-a",
          name: "Flash A",
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
          samplingParams: { temperature: 0.7, top_p: 0.95 },
          compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false },
          cost: { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.1 },
        },
        { id: "flash-b", contextWindow: 128000, maxTokens: 8192 },
      ],
    },
  },
};

function tempConfigPath(content?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shana-model-test-"));
  tmpDirs.push(dir);
  const filePath = path.join(dir, "model.json");
  if (content !== undefined) {
    fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return filePath;
}

function loadOk(filePath: string): Extract<LoadedModelConfig, { status: "ok" }> {
  const loaded = loadModelConfig(filePath);
  if (loaded.status !== "ok") throw new Error(`expected ok, got ${loaded.status}`);
  return loaded;
}

function expectConfigErrorUnchanged(filePath: string, mutate: (raw: unknown) => unknown): void {
  const original = JSON.stringify(mutate(structuredClone(VALID_CONFIG)), null, 2);
  fs.writeFileSync(filePath, original);
  expect(() => loadModelConfig(filePath)).toThrow(ModelConfigError);
  expect(fs.readFileSync(filePath, "utf8")).toBe(original);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("model-config-store 校验", () => {
  it("合法配置示例通过", () => {
    const loaded = loadOk(tempConfigPath(VALID_CONFIG));
    expect(loaded.current.id).toBe("flash-a");
    expect(loaded.models).toHaveLength(2);
  });

  it("缺 contextWindow 报错且不改动原文件", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      delete (raw as typeof VALID_CONFIG).providers.flash.models[0].contextWindow;
      return raw;
    });
  });

  it("未知 api 报错", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      (raw as typeof VALID_CONFIG).providers.flash.api = "anthropic-messages";
      return raw;
    });
  });

  it("非法 reasoningEffort 报错", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      (raw as typeof VALID_CONFIG).providers.flash.models[0].reasoningEffort = "ultra";
      return raw;
    });
  });

  it("current 不可解析报错", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      (raw as typeof VALID_CONFIG).current = { provider: "flash", model: "nope" };
      return raw;
    });
  });

  it("reasoning: true 缺 compat 拒绝加载", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      const model = (raw as typeof VALID_CONFIG).providers.flash.models[0];
      delete model.compat;
      delete (model as Record<string, unknown>).reasoningEffort;
      return raw;
    });
  });

  it("损坏 JSON 报错且不改动原文件", () => {
    const filePath = tempConfigPath("{ oops");
    const before = fs.readFileSync(filePath, "utf8");
    expect(() => loadModelConfig(filePath)).toThrow(/JSON 解析失败/);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("cost 缺项报错", () => {
    const filePath = tempConfigPath();
    expectConfigErrorUnchanged(filePath, (raw) => {
      delete (raw as typeof VALID_CONFIG).providers.flash.models[0].cost?.cacheWrite;
      return raw;
    });
  });

  it("apiKeyEnv 与 $VAR 一律按配置错误处理", () => {
    const withEnv = tempConfigPath();
    expectConfigErrorUnchanged(withEnv, (raw) => {
      const provider = (raw as Record<string, unknown>).providers as Record<string, unknown>;
      provider.flash = { ...(provider.flash as object), apiKeyEnv: "MY_KEY" } as never;
      return raw;
    });
    const withVar = tempConfigPath();
    expectConfigErrorUnchanged(withVar, (raw) => {
      (raw as typeof VALID_CONFIG).providers.flash.apiKey = "$MY_KEY";
      return raw;
    });
  });
});

describe("model-config-store 默认值与解析", () => {
  it("缺省字段按规范补齐，compat/samplingParams 原样透传", () => {
    const loaded = loadOk(tempConfigPath(VALID_CONFIG));
    const b = loaded.models.find((m) => m.id === "flash-b");
    expect(b).toMatchObject({
      name: "flash-b",
      reasoning: false,
      thinking: true,
      reasoningEffort: "high",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUnknown: true,
    });
    const a = loaded.models.find((m) => m.id === "flash-a");
    expect(a?.costUnknown).toBe(false);
    expect(a?.compat).toEqual({ thinkingFormat: "deepseek", supportsDeveloperRole: false });
    expect(a?.samplingParams).toEqual({ temperature: 0.7, top_p: 0.95 });
  });

  it("current 缺失时取第一个 Provider 的第一个模型", () => {
    const withoutCurrent = structuredClone(VALID_CONFIG) as Record<string, unknown>;
    delete withoutCurrent.current;
    const loaded = loadOk(tempConfigPath(withoutCurrent));
    expect(loaded.current.id).toBe("flash-a");
    expect(loaded.current.providerId).toBe("flash");
  });

  it("缺失文件返回 empty 状态", () => {
    const loaded = loadModelConfig(path.join(tmpDirs[0] ?? os.tmpdir(), "missing", "model.json"));
    expect(loaded.status).toBe("empty");
  });

  it("toPiAiModel 映射为 pi-ai Model 形状", () => {
    const loaded = loadOk(tempConfigPath(VALID_CONFIG));
    const piModel = toPiAiModel(loaded.current);
    expect(piModel).toMatchObject({
      id: "flash-a",
      api: "openai-completions",
      provider: "flash",
      baseUrl: "https://api.example.com/v1",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });
});

describe("toPiAiModel supportsDeveloperRole 默认值", () => {
  function loadWithCompat(compat: unknown, reasoning = true) {
    const raw = structuredClone(VALID_CONFIG) as Record<string, unknown>;
    const providers = raw.providers as Record<string, Record<string, unknown>>;
    const models = providers.flash.models as Record<string, unknown>[];
    models[0].reasoning = reasoning;
    if (compat === undefined) delete models[0].compat;
    else models[0].compat = compat;
    return loadOk(tempConfigPath(raw)).current;
  }

  it("缺省时补默认 false，不影响 compat 其他字段", () => {
    const piModel = toPiAiModel(loadWithCompat({ thinkingFormat: "qwen" }));
    expect(piModel.compat?.supportsDeveloperRole).toBe(false);
    expect(piModel.compat?.thinkingFormat).toBe("qwen");
  });

  it("显式 true 优先于默认", () => {
    const piModel = toPiAiModel(loadWithCompat({ thinkingFormat: "openai", supportsDeveloperRole: true }));
    expect(piModel.compat?.supportsDeveloperRole).toBe(true);
  });

  it("显式 false 保留", () => {
    const piModel = toPiAiModel(loadWithCompat({ thinkingFormat: "deepseek", supportsDeveloperRole: false }));
    expect(piModel.compat?.supportsDeveloperRole).toBe(false);
  });

  it("非 reasoning 模型无 compat 也补默认", () => {
    const piModel = toPiAiModel(loadWithCompat(undefined, false));
    expect(piModel.reasoning).toBe(false);
    expect(piModel.compat).toEqual({ supportsDeveloperRole: false });
  });
});

describe("model-config-store 原子写回", () => {
  it("writeCurrentModel 校验后更新 current", () => {
    const filePath = tempConfigPath(VALID_CONFIG);
    writeCurrentModel(filePath, "flash", "flash-b");
    const written = JSON.parse(fs.readFileSync(filePath, "utf8")) as typeof VALID_CONFIG;
    expect(written.current).toEqual({ provider: "flash", model: "flash-b" });
    const loaded = loadOk(filePath);
    expect(loaded.current.id).toBe("flash-b");
  });

  it("writeCurrentModel 未知模型报错且文件不变", () => {
    const filePath = tempConfigPath(VALID_CONFIG);
    const before = fs.readFileSync(filePath, "utf8");
    expect(() => writeCurrentModel(filePath, "flash", "ghost")).toThrow(ModelConfigError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("writeReasoningEffort 更新指定模型且其他模型不受影响", () => {
    const filePath = tempConfigPath(VALID_CONFIG);
    writeReasoningEffort(filePath, "flash", "flash-a", "low");
    const written = JSON.parse(fs.readFileSync(filePath, "utf8")) as typeof VALID_CONFIG;
    expect(written.providers.flash.models[0].reasoningEffort).toBe("low");
    expect(written.providers.flash.models[1].reasoningEffort).toBeUndefined();
  });

  it("writeReasoningEffort 非法强度报错", () => {
    const filePath = tempConfigPath(VALID_CONFIG);
    const before = fs.readFileSync(filePath, "utf8");
    expect(() =>
      writeReasoningEffort(filePath, "flash", "flash-a", "ultra" as never),
    ).toThrow(ModelConfigError);
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });
});

describe("redactSecrets", () => {
  const key = "sk-test-abcdef1234567890robe";

  it("完整 Key 被掩码", () => {
    expect(redactSecrets(`401 Unauthorized, key ${key} rejected`, [key])).not.toContain(key);
    expect(redactSecrets(`key ${key} rejected`, [key])).toContain("[REDACTED]");
  });

  it("Provider 回显的末 4 位片段也被掩码", () => {
    const echoed = "Incorrect API key provided: ...robe";
    const redacted = redactSecrets(echoed, [key]);
    expect(redacted).not.toContain("robe");
    expect(redacted).toContain("[REDACTED]");
  });
});
