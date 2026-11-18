import { expect, it } from "vitest";
import type { StoredContext } from "../../src/llm/history-replay.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { ModelService, type StreamTurnOptions } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import { compactHistory } from "../../src/sessions/compaction-store.js";
import type { NewSessionRecord, SessionRecord } from "../../src/sessions/records.js";
import { loadRealProviders, REAL_CONFIG_PATH } from "../llm/real-config.js";
import { makeAssistantRecord, makeToolResultRecord, makeUserPromptRecord } from "./helpers.js";

// pi-ai 1.5.1 起无工具请求默认省略 tools 字段；本用例验证真实端点接受恢复后的 tools:[] 摘要请求。
// 小 contextWindow 强制 fallback 路径（该路径显式传 tools:[] 且历史含工具调用/结果）。
const RECORD_TS = "2026-11-18T10:00:00.000Z";

function makeFixture() {
  const records = [makeUserPromptRecord(1, "run-1", "阅读四个文件并汇总")];
  const messages: StoredContext["messages"] = [{ role: "user", content: "阅读四个文件并汇总", timestamp: 1 }];
  let seq = 2;
  for (let i = 1; i <= 4; i++) {
    const callId = `c${i}`;
    records.push(makeAssistantRecord(seq++, "run-1", [{ id: callId, name: "read" }]));
    const content = `文件 ${i} 的内容。`.repeat(400);
    records.push(makeToolResultRecord(seq++, "run-1", callId, "success", { content }));
    const assistant = records.at(-2)!;
    if (assistant.type !== "assistant_message") throw new Error("fixture 形态错误");
    messages.push(assistant.message);
    messages.push({
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: 1,
    });
  }
  const context: StoredContext = {
    systemPrompt: "你是一个编码助手。",
    messages,
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
  };
  return { records, context };
}

it.skipIf(process.env.SHANA_REAL_COMPACTION !== "1")(
  "真实 Provider 接受 fallback 压缩摘要请求（tools:[] 前缀保留）",
  { timeout: 300000 },
  async () => {
    const loaded = loadRealProviders();
    if (!loaded) throw new Error(`缺少 ${REAL_CONFIG_PATH}，无法做真实验证`);
    for (const { model: baseModel } of loaded.entries) {
      const model: ResolvedModel = {
        ...baseModel,
        reasoning: false,
        thinking: false,
        input: ["text"],
        contextWindow: 8000,
        maxTokens: 2048,
      };
      const { records, context } = makeFixture();
      const requests: StreamTurnOptions[] = [];
      const bodies: Record<string, unknown>[] = [];
      const fetchFn: typeof fetch = async (input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return fetch(input, init);
      };
      const service = new ModelService(createConfiguredModels([model]), loaded.secrets);
      const outcome = await compactHistory({
        records,
        context,
        model,
        settings: parseSettings({ compactionSummaryTargetTokens: 512 }),
        signal: new AbortController().signal,
        retainedContextBudget: 500,
        keepLatestTurn: false,
        modelService: {
          streamTurn: (request) => {
            requests.push(request);
            return service.streamTurn({ ...request, fetch: fetchFn });
          },
        },
        appendRecord: async (input: NewSessionRecord) =>
          ({ ...input, recordSeq: 100, ts: RECORD_TS }) as SessionRecord,
        now: () => new Date(RECORD_TS),
      });
      expect(outcome.status, `${model.providerId} 压缩未完成`).toBe("completed");
      expect(outcome.path, `${model.providerId} 未走 fallback 路径`).toBe("fallback");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.context.tools).toEqual([]);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.tools, `${model.providerId} 请求体缺少 tools:[]`).toEqual([]);
    }
  },
);
