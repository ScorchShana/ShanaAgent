import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { ResolvedModel } from "../../src/llm/model-config-store.js";
import { ModelService } from "../../src/llm/model-service.js";
import { createConfiguredModels } from "../../src/llm/provider-adapter.js";
import { loadRealProviders, REAL_CONFIG_PATH } from "./real-config.js";
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

afterEach(cleanupTempDirs);
it.skipIf(process.env.SHANA_REAL_SESSION_V2 !== "1")(
  "real Session v2 raw replay after resume",
  async () => {
    const loaded = loadRealProviders();
    if (!loaded) throw new Error(`缺少 ${REAL_CONFIG_PATH}，无法做真实验证`);
    const report: object[] = [];
    let allPassed = true;
    try {
      for (const { model: baseModel } of loaded.entries) {
        const model: ResolvedModel = {
          ...baseModel,
          reasoning: true,
          thinking: true,
          reasoningEffort: "high",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          costUnknown: true,
        };
        const service = new ModelService(createConfiguredModels([model]), loaded.secrets);
        const { store } = makeStore();
        const ref = sessionRef("real-v2");
        await store.createSession({ workspaceId: WORKSPACE_ID, sessionId: ref.sessionId });
        await store.appendRecord(ref, {
          type: "user_prompt",
          runId: "seed",
          text: "Call read with path README.md.",
        });
        const seed = makeAssistantRecord(2, "seed", [{ id: "seed|broken+arguments", name: "read" }]);
        const block = seed.message.content.find((b) => b.type === "toolCall")!;
        if (block.type !== "toolCall") throw new Error("Invalid fixture");
        block.rawArguments = '{"path":"README.md';
        block.parse = { status: "invalid", error: "incomplete" };
        await store.appendRecord(ref, { type: "assistant_message", runId: "seed", message: seed.message });
        await store.appendRecord(ref, {
          type: "tool_result",
          runId: "seed",
          assistantRecordSeq: 2,
          toolCallId: block.id,
          toolName: "read",
          status: "error",
          content: "Error: Incomplete arguments JSON. Not executed. Resend complete JSON.",
        });
        await store.releaseSession(ref);
        const copy = await resumeSession(store, ref);
        const built = await buildContext({
          records: copy.records,
          workspacePath: tempDir(),
          currentPrompt: "Generate the corrected read call for README.md now.",
        });
        built.context.tools = [
          {
            name: "read",
            description: "Read a UTF-8 file.",
            parameters: Type.Object({ path: Type.String() }),
          },
        ];
        const requests: unknown[] = [];
        const fetchFn: typeof fetch = async (input, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return fetch(input, init);
        };
        let result;
        try {
          result = await service.streamTurn({
            model,
            context: built.context,
            maxRetries: 0,
            maxTokens: 2048,
            signal: AbortSignal.timeout(60000),
            fetch: fetchFn,
          });
        } catch (error) {
          allPassed = false;
          report.push({
            provider: model.providerId,
            model: model.id,
            passed: false,
            requests,
            error: service.redact(error instanceof Error ? error.message : String(error)),
          });
          continue;
        }
        const passed =
          result.stopReason !== "length" &&
          result.toolCalls.length === 1 &&
          result.toolCalls[0]?.name === "read" &&
          result.toolCalls[0]?.parse.status === "parsed" &&
          result.toolCalls[0].parse.arguments.path === "README.md";
        report.push({ provider: model.providerId, model: model.id, passed, requests, result });
        allPassed = allPassed && passed;
      }
    } finally {
      const output = path.resolve(".test-results/session-v2-real.json");
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(
        output,
        JSON.stringify({ timestamp: new Date().toISOString(), simulatedExecution: true, report }, null, 2),
      );
    }
    expect(report.length).toBeGreaterThan(0);
    expect(allPassed).toBe(true);
  },
  180000,
);
