import { createAgentSession } from "../../../src/core/agent-loop.js";
import type { ResolvedModel } from "../../../src/llm/model-config-store.js";
import type { TurnResult } from "../../../src/llm/model-service.js";
import { parseSettings } from "../../../src/llm/settings-store.js";
import type { StoredAssistantMessage } from "../../../src/sessions/records.js";
import {
  SessionStore,
  type AppendHookInfo,
  type SessionStoreHooks,
} from "../../../src/sessions/session-store.js";
import { makeAssistantMessage } from "../../sessions/helpers.js";

// 崩溃点 → 持久化边界：意图后(afterSync assistant_message)、执行后(beforeAppend tool_result)、结果后(afterSync tool_result)。
type CrashPoint = "after-intent" | "after-execute" | "after-result";

const [sessionsDir, workspaceId, sessionId, workspaceRoot, crashPointArg] = process.argv.slice(2);
if (!sessionsDir || !workspaceId || !sessionId || !workspaceRoot || !crashPointArg)
  throw new Error("Missing worker arguments");
const crashPoint = crashPointArg as CrashPoint;

const model: ResolvedModel = {
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
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  costUnknown: true,
};

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

// 真实子进程在持久化边界 abrupt 退出：内存态丢失，只有已 fsync 的记录留在磁盘。
const hooks: SessionStoreHooks = {
  afterSync(info: AppendHookInfo) {
    if (crashPoint === "after-intent" && info.type === "assistant_message") process.exit(0);
    if (crashPoint === "after-result" && info.type === "tool_result") process.exit(0);
  },
  beforeAppend(info: AppendHookInfo) {
    if (crashPoint === "after-execute" && info.type === "tool_result") process.exit(0);
  },
};

const store = new SessionStore({ sessionsDir, hooks });
const ref = { workspaceId, sessionId };

async function main(): Promise<void> {
  await store.createSession({ workspaceId, sessionId });
  const session = await createAgentSession({
    store,
    ref,
    workspaceId,
    workspaceRoot,
    getModel: () => model,
    getSettings: () => parseSettings({}),
    systemPrompt: "You are a test agent.",
    modelService: {
      streamTurn: async () =>
        turn(
          makeAssistantMessage([{ id: "call-1", name: "write", arguments: { path: "effect.txt", content: "written-once" } }]),
        ),
    },
  });
  session.controller.eventBus.subscribe((event) => {
    if (event.type === "permission.requested") session.controller.resolveApproval(event.approvalId, "once");
  });
  await session.controller.submitPrompt("write the effect file");
  // 三个崩溃点都在 Run 收尾前退出，正常不应到达这里。
  process.send?.("completed");
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exit(1);
});
