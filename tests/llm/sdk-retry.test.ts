import { describe, expect, it } from "vitest";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { ModelService } from "../../src/llm/model-service.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";

const API_KEY = "sk-v2-key-0123456789abcd";

function makeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "p1",
    providerName: "Provider One",
    id: "m1",
    name: "Model One",
    api: "openai-completions",
    baseUrl: "https://fake.test/v1",
    apiKey: API_KEY,
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

function sseSuccessBody(): string {
  const chunk = (delta: object, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-v2",
      object: "chat.completion.chunk",
      created: 1730000000,
      model: "m1",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: "Hi" }, null) +
    chunk({}, "stop") +
    "data: [DONE]\n\n"
  );
}

function countingFetch(failuresBeforeSuccess: number) {
  const state = { httpCalls: 0 };
  const fetchFn = async () => {
    state.httpCalls += 1;
    if (state.httpCalls <= failuresBeforeSuccess) {
      return new Response(
        JSON.stringify({ error: { message: "Internal Server Error", type: "server_error", code: "500" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(sseSuccessBody(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { state, fetchFn };
}

describe("V2 SDK 客户端重试受控", () => {
  it("maxRetries=0 时 HTTP 尝试次数 = Agent 层次数，无 SDK 隐藏重试", async () => {
    const { state, fetchFn } = countingFetch(1);
    const resolved = makeResolved();
    const models = createConfiguredModels([resolved]);
    const service = new ModelService(models, [API_KEY]);
    const result = await service.streamTurn({
      model: resolved,
      context: { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      fetch: fetchFn,
      sleep: () => Promise.resolve(),
    });
    expect(result.attempts).toBe(2);
    expect(state.httpCalls).toBe(2);
    expect(result.text).toBe("Hi");
  });

  it("单次成功请求恰好 1 次 HTTP 尝试", async () => {
    const { state, fetchFn } = countingFetch(0);
    const resolved = makeResolved();
    const models = createConfiguredModels([resolved]);
    const service = new ModelService(models, [API_KEY]);
    const result = await service.streamTurn({
      model: resolved,
      context: { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      fetch: fetchFn,
    });
    expect(result.attempts).toBe(1);
    expect(state.httpCalls).toBe(1);
  });
});
