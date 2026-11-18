import { describe, expect, it } from "vitest";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import { ModelService } from "../../src/llm/model-service.js";
import type { StoredContext } from "../../src/llm/history-replay.js";
import type { StoredAssistantMessage } from "../../src/sessions/records.js";
import type { Model } from "@earendil-works/pi-ai";

function makeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "p1",
    providerName: "Provider One",
    id: "m1",
    name: "Model One",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    apiKey: "sk-adapter-key-0123456789",
    reasoning: true,
    thinking: true,
    reasoningEffort: "high",
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUnknown: true,
    ...overrides,
  };
}

function sseTextBody(text: string): string {
  const chunk = (delta: object, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-adapter",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "m1",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

function captureFetch() {
  const captured: { body?: Record<string, unknown> } = {};
  const fetchFn: typeof fetch = async (_input, init) => {
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(sseTextBody("Hi"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { captured, fetchFn };
}

describe("createConfiguredModels", () => {
  it("按 Provider 分组注册模型，非凭据字段完整映射", () => {
    const models = createConfiguredModels([
      makeResolved(),
      makeResolved({ id: "m2", name: "Model Two", providerId: "p2", providerName: "Provider Two", baseUrl: "https://other.test/v1" }),
    ]);
    const m1 = models.getModel("p1", "m1") as Model<"openai-completions">;
    expect(m1).toBeDefined();
    expect(m1.id).toBe("m1");
    expect(m1.provider).toBe("p1");
    expect(m1.baseUrl).toBe("https://example.test/v1");
    expect(m1.reasoning).toBe(true);
    expect(m1.contextWindow).toBe(131072);
    expect(m1.maxTokens).toBe(8192);
    expect(m1.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect("headers" in m1).toBe(false);
    expect(models.getModel("p2", "m2")).toBeDefined();
    expect(models.getModel("p1", "nope")).toBeUndefined();
  });

  it("thinking 关闭的 reasoning 模型不设置 thinkingLevelMap（由 pi-ai 发出 disabled）", () => {
    const models = createConfiguredModels([makeResolved({ thinking: false })]);
    const model = models.getModel("p1", "m1") as Model<"openai-completions">;
    expect(model.thinkingLevelMap).toBeUndefined();
  });

  it("thinking 开启或不支持 reasoning 的模型不加 thinkingLevelMap", () => {
    const models = createConfiguredModels([
      makeResolved(),
      makeResolved({ id: "m2", reasoning: false, thinking: false }),
    ]);
    const on = models.getModel("p1", "m1") as Model<"openai-completions">;
    const off = models.getModel("p1", "m2") as Model<"openai-completions">;
    expect(on.thinkingLevelMap).toBeUndefined();
    expect(off.thinkingLevelMap).toBeUndefined();
    expect(off.reasoning).toBe(false);
  });

  it("compat 与 samplingParams 透传", () => {
    const compat = { supportsDeveloperRole: false, thinkingFormat: "qwen" };
    const models = createConfiguredModels([
      makeResolved({
        compat,
        samplingParams: { temperature: 0.7, top_p: 0.95, stop: ["END"] },
      }),
    ]);
    const model = models.getModel("p1", "m1") as Model<"openai-completions">;
    expect(model.compat).toEqual({ ...compat, requiresToolsWithToolHistory: true });
    expect(model.samplingParams).toEqual({ temperature: 0.7, top_p: 0.95, stop: ["END"] });
  });

  it("凭据经 auth.resolve 提供，未配置 Key 的 Provider 解析为未配置", async () => {
    const models = createConfiguredModels([
      makeResolved({ providerId: "with-key", providerName: "With Key" }),
      makeResolved({ providerId: "no-key", providerName: "No Key", apiKey: undefined }),
    ]);
    const withKey = await models.getAuth("with-key");
    expect(withKey?.auth).toEqual({ apiKey: "sk-adapter-key-0123456789" });
    const noKey = await models.getAuth("no-key");
    expect(noKey?.auth).toBeUndefined();
  });
});

describe("thinking 关闭的请求参数", () => {
  const context = { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };

  async function requestBody(overrides: Partial<ResolvedModel>): Promise<Record<string, unknown>> {
    const apiKey = "sk-adapter-key-0123456789";
    const resolved = makeResolved({ apiKey, thinking: false, ...overrides });
    const models = createConfiguredModels([resolved]);
    const { captured, fetchFn } = captureFetch();
    await new ModelService(models, [apiKey]).streamTurn({ model: resolved, context, fetch: fetchFn });
    if (captured.body === undefined) throw new Error("fetch 未被调用");
    return captured.body;
  }

  it("DeepSeek 显式发送 thinking:{type:'disabled'}", async () => {
    const body = await requestBody({
      compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("Qwen 显式发送 enable_thinking:false", async () => {
    const body = await requestBody({
      compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
    });
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking).toBeUndefined();
  });
});

describe("无工具请求的 tools 字段（压缩摘要请求前缀回归）", () => {
  // pi-ai 1.5.1 起默认省略无工具请求的 tools 字段；压缩摘要依赖 tools:[] 维持与 1.4.0 相同的请求前缀。
  function summaryContext(): StoredContext {
    const assistant: StoredAssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          rawArguments: '{"path":"a.txt"}',
          parse: { status: "parsed", arguments: { path: "a.txt" } },
        },
      ],
      api: "openai-completions",
      provider: "p1",
      model: "m1",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    };
    return {
      messages: [
        { role: "user", content: "读 a.txt", timestamp: 1 },
        assistant,
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "hello" }],
          isError: false,
          timestamp: 1,
        },
      ],
      tools: [],
    };
  }

  async function requestBody(overrides: Partial<ResolvedModel>): Promise<Record<string, unknown>> {
    const apiKey = "sk-adapter-key-0123456789";
    const resolved = makeResolved({ apiKey, ...overrides });
    const models = createConfiguredModels([resolved]);
    const { captured, fetchFn } = captureFetch();
    await new ModelService(models, [apiKey]).streamTurn({
      model: resolved,
      context: summaryContext(),
      fetch: fetchFn,
    });
    if (captured.body === undefined) throw new Error("fetch 未被调用");
    return captured.body;
  }

  it("含工具历史且 tools:[] 时默认保留空数组，且不新增 prompt_cache_key", async () => {
    const body = await requestBody({});
    expect(body.tools).toEqual([]);
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it("显式 requiresToolsWithToolHistory:false 时省略 tools 字段", async () => {
    const body = await requestBody({
      compat: { supportsDeveloperRole: false, requiresToolsWithToolHistory: false },
    });
    expect(body.tools).toBeUndefined();
  });
});
