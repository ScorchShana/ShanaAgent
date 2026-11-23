import { createToolRegistry } from "../../src/tools/registry.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { ModelService } from "../../src/llm/model-service.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import { prepareReplay } from "../../src/llm/history-replay.js";
import { buildContext } from "../../src/core/context-builder.js";
import { resumeSession } from "../../src/sessions/recovery.js";
import type { SessionRecord } from "../../src/sessions/records.js";
import {
  cleanupTempDirs,
  makeAssistantRecord,
  makePngImage,
  makeStore,
  makeToolResultRecord,
  makeUserPromptRecord,
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
  it("replays a cancelled Turn end to end without rewriting Context or records", async () => {
    const records: SessionRecord[] = [
      makeUserPromptRecord(1, "run-1", "q"),
      makeAssistantRecord(2, "run-1", [{ id: "c1", name: "read" }], { stopReason: "aborted" }),
      makeToolResultRecord(3, "run-1", "c1", "not_executed"),
    ];
    const snapshot = JSON.stringify(records);
    const built = await buildContext({ records, workspacePath: tempDir() });
    built.context.tools = createToolRegistry()
      .list()
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    const stopReasonOf = (message: (typeof built.context.messages)[number]) =>
      message.role === "assistant" ? message.stopReason : undefined;
    const sent = prepareReplay(built.context).context.messages[1];
    expect(stopReasonOf(sent!)).toBe("toolUse");
    // 改写只作用于发送侧副本：Context 与记录恒存原文（锚定同一性与 I5）。
    expect(stopReasonOf(built.context.messages[1]!)).toBe("aborted");
    expect(JSON.stringify(records)).toBe(snapshot);

    // 发送侧不改写时，pi-ai 丢弃该 assistant 却保留其工具结果，回放自检必然命中。
    let payload: Record<string, unknown> = {};
    await new ModelService(createConfiguredModels([model]), []).streamTurn({
      model,
      context: built.context,
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return response(undefined, "stop");
      },
    });
    const wire = payload.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    const calls = wire.flatMap((message) => message.tool_calls ?? []);
    expect(calls).toHaveLength(1);
    expect(wire.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(
      calls.map((call) => call.id),
    );
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
  it("含图 toolResult 经 replay 校验后以 image_url 到达 wire，tool 消息保持纯文本", async () => {
    const vision: ResolvedModel = { ...model, input: ["text", "image"] };
    const image = makePngImage();
    const records = [
      makeUserPromptRecord(1, "r", "look"),
      makeAssistantRecord(2, "r", [{ id: "v1", name: "view_image", arguments: { path: "a.png" } }]),
      makeToolResultRecord(3, "r", "v1", "success", {
        toolName: "view_image",
        content: "(Image attached: image/png, 4x3, 33 bytes.)",
        images: [image],
      }),
    ];
    const built = await buildContext({ records, workspacePath: tempDir(), imageInput: true });
    let payload: Record<string, unknown> = {};
    await new ModelService(createConfiguredModels([vision]), []).streamTurn({
      model: vision,
      context: built.context,
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return response(undefined, "stop");
      },
    });
    const messages = payload.messages as {
      role: string;
      content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }[];
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(messages[3]!.content).toBe("(Image attached: image/png, 4x3, 33 bytes.)");
    expect(messages[4]!.content).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    ]);
  });
});
