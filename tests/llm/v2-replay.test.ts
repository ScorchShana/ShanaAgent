import { createToolRegistry } from "../../src/tools/registry.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { ModelService } from "../../src/llm/model-service.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import { prepareReplay } from "../../src/llm/history-replay.js";
import { buildContext } from "../../src/core/context-builder.js";
import { resumeSession } from "../../src/sessions/recovery.js";
import {
  cleanupTempDirs,
  makeAssistantRecord,
  makeStore,
  sessionRef,
  WORKSPACE_ID,
  tempDir,
} from "../sessions/helpers.js";

const model: ResolvedModel = {
  providerId: "p1",
  providerName: "Test",
  id: "m1",
  name: "Test",
  api: "openai-completions",
  baseUrl: "https://fake.test/v1",
  apiKey: "synthetic-key",
  reasoning: false,
  thinking: false,
  reasoningEffort: "high",
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};
function response(raw?: string, reason = "tool_calls") {
  const chunk = (delta: object, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "test", model: "m1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta =
    raw === undefined
      ? { role: "assistant", content: "done" }
      : {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "same|long+id", type: "function", function: { name: "read", arguments: raw } },
          ],
        };
  return new Response(chunk(delta, null) + chunk({}, reason) + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}
afterEach(cleanupTempDirs);
describe("SDK v2 replay", () => {
  it("captures raw before SDK repair, persists and resumes, then pairs repeated IDs across models", async () => {
    const { store } = makeStore();
    const ref = sessionRef("sdk-v2");
    await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
    await store.appendRecord(ref, { type: "user_prompt", runId: "r", text: "read" });
    const service = new ModelService(createConfiguredModels([model]), []);
    const raw = '{ "path": "synthetic-key",';
    const first = await service.streamTurn({
      model,
      context: { messages: [] },
      fetch: async () => response(raw),
    });
    expect(first.toolCalls[0]).toMatchObject({
      rawArguments: raw,
      parse: { status: "invalid", error: "incomplete" },
    });
    for (const message of [first.message, first.message]) {
      const intent = await store.appendRecord(ref, { type: "assistant_message", runId: "r", message });
      await store.appendRecord(ref, {
        type: "tool_result",
        runId: "r",
        assistantRecordSeq: intent.recordSeq,
        toolCallId: first.toolCalls[0]!.id,
        toolName: "read",
        status: "error",
        content: "Error: Incomplete arguments JSON. Not executed. Resend complete JSON.",
      });
    }
    await store.releaseSession(ref);
    const copy = await resumeSession(store, ref);
    const built = await buildContext({
      records: copy.records,
      currentPrompt: "retry",
      workspacePath: tempDir(),
    });
    built.context.tools = createToolRegistry()
      .list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    const target = { ...model, providerId: "p2", id: "m2" };
    let payload: Record<string, unknown> = {};
    await new ModelService(createConfiguredModels([target]), []).streamTurn({
      model: target,
      context: built.context,
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return response(undefined, "stop");
      },
    });
    const messages = payload.messages as {
      tool_calls?: { id: string; function: { arguments: string } }[];
      tool_call_id?: string;
    }[];
    const calls = messages.flatMap((m) => m.tool_calls ?? []);
    expect(calls.map((c) => c.function.arguments)).toEqual([raw, raw]);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
    expect(messages.flatMap((m) => (m.tool_call_id ? [m.tool_call_id] : []))).toEqual(calls.map((c) => c.id));
    const definitions = payload.tools as {
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }[];
    expect(definitions.map((tool) => tool.function.name)).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
    ]);
    expect(definitions.find((tool) => tool.function.name === "bash")?.function.parameters).toMatchObject({
      properties: { timeout: { default: 120, minimum: 1, maximum: 1200 } },
    });
    expect((payload.messages as { role: string; content?: string }[])[0]).toMatchObject({ role: "system" });
    expect((payload.messages as { content?: string }[])[0]?.content).toContain("<core_rules>");
    expect(JSON.stringify(payload)).not.toContain("rawArguments");
  });
  it("rejects synthesized or dropped SDK history rather than accepting empty objects", () => {
    const a = makeAssistantRecord(2, "r", [{ id: "x", name: "read" }]);
    expect(() => prepareReplay({ messages: [a.message] })).toThrow(/Unpaired/);
    const replay = prepareReplay({
      messages: [
        a.message,
        { role: "toolResult", toolCallId: "x", toolName: "read", content: [], isError: false, timestamp: 1 },
      ],
    });
    expect(() => replay.onPayload({ messages: [] })).toThrow(/dropped/);
  });
  it("isolates raw arguments between network retries", async () => {
    const service = new ModelService(createConfiguredModels([model]), []);
    let count = 0;
    const result = await service.streamTurn({
      model,
      context: { messages: [] },
      sleep: async () => {},
      fetch: async () => {
        if (++count === 1)
          return new Response('{"error":{"message":"Internal Server Error"}}', { status: 500 });
        return response('{"path":"ok"}');
      },
    });
    expect(count).toBe(2);
    expect(result.toolCalls[0]?.rawArguments).toBe('{"path":"ok"}');
  });
});
