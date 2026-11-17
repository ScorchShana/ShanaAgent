import type { StoredAssistantMessage } from "../../src/sessions/records.js";
import type { StoredContext } from "../../src/llm/history-replay.js";
import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { redactSecrets } from "../../src/llm/model-config-store.js";
import { ModelService, TurnError } from "../../src/llm/model-service.js";
import type { TurnResult } from "../../src/llm/model-service.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import type { ProviderRole } from "./real-config.js";
import { loadRealProviders, REAL_CONFIG_PATH } from "./real-config.js";

// 真实 Provider 验证：默认跳过（不联网、不读凭据）；设置 SHANA_REAL_PROVIDERS=1 后运行。
// 凭据源为用户产品配置 ~/.shana/model.json，仅在运行时读取，且任何输出前都必须过 redactSecrets。
const ENABLED = process.env.SHANA_REAL_PROVIDERS === "1";

// thinking 两态等字段是测试刻意覆盖，不随产品配置取值（V11a/b 依赖）。
function withTestOverrides(model: ResolvedModel, role: ProviderRole, thinking: boolean): ResolvedModel {
  return {
    ...model,
    reasoning: true,
    thinking,
    reasoningEffort: "high",
    input: ["text"],
    compat: { supportsDeveloperRole: false, thinkingFormat: role },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUnknown: true,
  };
}

const getWeather: Tool = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: Type.Object({ city: Type.String() }),
};

const SYSTEM_PROMPT = "You are a concise assistant. Use the get_weather tool when asked about weather.";

interface LoopSummary {
  toolTurns: number;
  toolCalls: number;
  maxCallsPerTurn: number;
  uniqueIds: number;
  finalText: string;
  results: TurnResult[];
}

const SERIAL_CITIES = ["Beijing", "Shanghai", "Guangzhou"] as const;

async function runSerialToolLoop(service: ModelService, model: ResolvedModel): Promise<LoopSummary> {
  const context: StoredContext = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [],
    tools: [getWeather],
  };
  const seenIds = new Set<string>();
  const results: TurnResult[] = [];
  let toolCalls = 0;
  let maxCallsPerTurn = 0;
  for (const city of SERIAL_CITIES) {
    context.messages.push({
      role: "user",
      content: `Call get_weather for ${city} now. Do not call the tool for any other city in this turn.`,
      timestamp: Date.now(),
    });
    const result = await service.streamTurn({ model, context, maxTokens: 2048 });
    results.push(result);
    context.messages.push(result.message);
    maxCallsPerTurn = Math.max(maxCallsPerTurn, result.toolCalls.length);
    const call = result.toolCalls[0];
    if (
      result.toolCalls.length !== 1 ||
      result.stopReason === "length" ||
      call?.parse.status !== "parsed" ||
      call === undefined
    ) {
      return {
        toolTurns: results.length,
        toolCalls,
        maxCallsPerTurn,
        uniqueIds: seenIds.size,
        finalText: result.text,
        results,
      };
    }
    toolCalls += 1;
    seenIds.add(call.id);
    const argCity =
      ((call.parse.status === "parsed" ? call.parse.arguments : {}) as { city?: string }).city ?? "unknown";
    context.messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: `Weather in ${argCity}: Sunny, 25°C` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  context.messages.push({
    role: "user",
    content: "All three results are in. Reply DONE with a one-line summary.",
    timestamp: Date.now(),
  });
  const final = await service.streamTurn({ model, context, maxTokens: 2048 });
  results.push(final);
  return {
    toolTurns: SERIAL_CITIES.length,
    toolCalls,
    maxCallsPerTurn,
    uniqueIds: seenIds.size,
    finalText: final.text,
    results,
  };
}

function pushAssistant(context: StoredContext, message: StoredAssistantMessage): void {
  context.messages.push(message);
}

describe.skipIf(!ENABLED)("T3 真实 Provider 验证（DeepSeek Flash / Qwen Flash）", () => {
  const loaded = ENABLED ? loadRealProviders() : null;
  const entries = loaded?.entries ?? [];
  const secrets = loaded?.secrets ?? [];
  const redact = (text: string) => redactSecrets(text, secrets);

  it("前置：用户维护的 model.json 可用且两 Provider 可识别", () => {
    expect(loaded, `缺少 ${REAL_CONFIG_PATH}，无法做真实验证`).not.toBeNull();
    const roles = entries.map((entry) => entry.role);
    expect(roles).toContain("deepseek");
    expect(roles).toContain("qwen");
  });

  for (const { role, model: baseModel } of entries) {
    const model = withTestOverrides(baseModel, role, true);

    describe(`${baseModel.providerId} (${role})`, () => {
      const models = createConfiguredModels([model]);
      const service = new ModelService(models, secrets);

      it("V8a 多轮 Tool Calling ≥3 轮", { timeout: 300000 }, async () => {
        const summary = await runSerialToolLoop(service, model);
        console.log(
          redact(
            `[${model.providerId}] toolTurns=${summary.toolTurns} toolCalls=${summary.toolCalls} ` +
              `maxCallsPerTurn=${summary.maxCallsPerTurn} uniqueIds=${summary.uniqueIds} ` +
              `usage=${JSON.stringify(summary.results.map((r) => r.message.usage))}`,
          ),
        );
        expect(summary.maxCallsPerTurn).toBe(1);
        expect(summary.toolTurns).toBeGreaterThanOrEqual(3);
        expect(summary.toolCalls).toBeGreaterThanOrEqual(3);
        expect(summary.uniqueIds).toBe(summary.toolCalls);
        expect(summary.finalText.length).toBeGreaterThan(0);
      });

      it("V8b 同轮多工具", { timeout: 300000 }, async () => {
        const context: StoredContext = {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: "Call get_weather for Beijing and Shanghai in the same turn, then summarize both.",
              timestamp: Date.now(),
            },
          ],
          tools: [getWeather],
        };
        const first = await service.streamTurn({ model, context, maxTokens: 2048 });
        pushAssistant(context, first.message);
        expect(first.toolCalls.every((call) => call.parse.status === "parsed")).toBe(true);
        expect(first.toolCalls.length).toBeGreaterThanOrEqual(2);
        for (const call of first.toolCalls) {
          const city =
            ((call.parse.status === "parsed" ? call.parse.arguments : {}) as { city?: string }).city ??
            "unknown";
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `Weather in ${city}: Sunny, 25°C` }],
            isError: false,
            timestamp: Date.now(),
          });
        }
        const second = await service.streamTurn({ model, context, maxTokens: 2048 });
        console.log(
          redact(
            `[${model.providerId}] same-turn calls=${first.toolCalls.length} final="${second.text.slice(0, 80)}"`,
          ),
        );
        expect(second.text.length).toBeGreaterThan(0);
      });

      it("V8c 流式中途 Abort", { timeout: 300000 }, async () => {
        const controller = new AbortController();
        let deltas = 0;
        const error = await service
          .streamTurn({
            model,
            context: {
              messages: [
                {
                  role: "user",
                  content: "Tell me a very long detailed story about the history of computing.",
                  timestamp: Date.now(),
                },
              ],
            },
            maxTokens: 4096,
            signal: controller.signal,
            onEvent: (event) => {
              if ((event.type === "text_delta" || event.type === "thinking_delta") && deltas === 0) {
                deltas += 1;
                controller.abort();
              }
            },
          })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(TurnError);
        expect((error as TurnError).kind).toBe("cancelled");
      });

      it("V11a thinking 默认开启（reasoningEffort=high）", { timeout: 300000 }, async () => {
        const result = await service.streamTurn({
          model,
          context: { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
          maxTokens: 512,
        });
        const usage = result.message.usage;
        console.log(
          redact(
            `[${model.providerId}] thinking-on thinkingChars=${result.thinking.length} reasoningTokens=${usage.reasoning ?? "unset"} providerThinkingLevel=${result.message.providerThinkingLevel ?? "unset"}`,
          ),
        );
        console.log(redact(`[${model.providerId}] response="${result.text.slice(0, 60)}"`));
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.stopReason).toBe("stop");
      });

      it("V11b thinking 显式关闭", { timeout: 300000 }, async () => {
        const offModel = withTestOverrides(baseModel, role, false);
        const offService = new ModelService(createConfiguredModels([offModel]), secrets);
        let thinkingDeltas = 0;
        const result = await offService.streamTurn({
          model: offModel,
          context: { messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }] },
          maxTokens: 512,
          onEvent: (event) => {
            if (event.type === "thinking_delta") thinkingDeltas += 1;
          },
        });
        console.log(
          redact(
            `[${model.providerId}] thinking-off thinkingDeltas=${thinkingDeltas} reasoningTokens=${result.message.usage.reasoning ?? "unset"}`,
          ),
        );
        expect(result.text.length).toBeGreaterThan(0);
        expect(thinkingDeltas).toBe(0);
        expect(result.message.usage.reasoning ?? 0).toBe(0);
      });
    });
  }
});
