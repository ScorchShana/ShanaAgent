import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import {
  ModelService,
  TurnError,
  createModelSnapshot,
  retryBackoffDelayMs,
} from "../../src/llm/model-service.js";
import type { TurnEvent, TurnRequester, TurnStream } from "../../src/llm/model-service.js";

const API_KEY = "sk-test-secret-9f8e7d6c5b4a";

function makeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "p1",
    providerName: "Provider One",
    id: "m1",
    name: "Model One",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
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

function makeMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
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
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function successToolUseMessage(toolCalls: AssistantMessage["content"]): AssistantMessage {
  return makeMessage({ content: toolCalls, stopReason: "toolUse", rawStopReason: "tool_calls" });
}

function errorMessage(errorMessage: string): AssistantMessage {
  return makeMessage({ stopReason: "error", errorMessage });
}

function scriptedStream(events: AssistantMessageEvent[], final: AssistantMessage): TurnStream {
  const stream = createAssistantMessageEventStream();
  for (const event of events) stream.push(event);
  stream.end(final);
  return stream;
}

function textEvents(text: string): AssistantMessageEvent[] {
  return [
    { type: "text_delta", contentIndex: 0, delta: text, partial: makeMessage() },
    { type: "text_end", contentIndex: 0, content: text, partial: makeMessage() },
  ];
}

function successTextStream(text: string): TurnStream {
  return scriptedStream(textEvents(text), makeMessage({ content: [{ type: "text", text }] }));
}

class FakeRequester implements TurnRequester {
  readonly calls: { options: ModelsSimpleStreamOptions }[] = [];
  private scripts: (() => TurnStream)[] = [];

  queue(...scripts: (() => TurnStream)[]): void {
    this.scripts.push(...scripts);
  }

  stream(
    _providerId: string,
    _modelId: string,
    _context: unknown,
    options: ModelsSimpleStreamOptions,
  ): TurnStream {
    this.calls.push({ options });
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeRequester: no script queued");
    return script();
  }
}

function makeService(requester: FakeRequester, secrets: readonly string[] = [API_KEY]): ModelService {
  return new ModelService({} as Models, secrets, requester);
}

const CONTEXT = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

describe("v2 raw argument capture", () => {
  it("honors cancellation while awaiting the final result", async () => {
    const controller = new AbortController();
    const requester: TurnRequester = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          controller.abort();
          return makeMessage();
        },
      }),
    };
    await expect(
      new ModelService({} as Models, [], requester).streamTurn({
        model: makeResolved(),
        context: CONTEXT,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });
  it("keeps interleaved argument deltas at their content indices", async () => {
    const requester = new FakeRequester();
    const a = { type: "toolCall" as const, id: "a", name: "read", arguments: {} };
    const b = { ...a, id: "b" };
    const final = successToolUseMessage([a, b]);
    requester.queue(() =>
      scriptedStream(
        [
          { type: "toolcall_delta", contentIndex: 0, delta: '{"path":', partial: final },
          { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"b"}', partial: final },
          { type: "toolcall_delta", contentIndex: 0, delta: '"a"}', partial: final },
        ],
        final,
      ),
    );
    const result = await makeService(requester).streamTurn({ model: makeResolved(), context: CONTEXT });
    expect(result.toolCalls.map((call) => call.rawArguments)).toEqual(['{"path":"a"}', '{"path":"b"}']);
  });
  it("does not reconstruct missing raw text from SDK objects", async () => {
    const requester = new FakeRequester();
    requester.queue(() =>
      scriptedStream(
        [],
        successToolUseMessage([{ type: "toolCall", id: "a", name: "read", arguments: { path: "sdk-only" } }]),
      ),
    );
    await expect(
      makeService(requester).streamTurn({ model: makeResolved(), context: CONTEXT }),
    ).rejects.toThrow(/Missing raw/);
  });
  it("does not retain cancelled argument fragments in the next request", async () => {
    const requester = new FakeRequester();
    const call = { type: "toolCall" as const, id: "a", name: "read", arguments: {} };
    requester.queue(
      () =>
        scriptedStream(
          [{ type: "toolcall_delta", contentIndex: 0, delta: "cancelled fragment", partial: makeMessage() }],
          makeMessage({ stopReason: "aborted" }),
        ),
      () =>
        scriptedStream(
          [{ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"next"}', partial: makeMessage() }],
          successToolUseMessage([call]),
        ),
    );
    const service = makeService(requester);
    await expect(service.streamTurn({ model: makeResolved(), context: CONTEXT })).rejects.toMatchObject({
      kind: "cancelled",
    });
    const next = await service.streamTurn({ model: makeResolved(), context: CONTEXT });
    expect(next.toolCalls[0]?.rawArguments).toBe('{"path":"next"}');
  });
});

describe("createModelSnapshot", () => {
  it("copies values so later config edits do not change the snapshot", () => {
    const resolved = makeResolved();
    const input = resolved.input;
    const snapshot = createModelSnapshot(resolved);
    resolved.reasoningEffort = "low";
    input.push("image" as never);
    expect(snapshot.reasoningEffort).toBe("high");
    expect(snapshot.reasoning).toBe(true);
    expect(snapshot.input).toEqual(["text"]);
  });
});

describe("retryBackoffDelayMs", () => {
  it("doubles from 1s and caps at 16s without jitter", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryBackoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 16000, 16000,
    ]);
  });
});

describe("V1 单次逻辑 Turn 流式", () => {
  it("exposes ordered text/thinking/toolcall events and a complete final message", async () => {
    const requester = new FakeRequester();
    const toolCall = {
      type: "toolCall" as const,
      id: "call_1",
      name: "get_weather",
      arguments: { city: "Beijing" },
    };
    const final = makeMessage({
      content: [{ type: "text", text: "Let me check." }, { type: "thinking", thinking: "hmm" }, toolCall],
      stopReason: "toolUse",
      rawStopReason: "tool_calls",
    });
    requester.queue(() =>
      scriptedStream(
        [
          { type: "start", partial: makeMessage() },
          { type: "text_delta", contentIndex: 0, delta: "Let me ", partial: makeMessage() },
          { type: "text_delta", contentIndex: 0, delta: "check.", partial: makeMessage() },
          { type: "text_end", contentIndex: 0, content: "Let me check.", partial: makeMessage() },
          { type: "thinking_delta", contentIndex: 1, delta: "hm", partial: makeMessage() },
          { type: "thinking_delta", contentIndex: 1, delta: "m", partial: makeMessage() },
          { type: "thinking_end", contentIndex: 1, content: "hmm", partial: makeMessage() },
          { type: "toolcall_start", contentIndex: 2, partial: final },
          {
            type: "toolcall_delta",
            contentIndex: 2,
            delta: JSON.stringify(toolCall.arguments),
            partial: final,
          },
          { type: "toolcall_end", contentIndex: 2, toolCall, partial: final },
          { type: "done", reason: "toolUse", message: final },
        ],
        final,
      ),
    );
    const events: TurnEvent[] = [];
    const service = makeService(requester);
    const result = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      onEvent: (event) => events.push(event),
    });

    expect(result.stopReason).toBe("toolUse");
    expect(result.rawStopReason).toBe("tool_calls");
    expect(result.usage.input).toBe(10);
    expect(result.text).toBe("Let me check.");
    expect(result.thinking).toBe("hmm");
    expect(result.toolCalls[0]).toMatchObject({
      id: toolCall.id,
      parse: { status: "parsed", arguments: toolCall.arguments },
    });
    expect(result.truncated).toBe(false);
    expect(result.toolCalls.every((call) => call.parse.status === "parsed")).toBe(true);
    expect(result.attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_end",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
    ]);

    const received = requester.calls[0]?.options;
    expect(received?.maxRetries).toBe(0);
    expect(received?.reasoning).toBe("high");
  });
});

describe("V11 thinking 与强度（单元部分）", () => {
  it("thinking off 不传强度", async () => {
    const requester = new FakeRequester();
    requester.queue(() => successTextStream("ok"));
    const service = makeService(requester);
    await service.streamTurn({ model: makeResolved({ thinking: false }), context: CONTEXT });
    expect(requester.calls[0]?.options.reasoning).toBeUndefined();
  });

  it("默认开启传 reasoningEffort: high，自定义强度原样传递", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () => successTextStream("ok"),
      () => successTextStream("ok"),
    );
    const service = makeService(requester);
    await service.streamTurn({ model: makeResolved(), context: CONTEXT });
    await service.streamTurn({ model: makeResolved({ reasoningEffort: "low" }), context: CONTEXT });
    expect(requester.calls[0]?.options.reasoning).toBe("high");
    expect(requester.calls[1]?.options.reasoning).toBe("low");
  });

  it("Run 快照不随后续配置调整改变", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () => successTextStream("ok"),
      () => successTextStream("ok"),
    );
    const service = makeService(requester);
    const resolved = makeResolved({ reasoningEffort: "high" });
    const snapshotBefore = createModelSnapshot(resolved);
    await service.streamTurn({ model: resolved, context: CONTEXT });
    resolved.reasoningEffort = "low";
    await service.streamTurn({ model: resolved, context: CONTEXT });
    const snapshotAfter = createModelSnapshot(resolved);
    expect(snapshotBefore.reasoningEffort).toBe("high");
    expect(snapshotAfter.reasoningEffort).toBe("low");
    expect(requester.calls[0]?.options.reasoning).toBe("high");
    expect(requester.calls[1]?.options.reasoning).toBe("low");
  });
});

describe("V3 Agent 重试语义", () => {
  it("maxRetries=10 时最多 11 次实际请求，模型快照请求参数固定", async () => {
    const requester = new FakeRequester();
    requester.queue(
      ...Array.from(
        { length: 11 },
        () => () => scriptedStream([], errorMessage("429 Too Many Requests: Requests rate limit exceeded")),
      ),
    );
    const service = makeService(requester);
    const error = await service
      .streamTurn({ model: makeResolved(), context: CONTEXT, sleep: () => Promise.resolve() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TurnError);
    expect((error as TurnError).kind).toBe("retryable_exhausted");
    expect((error as TurnError).attempts).toBe(11);
    expect(requester.calls.length).toBe(11);
    const firstOptions = requester.calls[0]?.options;
    expect(requester.calls.every((call) => call.options === firstOptions)).toBe(true);
  });

  it("每次 streamTurn 单独计数", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () => scriptedStream([], errorMessage("429 rate limit")),
      () => successTextStream("ok"),
      () => scriptedStream([], errorMessage("429 rate limit")),
      () => successTextStream("ok"),
    );
    const service = makeService(requester);
    const first = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      sleep: () => Promise.resolve(),
    });
    const second = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      sleep: () => Promise.resolve(),
    });
    expect(first.attempts).toBe(2);
    expect(second.attempts).toBe(2);
  });

  it("认证失败与无效请求 0 重试", async () => {
    const cases = [
      "401: Authentication Fails, Your API Key is invalid",
      "400: supported API model names are deepseek-flash, deepseek-v4-pro",
    ];
    for (const message of cases) {
      const requester = new FakeRequester();
      requester.queue(() => scriptedStream([], errorMessage(message)));
      const service = makeService(requester);
      const error = await service
        .streamTurn({ model: makeResolved(), context: CONTEXT, sleep: () => Promise.resolve() })
        .catch((e: unknown) => e);
      expect((error as TurnError).kind).toBe("non_retryable");
      expect((error as TurnError).attempts).toBe(1);
      expect(requester.calls.length).toBe(1);
    }
  });

  it("429 与网络错误按启发式重试（构造分类，真实 429 仍未验证）", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () => scriptedStream([], errorMessage("429 ... Rate limit reached")),
      () => scriptedStream([], errorMessage("Connection error.")),
      () => successTextStream("ok"),
    );
    const service = makeService(requester);
    const result = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      sleep: () => Promise.resolve(),
    });
    expect(result.attempts).toBe(3);
    expect(result.text).toBe("ok");
  });

  it("maxRetries=0 时只做初始请求", async () => {
    const requester = new FakeRequester();
    requester.queue(() => scriptedStream([], errorMessage("429 rate limit")));
    const service = makeService(requester);
    const error = await service
      .streamTurn({ model: makeResolved(), context: CONTEXT, maxRetries: 0 })
      .catch((e: unknown) => e);
    expect((error as TurnError).kind).toBe("retryable_exhausted");
    expect(requester.calls.length).toBe(1);
  });
});

describe("V4 退避与取消", () => {
  it("退避间隔指数增长且可断言", async () => {
    const delays: number[] = [];
    const requester = new FakeRequester();
    requester.queue(
      ...Array.from({ length: 5 }, () => () => scriptedStream([], errorMessage("429 rate limit"))),
      () => successTextStream("ok"),
    );
    const service = makeService(requester);
    const result = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.attempts).toBe(6);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("退避等待中 abort 立即结束且不再发请求", async () => {
    const controller = new AbortController();
    const requester = new FakeRequester();
    requester.queue(() => scriptedStream([], errorMessage("429 rate limit")));
    const service = makeService(requester);
    const error = await service
      .streamTurn({
        model: makeResolved(),
        context: CONTEXT,
        signal: controller.signal,
        sleep: () => {
          controller.abort();
          return Promise.reject(new Error("Turn aborted"));
        },
      })
      .catch((e: unknown) => e);
    expect((error as TurnError).kind).toBe("cancelled");
    expect(requester.calls.length).toBe(1);
  });

  it("请求前已 abort 不发起请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const requester = new FakeRequester();
    const service = makeService(requester);
    const error = await service
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as TurnError).kind).toBe("cancelled");
    expect(requester.calls.length).toBe(0);
  });

  it("流式中途 abort：无残留 delta，不再重试", async () => {
    const controller = new AbortController();
    const requester = new FakeRequester();
    requester.queue(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial",
          partial: makeMessage(),
        } as AssistantMessageEvent;
        controller.abort();
        yield {
          type: "error",
          reason: "aborted",
          error: makeMessage({ stopReason: "aborted" }),
        } as AssistantMessageEvent;
      },
      result: () => Promise.resolve(makeMessage({ stopReason: "aborted" })),
    }));
    const service = makeService(requester);
    const deltas: TurnEvent[] = [];
    const error = await service
      .streamTurn({
        model: makeResolved(),
        context: CONTEXT,
        signal: controller.signal,
        onEvent: (event) => deltas.push(event),
      })
      .catch((e: unknown) => e);
    expect((error as TurnError).kind).toBe("cancelled");
    expect(deltas).toEqual([{ type: "text_delta", attempt: 1, delta: "partial" }]);
    expect(requester.calls.length).toBe(1);
  });
});

describe("取消携带部分响应（partial）", () => {
  function abortingStream(
    controller: AbortController,
    events: AssistantMessageEvent[],
    final: AssistantMessage,
  ): TurnStream {
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        controller.abort();
        yield { type: "error", reason: "aborted", error: final } as AssistantMessageEvent;
      },
      result: () => Promise.resolve(final),
    };
  }

  it("文本部分响应转为 aborted 存储形态", async () => {
    const controller = new AbortController();
    const final = makeMessage({ stopReason: "aborted", content: [{ type: "text", text: "partial" }] });
    const requester = new FakeRequester();
    requester.queue(() =>
      abortingStream(
        controller,
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "partial",
            partial: makeMessage(),
          } as AssistantMessageEvent,
        ],
        final,
      ),
    );
    const error = (await makeService(requester)
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e)) as TurnError;
    expect(error.kind).toBe("cancelled");
    expect(error.partial?.stopReason).toBe("aborted");
    expect(error.partial?.content).toEqual([{ type: "text", text: "partial" }]);
  });

  it("半截 toolCall 参数记为 incomplete，不抛错", async () => {
    const controller = new AbortController();
    const call = { type: "toolCall" as const, id: "a", name: "read", arguments: {} };
    const final = makeMessage({ stopReason: "aborted", content: [call] });
    const requester = new FakeRequester();
    requester.queue(() =>
      abortingStream(
        controller,
        [
          { type: "toolcall_start", contentIndex: 0, partial: final } as AssistantMessageEvent,
          {
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"path":',
            partial: final,
          } as AssistantMessageEvent,
        ],
        final,
      ),
    );
    const error = (await makeService(requester)
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e)) as TurnError;
    expect(error.kind).toBe("cancelled");
    const block = error.partial?.content.find((b) => b.type === "toolCall");
    expect(block).toMatchObject({ id: "a", name: "read", rawArguments: '{"path":' });
    expect(block?.type === "toolCall" && block.parse).toMatchObject({
      status: "invalid",
      error: "incomplete",
    });
  });

  it("迭代中途抛错（result 未解析）从累积片段诚实合成 partial", async () => {
    const controller = new AbortController();
    const requester: TurnRequester = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "x",
            partial: makeMessage(),
          } as AssistantMessageEvent;
          controller.abort();
          throw new Error("Turn aborted");
        },
        result: () => new Promise<AssistantMessage>(() => {}),
      }),
    };
    const error = (await makeService(requester)
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e)) as TurnError;
    expect(error.kind).toBe("cancelled");
    expect(error.partial?.stopReason).toBe("aborted");
    expect(error.partial?.content).toEqual([{ type: "text", text: "x" }]);
    // 元数据来自真实请求配置；usage 无数据来源，零值占位表示"未计数"。
    expect(error.partial).toMatchObject({ api: "openai-completions", provider: "p1", model: "m1" });
    expect(error.partial?.usage.input).toBe(0);
    expect(error.partial?.usage.totalTokens).toBe(0);
  });

  it("迭代中途抛错且无累积内容时不合成 partial（不捏造空消息）", async () => {
    const controller = new AbortController();
    const requester: TurnRequester = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          // start 事件不累积任何内容，buffer 保持为空。
          yield { type: "start", partial: makeMessage() } as AssistantMessageEvent;
          controller.abort();
          throw new Error("Turn aborted");
        },
        result: () => new Promise<AssistantMessage>(() => {}),
      }),
    };
    const error = (await makeService(requester)
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e)) as TurnError;
    expect(error.kind).toBe("cancelled");
    expect(error.partial).toBeUndefined();
  });

  it("迭代中途抛错时已完成 toolCall 按 contentIndex 映射 raw 原文", async () => {
    const controller = new AbortController();
    const call = { type: "toolCall" as const, id: "a", name: "read", arguments: { path: "x" } };
    const requester: TurnRequester = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "t",
            partial: makeMessage(),
          } as AssistantMessageEvent;
          yield {
            type: "toolcall_start",
            contentIndex: 1,
            partial: makeMessage(),
          } as AssistantMessageEvent;
          yield {
            type: "toolcall_delta",
            contentIndex: 1,
            delta: '{"path":"x"}',
            partial: makeMessage(),
          } as AssistantMessageEvent;
          yield {
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: call,
            partial: makeMessage(),
          } as AssistantMessageEvent;
          controller.abort();
          throw new Error("Turn aborted");
        },
        result: () => new Promise<AssistantMessage>(() => {}),
      }),
    };
    const error = (await makeService(requester)
      .streamTurn({ model: makeResolved(), context: CONTEXT, signal: controller.signal })
      .catch((e: unknown) => e)) as TurnError;
    expect(error.kind).toBe("cancelled");
    const block = error.partial?.content.find((b) => b.type === "toolCall");
    expect(block).toMatchObject({ id: "a", name: "read", rawArguments: '{"path":"x"}' });
    expect(block?.type === "toolCall" && block.parse).toMatchObject({ status: "parsed" });
  });
});

describe("V5 失败尝试隔离", () => {
  it("重试前后文本不拼接，失败尝试不进正式消息", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () => scriptedStream(textEvents("BROKEN"), errorMessage("429 rate limit")),
      () => successTextStream("OK"),
    );
    const events: TurnEvent[] = [];
    const service = makeService(requester);
    const result = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      onEvent: (event) => events.push(event),
      sleep: () => Promise.resolve(),
    });
    expect(result.attempts).toBe(2);
    expect(result.text).toBe("OK");
    expect(JSON.stringify(result.message.content)).not.toContain("BROKEN");
    const failedEvent = events.find((event) => event.type === "attempt_failed");
    expect(failedEvent).toMatchObject({ attempt: 1, nextDelayMs: 1000 });
    const attemptOneText = events.filter((event) => event.type === "text_delta" && event.attempt === 1);
    const attemptTwoText = events.filter((event) => event.type === "text_delta" && event.attempt === 2);
    expect(attemptOneText).toEqual([{ type: "text_delta", attempt: 1, delta: "BROKEN" }]);
    expect(attemptTwoText).toEqual([{ type: "text_delta", attempt: 2, delta: "OK" }]);
  });
});

describe("V6 截断门控数据完整", () => {
  it("stopReason=toolUse 但 argumentsError 非空时不可执行", async () => {
    const requester = new FakeRequester();
    const brokenCall = {
      type: "toolCall" as const,
      id: "call_bad",
      name: "write_note",
      arguments: {},
      argumentsError: "Unterminated string in JSON at position 806",
    };
    requester.queue(() =>
      scriptedStream(
        [
          { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a', partial: makeMessage() },
          { type: "toolcall_end", contentIndex: 0, toolCall: brokenCall, partial: makeMessage() },
        ],
        successToolUseMessage([brokenCall]),
      ),
    );
    const service = makeService(requester);
    const result = await service.streamTurn({ model: makeResolved(), context: CONTEXT });
    expect(result.stopReason).toBe("toolUse");
    expect(result).not.toHaveProperty("toolCallsComplete");
    expect(result.toolCalls[0]?.parse).toEqual({ status: "invalid", error: "incomplete" });
  });

  it("length 截断如实上报", async () => {
    const requester = new FakeRequester();
    requester.queue(() =>
      scriptedStream(
        textEvents("partial output"),
        makeMessage({
          content: [{ type: "text", text: "partial output" }],
          stopReason: "length",
          rawStopReason: "length",
        }),
      ),
    );
    const service = makeService(requester);
    const result = await service.streamTurn({ model: makeResolved(), context: CONTEXT });
    expect(result.truncated).toBe(true);
    expect(result).not.toHaveProperty("toolCallsComplete");
  });
});

describe("V7 溢出不可重试", () => {
  it("isContextOverflow 判定保留、0 重试、错误如实上抛", async () => {
    const requester = new FakeRequester();
    const overflow =
      '400: {"message":"This model\'s maximum context length is 131072 tokens. However, you requested 145230 tokens (145230 in the messages, 10 in the completion).","type":"invalid_request_error"}';
    requester.queue(() => scriptedStream([], errorMessage(overflow)));
    const service = makeService(requester);
    const error = await service
      .streamTurn({ model: makeResolved(), context: CONTEXT, sleep: () => Promise.resolve() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TurnError);
    expect((error as TurnError).kind).toBe("context_overflow");
    expect((error as TurnError).attempts).toBe(1);
    expect((error as TurnError).message).toContain("maximum context length is 131072 tokens");
    expect(requester.calls.length).toBe(1);
  });
});

describe("V10 脱敏", () => {
  it("错误信息与事件中的完整 Key 与 Key 片段被替换", async () => {
    const requester = new FakeRequester();
    requester.queue(
      () =>
        scriptedStream(
          [],
          errorMessage(
            `429 Too Many Requests: Requests rate limit exceeded for key ${API_KEY} (…${API_KEY.slice(-8)})`,
          ),
        ),
      () => successTextStream("ok"),
    );
    const events: TurnEvent[] = [];
    const service = makeService(requester);
    const result = await service.streamTurn({
      model: makeResolved(),
      context: CONTEXT,
      onEvent: (event) => events.push(event),
      sleep: () => Promise.resolve(),
    });
    expect(result.text).toBe("ok");
    const failedEvent = events.find((event) => event.type === "attempt_failed");
    expect(failedEvent).toBeDefined();
    expect(JSON.stringify(failedEvent)).not.toContain(API_KEY);
    expect(JSON.stringify(failedEvent)).not.toContain(API_KEY.slice(-8));
    expect(JSON.stringify(failedEvent)).toContain("[REDACTED]");
    expect(service.redact(`key=${API_KEY} tail=${API_KEY.slice(-4)}`)).toBe("key=[REDACTED] tail=[REDACTED]");
  });
});
