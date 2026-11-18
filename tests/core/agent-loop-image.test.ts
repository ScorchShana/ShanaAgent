import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/agent-loop.js";
import { buildContext, IMAGE_OMITTED_TEXT } from "../../src/core/context-builder.js";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import type { StreamTurnOptions, TurnResult } from "../../src/llm/model-service.js";
import { parseSettings } from "../../src/llm/settings-store.js";
import type { StoredAssistantMessage, ToolResultRecord } from "../../src/sessions/records.js";
import {
  cleanupTempDirs,
  makeAssistantMessage,
  makeStore,
  sessionRef,
  tempDir,
  WORKSPACE_ID,
} from "../sessions/helpers.js";

afterEach(cleanupTempDirs);

const visionModel: ResolvedModel = {
  providerId: "p",
  providerName: "Test",
  id: "m",
  name: "Test",
  api: "openai-completions",
  baseUrl: "https://fake.test",
  apiKey: "synthetic-key",
  reasoning: false,
  thinking: false,
  reasoningEffort: "high",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};
// 同一模型身份、仅 input 能力不同：切换由 tools_changed 捕获回退纯估算。
const textModel: ResolvedModel = { ...visionModel, input: ["text"] };

function pngBytes(width = 4, height = 3): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

// 身份与 runModel 一致、usage 可信（input>0），供锚定路径使用。
function response(calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>, text = "ok") {
  const message = makeAssistantMessage(calls, text);
  message.provider = "p";
  message.model = "m";
  return message;
}

function turn(message: StoredAssistantMessage): TurnResult {
  return {
    attempts: 1,
    message,
    stopReason: message.stopReason,
    usage: message.usage,
    text: "",
    thinking: "",
    truncated: message.stopReason === "length",
    toolCalls: message.content.filter((block) => block.type === "toolCall"),
  };
}

async function imageFixture(script: Array<() => StoredAssistantMessage>) {
  const { store } = makeStore();
  const ref = sessionRef("image-loop");
  await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
  const workspaceRoot = tempDir();
  fs.writeFileSync(path.join(workspaceRoot, "a.png"), pngBytes());
  const requests: StreamTurnOptions[] = [];
  const anchorEvents: { anchored: boolean; reason: string | null }[] = [];
  let current = visionModel;
  let call = 0;
  const session = await createAgentSession({
    store,
    ref,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    getModel: () => current,
    getSettings: () => parseSettings({}),
    diagnostics: {
      debug: (line) => {
        const parsed = JSON.parse(line) as { event?: string; anchored?: boolean; reason?: string | null };
        if (parsed.event === "context.anchor") {
          anchorEvents.push({ anchored: parsed.anchored === true, reason: parsed.reason ?? null });
        }
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    modelService: {
      streamTurn: async (options) => {
        requests.push(options);
        const next = script[call];
        call += 1;
        if (!next) throw new Error("Unexpected extra model request");
        return turn(next());
      },
    },
  });
  return {
    ...session,
    store,
    ref,
    requests,
    anchorEvents,
    workspaceRoot,
    setModel: (next: ResolvedModel) => {
      current = next;
    },
  };
}

const stripTimestamp = (message: StreamTurnOptions["context"]["messages"][number]): string => {
  const { timestamp: _timestamp, ...rest } = message;
  return JSON.stringify(rest);
};

describe("AgentLoop view_image 集成", () => {
  it("含图 Run：落盘 images、Run 内消息与重建逐字段同构、七工具快照锚定", async () => {
    const f = await imageFixture([
      () => response([{ id: "c1", name: "view_image", arguments: { path: "a.png" } }]),
      () => response([], "done"),
      () => response([], "again done"),
    ]);
    await expect(f.controller.submitPrompt("look")).resolves.toBe("completed");

    const records = (await f.store.loadSession(f.ref)).records;
    const result = records.find((record) => record.type === "tool_result") as ToolResultRecord;
    const bytes = pngBytes();
    expect(result.images).toEqual([
      { data: bytes.toString("base64"), mimeType: "image/png", width: 4, height: 3 },
    ]);
    // 请求 tools 含 view_image（末位）；run_started 快照 input 含 image。
    expect(f.requests[0]!.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
      "view_image",
    ]);
    const started = records.find((record) => record.type === "run_started");
    expect(started?.type === "run_started" && started.model.input).toContain("image");

    // 第二次请求携带 Run 内构造的 toolResult：块序 {type,data,mimeType}。
    const sent = f.requests[1]!.context.messages;
    expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
    const toolResult = sent[2]!;
    if (toolResult.role !== "toolResult") throw new Error("expected toolResult");
    expect(toolResult.content[1]).toEqual({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
    expect(Object.keys(toolResult.content[1]!)).toEqual(["type", "data", "mimeType"]);

    // Run 内消息与记录重建逐字段同构（忽略 timestamp）——锚定前缀同一性的前提。
    const rebuilt = await buildContext({
      records,
      workspacePath: f.workspaceRoot,
      imageInput: true,
    });
    expect(rebuilt.context.messages.slice(0, sent.length).map(stripTimestamp)).toEqual(
      sent.map(stripTimestamp),
    );

    // 第二个 Run：七工具快照 + 含图前缀重建一致 → 锚定成功（不触发 prefix_mismatch/tools_changed）。
    await expect(f.controller.submitPrompt("again")).resolves.toBe("completed");
    expect(f.anchorEvents.at(-1)).toEqual({ anchored: true, reason: null });
  });

  it("视觉→文本→视觉切换：占位可逆、工具集随能力变化、锚定保守回退", async () => {
    const f = await imageFixture([
      () => response([{ id: "c1", name: "view_image", arguments: { path: "a.png" } }]),
      () => response([], "done"),
      () => response([], "text run"),
      () => response([], "vision again"),
    ]);
    await f.controller.submitPrompt("look");

    f.setModel(textModel);
    await expect(f.controller.submitPrompt("text only")).resolves.toBe("completed");
    const textRun = f.requests.at(-1)!.context;
    expect(textRun.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "glob",
      "grep",
      "write",
      "edit",
      "bash",
    ]);
    expect(JSON.stringify(textRun.messages)).not.toContain('"type":"image"');
    expect(JSON.stringify(textRun.messages)).toContain(IMAGE_OMITTED_TEXT);
    // 工具集变化 → 回退纯估算，不误用视觉 Run 的实测。
    expect(f.anchorEvents.at(-1)).toEqual({ anchored: false, reason: "tools_changed" });

    f.setModel(visionModel);
    await expect(f.controller.submitPrompt("vision again")).resolves.toBe("completed");
    const visionRun = f.requests.at(-1)!.context;
    expect(visionRun.tools?.map((tool) => tool.name).at(-1)).toBe("view_image");
    // 记录永久保留：切回后 image 块恢复。
    expect(JSON.stringify(visionRun.messages)).toContain('"type":"image"');
    expect(JSON.stringify(visionRun.messages)).not.toContain(IMAGE_OMITTED_TEXT);
    // 文本 Run 的实测前缀含占位而非 image，重建不可比 → 保守回退，下次响应重新锚定。
    expect(f.anchorEvents.at(-1)?.anchored).toBe(false);
  });

  it("非视觉 Run 幻觉调用 view_image → Unknown tool，不落 images", async () => {
    const f = await imageFixture([
      () => response([{ id: "c1", name: "view_image", arguments: { path: "a.png" } }]),
      () => response([], "done"),
    ]);
    f.setModel(textModel);
    await expect(f.controller.submitPrompt("look")).resolves.toBe("completed");
    const records = (await f.store.loadSession(f.ref)).records;
    const result = records.find((record) => record.type === "tool_result") as ToolResultRecord;
    expect(result.status).toBe("error");
    expect(result.content).toBe('Error: Unknown tool "view_image". Not executed.');
    expect(result.images).toBeUndefined();
    expect(JSON.stringify(f.requests[1]!.context.messages)).not.toContain('"type":"image"');
  });
});